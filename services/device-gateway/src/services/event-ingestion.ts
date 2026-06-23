import { createHash } from "node:crypto";
import { gatewayEventPayloadSchema, type GatewayEventPayload } from "@attendance/shared";
import { normalizeEventType } from "../event-mapping.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";

export type ProcessEventOptions = {
  source?: "realtime" | "history" | "queue";
  skipQueue?: boolean;
  queueId?: string;
};

type DeviceRow = {
  id: string;
  branch_id: string | null;
  name: string;
  protocol: "isup" | "isapi" | "manual" | "mock";
  device_identifier: string | null;
  serial_number: string | null;
  metadata: Record<string, unknown>;
};

function eventHash(deviceId: string, payload: GatewayEventPayload) {
  const basis = payload.external_event_id
    ? `${deviceId}:${payload.external_event_id}`
    : `${deviceId}:${payload.employee_external_id ?? ""}:${payload.occurred_at}:${payload.raw_event_type}`;

  return createHash("sha256").update(basis).digest("hex");
}

async function findDevice(payload: GatewayEventPayload): Promise<DeviceRow> {
  const query = payload.device_identifier
    ? supabase.from("devices").select("*").eq("device_identifier", payload.device_identifier).maybeSingle()
    : supabase.from("devices").select("*").eq("serial_number", payload.serial_number).maybeSingle();

  const { data, error } = await query;
  if (error) throw error;
  if (!data) throw new Error("Device is not registered");
  return data as DeviceRow;
}

async function createProcessingQueue(payload: GatewayEventPayload, deviceId?: string) {
  const { data, error } = await supabase
    .from("event_ingestion_queue")
    .insert({ device_id: deviceId ?? null, payload, status: "processing" })
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

async function markQueue(queueId: string | undefined, status: "success" | "failed", errorMessage?: string) {
  if (!queueId) return;
  await supabase
    .from("event_ingestion_queue")
    .update({ status, error_message: errorMessage ?? null })
    .eq("id", queueId);
}

async function recordFailedEvent(payload: GatewayEventPayload, deviceId: string | null, error: unknown) {
  await supabase.from("failed_event_ingestions").insert({
    device_id: deviceId,
    payload,
    error_message: error instanceof Error ? error.message : String(error)
  });
}

export async function enqueueEvent(payload: unknown) {
  const parsed = gatewayEventPayloadSchema.parse(payload);
  const device = await findDevice(parsed);
  const { data, error } = await supabase
    .from("event_ingestion_queue")
    .insert({ device_id: device.id, payload: parsed, status: "pending" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function processGatewayEvent(input: unknown, options: ProcessEventOptions = {}) {
  const payload = gatewayEventPayloadSchema.parse(input);
  let device: DeviceRow | null = null;
  let queueId = options.queueId;

  try {
    device = await findDevice(payload);
    if (!options.skipQueue && !queueId) {
      queueId = await createProcessingQueue(payload, device.id);
    }

    await supabase
      .from("devices")
      .update({
        status: "online",
        last_seen_at: new Date().toISOString()
      })
      .eq("id", device.id);

    const { data: employee, error: employeeError } = payload.employee_external_id
      ? await supabase
          .from("employees")
          .select("id, branch_id")
          .eq("external_employee_id", payload.employee_external_id)
          .maybeSingle()
      : { data: null, error: null };
    if (employeeError) throw employeeError;

    const hash = eventHash(device.id, payload);
    const eventType = normalizeEventType(payload.raw_event_type, payload.payload);

    const { data: rawEvent, error: rawError } = await supabase
      .from("raw_access_events")
      .insert({
        device_id: device.id,
        branch_id: device.branch_id,
        external_event_id: payload.external_event_id ?? null,
        employee_external_id: payload.employee_external_id ?? null,
        employee_id: employee?.id ?? null,
        occurred_at: payload.occurred_at,
        raw_event_type: payload.raw_event_type,
        raw_payload: payload.payload ?? {},
        auth_method: payload.auth_method ?? "unknown",
        access_result: payload.access_result ?? "unknown",
        event_hash: hash
      })
      .select("*")
      .single();

    if (rawError?.code === "23505") {
      await markQueue(queueId, "success");
      return { duplicated: true, event_hash: hash };
    }
    if (rawError) throw rawError;

    if (employee?.id) {
      const { error: attendanceError } = await supabase.from("attendance_events").insert({
        raw_event_id: rawEvent.id,
        employee_id: employee.id,
        branch_id: device.branch_id,
        device_id: device.id,
        event_type: eventType,
        occurred_at: payload.occurred_at,
        source: "device",
        confidence: eventType === "unknown" ? 0.4 : 1
      });

      if (attendanceError?.code !== "23505" && attendanceError) throw attendanceError;

      const date = payload.occurred_at.slice(0, 10);
      const { error: calculateError } = await supabase.functions.invoke("calculate-daily-attendance", {
        body: {
          date,
          employee_id: employee.id,
          branch_id: device.branch_id ?? undefined
        }
      });
      if (calculateError) logger.warn({ calculateError, employeeId: employee.id, date }, "Attendance recalculation failed");
    }

    await supabase.from("device_sync_state").upsert(
      {
        device_id: device.id,
        last_realtime_event_at: options.source === "history" ? undefined : payload.occurred_at,
        last_successful_event_at: payload.occurred_at,
        last_successful_external_event_id: payload.external_event_id ?? null,
        last_seen_at: new Date().toISOString(),
        is_online: true,
        sync_status: "idle",
        sync_error: null
      },
      { onConflict: "device_id" }
    );

    await supabase.from("device_event_cursors").upsert(
      {
        device_id: device.id,
        cursor_type: payload.external_event_id ? "external_event_id" : "timestamp",
        cursor_value: payload.external_event_id ?? payload.occurred_at,
        last_event_at: payload.occurred_at
      },
      { onConflict: "device_id" }
    );

    await markQueue(queueId, "success");
    return { inserted: true, raw_event_id: rawEvent.id, event_hash: hash, event_type: eventType };
  } catch (error) {
    await markQueue(queueId, "failed", error instanceof Error ? error.message : String(error));
    await recordFailedEvent(payload, device?.id ?? null, error);
    logger.error({ err: error, deviceId: device?.id }, "Failed to process gateway event");
    throw error;
  }
}
