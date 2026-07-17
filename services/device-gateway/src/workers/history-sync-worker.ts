import { createAdapter } from "../adapters/factory.js";
import type { DeviceRecord } from "../adapters/DeviceAdapter.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { processGatewayEvent } from "../services/event-ingestion.js";
import { supabase } from "../supabase.js";

let running = false;

function lookbackStart() {
  return new Date(Date.now() - config.HISTORY_SYNC_LOOKBACK_HOURS * 60 * 60 * 1000);
}

export async function syncDeviceHistory(deviceId?: string) {
  let query = supabase
    .from("devices")
    .select("id, branch_id, name, protocol, device_identifier, serial_number, dev_index, metadata, status")
    .neq("protocol", "manual");

  if (deviceId) query = query.eq("id", deviceId);

  const { data: devices, error } = await query;
  if (error) throw error;

  for (const device of devices ?? []) {
    if (device.protocol === "hik_devicegateway" && !device.dev_index) continue;
    const runStart = new Date();
    const { data: state } = await supabase
      .from("device_sync_state")
      .select("*")
      .eq("device_id", device.id)
      .maybeSingle();

    const from = state?.last_successful_event_at ? new Date(state.last_successful_event_at) : lookbackStart();
    const to = new Date();

    await supabase.from("device_sync_state").upsert(
      {
        device_id: device.id,
        sync_status: "syncing",
        sync_error: null,
        last_history_sync_at: new Date().toISOString()
      },
      { onConflict: "device_id" }
    );

    let eventsFound = 0;
    let eventsInserted = 0;
    let eventsDuplicated = 0;
    let status: "success" | "failed" | "partial" = "success";
    let errorMessage: string | null = null;

    try {
      const adapter = createAdapter(device as DeviceRecord);
      await adapter.connect();
      const events = await adapter.fetchHistoricalEvents({ from, to });
      eventsFound = events.length;

      for (const event of events) {
        try {
          const result = await processGatewayEvent(event, { source: "history" });
          if (result.duplicated) eventsDuplicated += 1;
          if (result.inserted) eventsInserted += 1;
        } catch (eventError) {
          status = "partial";
          logger.warn({ err: eventError, deviceId: device.id }, "Historical event failed but sync will continue");
        }
      }
      await adapter.disconnect();
    } catch (syncError) {
      status = "failed";
      errorMessage = syncError instanceof Error ? syncError.message : String(syncError);
      logger.error({ err: syncError, deviceId: device.id }, "Historical sync failed");
    }

    await supabase.from("device_history_sync_runs").insert({
      device_id: device.id,
      started_at: runStart.toISOString(),
      finished_at: new Date().toISOString(),
      from_datetime: from.toISOString(),
      to_datetime: to.toISOString(),
      events_found: eventsFound,
      events_inserted: eventsInserted,
      events_duplicated: eventsDuplicated,
      status,
      error_message: errorMessage
    });

    await supabase.from("device_sync_state").upsert(
      {
        device_id: device.id,
        last_history_sync_at: new Date().toISOString(),
        sync_status: status === "failed" ? "failed" : "idle",
        sync_error: errorMessage
      },
      { onConflict: "device_id" }
    );
  }
}

export function startHistorySyncWorker() {
  void syncDeviceHistory().catch((error) => logger.error({ err: error }, "Startup history sync failed"));
  setInterval(() => {
    if (running) return;
    running = true;
    void syncDeviceHistory()
      .catch((error) => logger.error({ err: error }, "Periodic history sync failed"))
      .finally(() => {
        running = false;
      });
  }, config.HISTORY_SYNC_INTERVAL_SECONDS * 1000);
}
