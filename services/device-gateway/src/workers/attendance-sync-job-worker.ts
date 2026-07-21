import { logger } from "../logger.js";
import { supabase } from "../supabase.js";
import { guatemalaDayRange, syncDeviceHistoryRange, type HistorySyncProgress } from "./history-sync-worker.js";

type AttendanceSyncJob = {
  id: string;
  date: string;
  trace_id: string;
  device_ids: string[];
  company_ids: string[];
  devices_total: number;
  client_clicked_at: string | null;
  edge_received_at: string;
  queued_at: string;
};

let running = false;
let wakeRequested = false;

export async function runAttendanceSyncJobWorkerOnce() {
  if (running) {
    wakeRequested = true;
    return;
  }
  running = true;
  try {
    do {
      wakeRequested = false;
      const { data: pending, error } = await supabase.from("attendance_sync_jobs")
        .select("*").eq("status", "pending")
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      if (error) throw error;
      if (!pending) break;
      await processJob(pending as AttendanceSyncJob);
      wakeRequested = true;
    } while (wakeRequested);
  } finally {
    running = false;
  }
}

async function processJob(job: AttendanceSyncJob) {
  const workerDetectedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase.from("attendance_sync_jobs").update({
    status: "processing",
    stage: "starting",
    progress: 1,
    worker_detected_at: workerDetectedAt,
    started_at: workerDetectedAt
  }).eq("id", job.id).eq("status", "pending").select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return;

  logger.info({
    event: "attendance_sync_job_detected", traceId: job.trace_id, jobId: job.id,
    queuedAt: job.queued_at, workerDetectedAt,
    queueLatencyMs: differenceMs(job.queued_at, workerDetectedAt)
  }, "Attendance sync job detected");

  const state = {
    devicesDone: 0,
    eventsFound: 0,
    eventsInserted: 0,
    eventsSkipped: 0,
    firstGatewayRequestAt: null as string | null,
    firstGatewayPageAt: null as string | null,
    lastGatewayPageAt: null as string | null
  };

  try {
    const range = guatemalaDayRange(job.date);
    const summary = await syncDeviceHistoryRange({
      ...range,
      deviceIds: job.device_ids,
      trigger: "command",
      traceId: job.trace_id,
      concurrency: 2,
      onProgress: (progress) => updateProgress(job, state, progress)
    });

    const eventsUpsertedAt = new Date().toISOString();
    const calculationStartedAt = new Date().toISOString();
    await updateJob(job.id, {
      status: "calculating",
      stage: "calculating_report",
      progress: 90,
      devices_done: state.devicesDone,
      events_found: summary.events_found,
      events_inserted: summary.events_inserted,
      events_skipped: summary.events_skipped,
      events_upserted_at: eventsUpsertedAt,
      calculation_started_at: calculationStartedAt
    });

    await Promise.all(job.company_ids.map(async (companyId) => {
      const { error } = await supabase.functions.invoke("calculate-daily-attendance", {
        body: { date: job.date, company_id: companyId }
      });
      if (error) throw error;
    }));

    const calculationFinishedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const allFailed = summary.devices.length > 0 && summary.devices.every((device) => device.status === "failed");
    const status = allFailed ? "failed" : summary.errors.length > 0 ? "partial" : "complete";
    const timing = {
      client_to_edge_ms: differenceMs(job.client_clicked_at, job.edge_received_at),
      edge_to_queue_ms: differenceMs(job.edge_received_at, job.queued_at),
      queue_to_worker_ms: differenceMs(job.queued_at, workerDetectedAt),
      worker_to_gateway_ms: differenceMs(workerDetectedAt, state.firstGatewayRequestAt),
      gateway_first_page_ms: differenceMs(state.firstGatewayRequestAt, state.firstGatewayPageAt),
      gateway_pagination_ms: differenceMs(state.firstGatewayPageAt, state.lastGatewayPageAt),
      events_upsert_ms: differenceMs(state.lastGatewayPageAt, eventsUpsertedAt),
      calculation_ms: differenceMs(calculationStartedAt, calculationFinishedAt),
      total_background_ms: differenceMs(job.queued_at, finishedAt),
      total_click_to_complete_ms: differenceMs(job.client_clicked_at, finishedAt)
    };
    await updateJob(job.id, {
      status,
      stage: status === "failed" ? "failed" : "updated",
      progress: 100,
      devices_done: state.devicesDone,
      events_found: summary.events_found,
      events_inserted: summary.events_inserted,
      events_skipped: summary.events_skipped,
      error_message: summary.errors.length ? sanitizeError(summary.errors.map((item) => item.error).join("; ")) : null,
      events_upserted_at: eventsUpsertedAt,
      calculation_started_at: calculationStartedAt,
      calculation_finished_at: calculationFinishedAt,
      finished_at: finishedAt,
      realtime_published_at: finishedAt,
      timing
    });
    logger.info({
      event: "attendance_sync_job_complete", traceId: job.trace_id, jobId: job.id,
      status, timing, eventsFound: summary.events_found,
      eventsInserted: summary.events_inserted, eventsSkipped: summary.events_skipped
    }, "Attendance sync job completed");
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      progress: 100,
      error_message: sanitizeError(error),
      finished_at: finishedAt,
      realtime_published_at: finishedAt
    });
    logger.error({ err: error, traceId: job.trace_id, jobId: job.id }, "Attendance sync job failed");
  }
}

