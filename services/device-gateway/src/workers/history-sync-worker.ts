import type { GatewayEventPayload } from "@attendance/shared";
import { createAdapter } from "../adapters/factory.js";
import type { DeviceRecord } from "../adapters/DeviceAdapter.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { processHistoricalEventBatch } from "../services/event-ingestion.js";
import { supabase } from "../supabase.js";

let running = false;

type SyncTrigger = "scheduled" | "reconnect" | "api" | "command";

export type HistorySyncProgress = {
  type: "device_started" | "gateway_page" | "events_upserted" | "device_completed";
  at: string;
  device_id: string;
  device_index: number;
  devices_total: number;
  page?: number;
  position?: number;
  records?: number;
  phase?: "request" | "received";
  is_last?: boolean;
  result?: HistorySyncSummary;
};

export type HistorySyncSummary = {
  devices_scanned: number;
  events_found: number;
  events_inserted: number;
  events_updated: number;
  events_skipped: number;
  errors: Array<{ device_id: string; device_identifier: string | null; error: string }>;
  devices: Array<{
    device_id: string;
    device_name: string;
    device_identifier: string | null;
    events_found: number;
    events_inserted: number;
    events_updated: number;
    events_skipped: number;
    status: "success" | "partial" | "failed";
    error: string | null;
  }>;
};

function lookbackStart() {
  return new Date(Date.now() - config.HISTORY_SYNC_LOOKBACK_HOURS * 60 * 60 * 1000);
}

export function guatemalaDayRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must use YYYY-MM-DD");
  const from = new Date(`${date}T00:00:00-06:00`);
  const to = new Date(`${date}T23:59:59-06:00`);
  if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf())) throw new Error("Invalid Guatemala date");
  return { from, to };
}

export async function syncDeviceHistoryRange(input: {
  from: Date;
  to: Date;
  deviceIds?: string[];
  trigger?: SyncTrigger;
  traceId?: string;
  concurrency?: number;
  onProgress?: (progress: HistorySyncProgress) => void | Promise<void>;
}): Promise<HistorySyncSummary> {
  if (!Number.isFinite(input.from.valueOf()) || !Number.isFinite(input.to.valueOf()) || input.from > input.to) {
    throw new Error("A valid history range is required");
  }
  const devices = await loadDevices(input.deviceIds);
  const summary = emptySummary();
  let nextDevice = 0;
  const worker = async () => {
    while (nextDevice < devices.length) {
      const deviceIndex = nextDevice++;
      const device = devices[deviceIndex];
      const result = await syncOneDevice(device, input.from, input.to, input.trigger ?? "api", {
        traceId: input.traceId,
        deviceIndex,
        devicesTotal: devices.length,
        onProgress: input.onProgress
      });
      mergeSummary(summary, result);
    }
  };
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 2, devices.length || 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return summary;
}

export async function syncDeviceHistory(deviceId?: string) {
  const devices = await loadDevices(deviceId ? [deviceId] : undefined);
  const summary = emptySummary();
  for (const device of devices) {
    const { data: state } = await supabase.from("device_sync_state")
      .select("last_successful_event_at").eq("device_id", device.id).maybeSingle();
    const now = new Date();
    const candidate = state?.last_successful_event_at ? new Date(state.last_successful_event_at) : lookbackStart();
    const from = candidate <= now ? candidate : lookbackStart();
    const result = await syncOneDevice(device, from, now, deviceId ? "reconnect" : "scheduled", {
      deviceIndex: 0, devicesTotal: devices.length
    });
    mergeSummary(summary, result);
  }
  return summary;
}

async function loadDevices(deviceIds?: string[]) {
  let query = supabase.from("devices")
    .select("id,branch_id,name,protocol,device_identifier,serial_number,dev_index,metadata,status")
    .eq("protocol", "hik_devicegateway");
  if (deviceIds?.length) query = query.in("id", [...new Set(deviceIds)]);
  const { data, error } = await query.order("name");
  if (error) throw error;
  return (data ?? []).filter((device) => Boolean(device.dev_index)) as Array<DeviceRecord & { status?: string }>;
}

