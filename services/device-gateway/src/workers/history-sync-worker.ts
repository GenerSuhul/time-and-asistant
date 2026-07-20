import type { GatewayEventPayload } from "@attendance/shared";
import { createAdapter } from "../adapters/factory.js";
import type { DeviceRecord } from "../adapters/DeviceAdapter.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { processGatewayEvent } from "../services/event-ingestion.js";
import { supabase } from "../supabase.js";

let running = false;

type SyncTrigger = "scheduled" | "reconnect" | "api" | "command";

export type HistorySyncSummary = {
  devices_scanned: number;
  events_found: number;
  events_inserted: number;
  events_updated: number;
  events_skipped: number;
  errors: Array<{ device_id: string; device_identifier: string | null; error: string }>;
  devices: Array<{
    device_id: string;
    device_identifier: string | null;
    events_found: number;
    events_inserted: number;
    events_updated: number;
    events_skipped: number;
    status: "success" | "partial" | "failed";
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
}): Promise<HistorySyncSummary> {
  if (!Number.isFinite(input.from.valueOf()) || !Number.isFinite(input.to.valueOf()) || input.from > input.to) {
    throw new Error("A valid history range is required");
  }
  const devices = await loadDevices(input.deviceIds);
  const summary = emptySummary();
  for (const device of devices) {
    const result = await syncOneDevice(device, input.from, input.to, input.trigger ?? "api");
    mergeSummary(summary, result);
  }
  return summary;
}

export async function syncDeviceHistory(deviceId?: string) {
  const devices = await loadDevices(deviceId ? [deviceId] : undefined);
  const summary = emptySummary();
  for (const device of devices) {
    const { data: state } = await supabase.from("device_sync_state")
      .select("last_successful_event_at").eq("device_id", device.id).maybeSingle();
    const from = state?.last_successful_event_at ? new Date(state.last_successful_event_at) : lookbackStart();
    const result = await syncOneDevice(device, from, new Date(), deviceId ? "reconnect" : "scheduled");
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
  trigger: SyncTrigger
): Promise<HistorySyncSummary> {
  const startedAt = new Date();
  const result = emptySummary();
  result.devices_scanned = 1;
  let status: "success" | "partial" | "failed" = "success";
  let errorMessage: string | null = null;
  let eventErrors = 0;

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
    const events = await adapter.fetchHistoricalEvents({ from, to });
    result.events_found = events.length;

    for (const event of events) {
      if (!isAttendanceCandidate(event)) {
        result.events_skipped += 1;
        continue;
      }
      try {
        const ingested = await processGatewayEvent(event, {
          source: "offline",
          skipQueue: true,
          recalculateAttendance: false,
          updateCursor: false
        });
        if (ingested.inserted) result.events_inserted += 1;
        else if (ingested.updated) result.events_updated += 1;
        else result.events_skipped += 1;
      } catch (error) {
        eventErrors += 1;
        status = "partial";
        logger.warn({ err: error, deviceId: device.id }, "Historical attendance event failed");
      }
    }
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
    metadata: { trigger, events_updated: result.events_updated, event_errors: eventErrors }
  });

  await supabase.from("device_sync_state").upsert({
    device_id: device.id,
    last_history_sync_at: new Date().toISOString(),
    sync_status: status === "failed" ? "failed" : "idle",
    sync_error: errorMessage
  }, { onConflict: "device_id" });

  const deviceResult = {
    device_id: device.id,
    device_identifier: device.device_identifier ?? null,
    events_found: result.events_found,
    events_inserted: result.events_inserted,
    events_updated: result.events_updated,
    events_skipped: result.events_skipped,
    status
  };
  result.devices.push(deviceResult);
  if (errorMessage) result.errors.push({
    device_id: device.id,
    device_identifier: device.device_identifier ?? null,
    error: errorMessage
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