async function updateProgress(job: AttendanceSyncJob, state: {
  devicesDone: number;
  eventsFound: number;
  eventsInserted: number;
  eventsSkipped: number;
  firstGatewayRequestAt: string | null;
  firstGatewayPageAt: string | null;
  lastGatewayPageAt: string | null;
}, progress: HistorySyncProgress) {
  const update: Record<string, unknown> = {};
  if (progress.type === "device_started") {
    update.stage = `consulting_device_${progress.device_index + 1}_of_${progress.devices_total}`;
    update.progress = Math.max(2, Math.round((state.devicesDone / Math.max(1, progress.devices_total)) * 80));
  } else if (progress.type === "gateway_page") {
    if (progress.phase === "request" && !state.firstGatewayRequestAt) {
      state.firstGatewayRequestAt = progress.at;
      update.first_gateway_request_at = progress.at;
    }
    if (progress.phase === "received" && !state.firstGatewayPageAt) {
      state.firstGatewayPageAt = progress.at;
      update.first_gateway_page_at = progress.at;
    }
    if (progress.phase === "received" && progress.is_last) {
      state.lastGatewayPageAt = later(state.lastGatewayPageAt, progress.at);
      update.last_gateway_page_at = state.lastGatewayPageAt;
    }
  } else if (progress.type === "device_completed" && progress.result) {
    state.devicesDone += progress.result.devices_scanned;
    state.eventsFound += progress.result.events_found;
    state.eventsInserted += progress.result.events_inserted;
    state.eventsSkipped += progress.result.events_skipped;
    update.devices_done = state.devicesDone;
    update.events_found = state.eventsFound;
    update.events_inserted = state.eventsInserted;
    update.events_skipped = state.eventsSkipped;
    update.progress = Math.min(85, Math.round((state.devicesDone / Math.max(1, job.devices_total)) * 85));
    update.stage = state.devicesDone >= job.devices_total ? "persisting_events" : `consulting_device_${state.devicesDone + 1}_of_${job.devices_total}`;
  }
  if (Object.keys(update).length > 0) await updateJob(job.id, update);
}

async function updateJob(id: string, values: Record<string, unknown>) {
  const { error } = await supabase.from("attendance_sync_jobs").update(values).eq("id", id);
  if (error) throw error;
}

function differenceMs(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return null;
  const value = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function later(current: string | null, candidate: string) {
  return !current || new Date(candidate) > new Date(current) ? candidate : current;
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}

export function startAttendanceSyncJobWorker() {
  const wake = () => void runAttendanceSyncJobWorkerOnce()
    .catch((error) => logger.error({ err: error }, "Attendance sync job worker failed"));
  supabase.channel("attendance-sync-jobs-worker")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "attendance_sync_jobs" }, wake)
    .subscribe((status) => logger.info({ status }, "Attendance sync Realtime channel state"));
  wake();
  setInterval(wake, 1_000);
}