async function syncOneDevice(
  device: DeviceRecord,
  from: Date,
  to: Date,
  trigger: SyncTrigger,
  context: {
    traceId?: string;
    deviceIndex: number;
    devicesTotal: number;
    onProgress?: (progress: HistorySyncProgress) => void | Promise<void>;
  }
): Promise<HistorySyncSummary> {
  const startedAt = new Date();
  const result = emptySummary();
  result.devices_scanned = 1;
  let status: "success" | "partial" | "failed" = "success";
  let errorMessage: string | null = null;
  let eventErrors = 0;
  const timings: Record<string, string> = { started_at: startedAt.toISOString() };

  await context.onProgress?.({
    type: "device_started", at: startedAt.toISOString(), device_id: device.id,
    device_index: context.deviceIndex, devices_total: context.devicesTotal
  });

  await supabase.from("device_sync_state").upsert({
    device_id: device.id,
    sync_status: "syncing",
    sync_error: null,
    last_history_sync_at: startedAt.toISOString()
  }, { onConflict: "device_id" });

  let adapter: ReturnType<typeof createAdapter> | null = null;
  try {
    adapter = createAdapter(device);
    await adapter.connect();
    const events = await adapter.fetchHistoricalEvents({
      from, to, traceId: context.traceId,
      onPage: async (page) => {
        if (page.phase === "request" && page.page === 1) timings.first_gateway_request_at = page.at;
        if (page.phase === "received" && page.page === 1) timings.first_gateway_page_at = page.at;
        if (page.phase === "received" && page.isLast) timings.last_gateway_page_at = page.at;
        await context.onProgress?.({
          type: "gateway_page", at: page.at, device_id: device.id,
          device_index: context.deviceIndex, devices_total: context.devicesTotal,
          page: page.page, position: page.position, records: page.records,
          phase: page.phase, is_last: page.isLast
        });
      }
    });
    result.events_found = events.length;

    const candidates = events.filter(isAttendanceCandidate);
    result.events_skipped += events.length - candidates.length;
    for (let index = 0; index < candidates.length; index += 200) {
      const batch = candidates.slice(index, index + 200);
      try {
        const ingested = await processHistoricalEventBatch(batch);
        result.events_inserted += ingested.inserted;
        result.events_updated += ingested.updated;
        result.events_skipped += ingested.skipped;
      } catch (error) {
        eventErrors += batch.length;
        status = "partial";
        logger.warn({ err: error, deviceId: device.id, batchSize: batch.length }, "Historical attendance batch failed");
      }
    }
    timings.events_upserted_at = new Date().toISOString();
    await context.onProgress?.({
      type: "events_upserted", at: timings.events_upserted_at, device_id: device.id,
      device_index: context.deviceIndex, devices_total: context.devicesTotal
    });
    if (eventErrors > 0) errorMessage = `${eventErrors} event(s) failed normalization or storage`;
  } catch (error) {
    status = "failed";
    errorMessage = sanitizeError(error);
    logger.error({ err: error, deviceId: device.id }, "Historical sync failed");
  } finally {
    if (adapter) await adapter.disconnect().catch((error) => {
      logger.warn({ err: error, deviceId: device.id }, "Historical adapter disconnect failed");
    });
  }

  await supabase.from("device_history_sync_runs").insert({
    device_id: device.id,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    from_datetime: from.toISOString(),
    to_datetime: to.toISOString(),
    events_found: result.events_found,
    events_inserted: result.events_inserted,
    events_duplicated: result.events_skipped,
    status,
    error_message: errorMessage,
    metadata: { trigger, trace_id: context.traceId, timings, events_updated: result.events_updated, event_errors: eventErrors }
  });

  await supabase.from("device_sync_state").upsert({
    device_id: device.id,
    last_history_sync_at: new Date().toISOString(),
    sync_status: status === "failed" ? "failed" : "idle",
    sync_error: errorMessage
  }, { onConflict: "device_id" });

  const deviceResult = {
    device_id: device.id,
    device_name: device.name,
    device_identifier: device.device_identifier ?? null,
    events_found: result.events_found,
    events_inserted: result.events_inserted,
    events_updated: result.events_updated,
    events_skipped: result.events_skipped,
    status,
    error: errorMessage
  };
  result.devices.push(deviceResult);
  if (errorMessage) result.errors.push({
    device_id: device.id,
    device_identifier: device.device_identifier ?? null,
    error: errorMessage
  });
  await context.onProgress?.({
    type: "device_completed", at: new Date().toISOString(), device_id: device.id,
    device_index: context.deviceIndex, devices_total: context.devicesTotal, result
  });
  return result;
}

function isAttendanceCandidate(event: GatewayEventPayload) {
  const raw = event.payload ?? {};
  return Boolean(
    event.employee_external_id || raw.employeeNoString || raw.employeeNo ||
    raw.attendanceStatus || raw.attendance_status
  );
}

function emptySummary(): HistorySyncSummary {
  return {
    devices_scanned: 0,
    events_found: 0,
    events_inserted: 0,
    events_updated: 0,
    events_skipped: 0,
    errors: [],
    devices: []
  };
}

function mergeSummary(target: HistorySyncSummary, source: HistorySyncSummary) {
  target.devices_scanned += source.devices_scanned;
  target.events_found += source.events_found;
  target.events_inserted += source.events_inserted;
  target.events_updated += source.events_updated;
  target.events_skipped += source.events_skipped;
  target.errors.push(...source.errors);
  target.devices.push(...source.devices);
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}

export function startHistorySyncWorker() {
  void syncDeviceHistory().catch((error) => logger.error({ err: error }, "Startup history sync failed"));
  setInterval(() => {
    if (running) return;
    running = true;
    void syncDeviceHistory()
      .catch((error) => logger.error({ err: error }, "Periodic history sync failed"))
      .finally(() => { running = false; });
  }, config.HISTORY_SYNC_INTERVAL_SECONDS * 1000);
}
