import { createHash } from "node:crypto";
import { gatewayEventPayloadSchema, type GatewayEventPayload } from "@attendance/shared";
import { normalizeEventType } from "../event-mapping.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";

export type ProcessEventOptions = {
  source?: "realtime" | "offline" | "history" | "queue";
  skipQueue?: boolean;
  queueId?: string;
  recalculateAttendance?: boolean;
  updateCursor?: boolean;
};

type DeviceRow = {
  id: string;
  branch_id: string | null;
  name: string;
  protocol: "isup" | "isapi" | "hik_devicegateway" | "manual" | "mock";
  device_identifier: string | null;
  serial_number: string | null;
  metadata: Record<string, unknown>;
  dev_index?: string | null;
  status: "online" | "offline" | "error";
  company_id?: string | null;
};

type EmployeeRow = {
  id: string;
  branch_id: string | null;
  company_id: string;
  employee_code: string;
  full_name: string;
};

function eventHash(deviceId: string, payload: GatewayEventPayload) {
  const attendanceStatus = String(payload.payload?.attendanceStatus ?? payload.payload?.attendance_status ?? "").trim().toLowerCase();
  const basis = payload.external_event_id
    ? `${deviceId}:${payload.external_event_id}`
    : `${deviceId}:${payload.employee_external_id ?? ""}:${payload.occurred_at}:${payload.raw_event_type}:${attendanceStatus}`;

  return createHash("sha256").update(basis).digest("hex");
}

const attendanceRecalculationTimers = new Map<string, NodeJS.Timeout>();

async function findDevice(payload: GatewayEventPayload): Promise<DeviceRow> {
  const query = payload.device_identifier
    ? supabase.from("devices").select("*,branches:branch_id(company_id)").eq("device_identifier", payload.device_identifier).maybeSingle()
    : supabase.from("devices").select("*,branches:branch_id(company_id)").eq("serial_number", payload.serial_number).maybeSingle();

  const { data, error } = await query;
  if (error) throw error;
  if (!data) throw new Error("Device is not registered");
  const branch = Array.isArray(data.branches) ? data.branches[0] : data.branches;
  return { ...data, company_id: branch?.company_id ?? null } as DeviceRow;
}

async function findEmployee(deviceId: string, companyId: string | null, employeeNo?: string) {
  if (!employeeNo) return null;
  const linkRequest = supabase
    .from("employee_devices")
    .select("employees:employee_id(id,branch_id,company_id,employee_code,full_name)")
    .eq("device_id", deviceId)
    .eq("external_person_id", employeeNo)
    .maybeSingle();
  const externalRequest = companyId ? supabase.from("employees")
    .select("id,branch_id,company_id,employee_code,full_name")
    .eq("company_id", companyId).eq("external_employee_id", employeeNo).maybeSingle() : Promise.resolve({ data: null, error: null });
  const codeRequest = companyId ? supabase.from("employees")
    .select("id,branch_id,company_id,employee_code,full_name")
    .eq("company_id", companyId).eq("employee_code", employeeNo).maybeSingle() : Promise.resolve({ data: null, error: null });
  const [
    { data: link, error: linkError },
    { data: external, error: externalError },
    { data: byCode, error: codeError }
  ] = await Promise.all([linkRequest, externalRequest, codeRequest]);
  if (linkError) throw linkError;
  if (externalError) throw externalError;
  if (codeError) throw codeError;
  const linked = Array.isArray(link?.employees) ? link.employees[0] : link?.employees;
  if (linked?.id) return linked as EmployeeRow;
  if (!companyId) return null;
  if (external) return external as EmployeeRow;
  return (byCode as EmployeeRow | null) ?? null;
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
  const parsed = sanitizeGatewayPayload(gatewayEventPayloadSchema.parse(normalizeIncomingDate(payload)));
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
  const payload = sanitizeGatewayPayload(gatewayEventPayloadSchema.parse(normalizeIncomingDate(input)));
  let device: DeviceRow | null = null;
  let queueId = options.queueId;

  try {
    device = await findDevice(payload);
    const ingestionSource = options.source === "offline" || options.source === "history" ? "offline" : "realtime";
    if (!options.skipQueue && !queueId) {
      queueId = await createProcessingQueue(payload, device.id);
    }

    const companyId = device.company_id ?? null;
    const employee = await findEmployee(device.id, companyId, payload.employee_external_id);

    const hash = eventHash(device.id, payload);
    const eventType = normalizeEventType(payload.raw_event_type, payload.payload);

    let { data: rawEvent, error: rawError } = await supabase
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

    const rawDuplicated = rawError?.code === "23505";
    if (rawDuplicated) {
      const duplicateQuery = payload.external_event_id
        ? supabase.from("raw_access_events").select("*").eq("device_id", device.id).eq("external_event_id", payload.external_event_id).maybeSingle()
        : supabase.from("raw_access_events").select("*").eq("event_hash", hash).maybeSingle();
      const { data: existingRaw, error: duplicateError } = await duplicateQuery;
      if (duplicateError) throw duplicateError;
      rawEvent = existingRaw;
      rawError = null;
    }
    if (rawError) throw rawError;
    if (!rawEvent) throw new Error("Duplicate raw event could not be resolved");

    const local = guatemalaDateTime(payload.occurred_at);
    const major = optionalInteger(payload.payload?.major);
    const minor = optionalInteger(payload.payload?.minor);
    const attendanceStatus = optionalText(payload.payload?.attendanceStatus ?? payload.payload?.attendance_status);
    const personName = optionalText(payload.payload?.name ?? payload.payload?.personName ?? payload.payload?.person_name);
    const callbackReceivedAt = optionalTimestamp(payload.payload?.callback_received_at);
    const ingestedAt = new Date().toISOString();
    const normalizedEvent = {
      raw_event_id: rawEvent.id,
      employee_id: employee?.id ?? null,
      company_id: companyId,
      branch_id: device.branch_id,
      device_id: device.id,
      device_identifier: device.device_identifier ?? device.serial_number,
      dev_index: optionalText(device.dev_index),
      employee_no: payload.employee_external_id ?? null,
      employee_code: employee?.employee_code ?? null,
      person_name: personName ?? employee?.full_name ?? null,
      event_type: eventType,
      occurred_at: payload.occurred_at,
      event_time_utc: payload.occurred_at,
      event_time_local: local.dateTime,
      event_date_local: local.date,
      source: ingestionSource,
      raw_event_type: payload.raw_event_type,
      major,
      minor,
      attendance_status: attendanceStatus,
      raw_payload: payload.payload ?? {},
      synced_at: ingestedAt,
      callback_received_at: callbackReceivedAt,
      ingested_at: ingestedAt,
      source_seen: [ingestionSource],
      unique_key: hash,
      confidence: eventType === "unknown" ? 0.4 : 1
    };

    let inserted = false;
    let updated = false;
    const { data: insertedAttendance, error: attendanceError } = await supabase.from("attendance_events")
      .upsert(normalizedEvent, { onConflict: "unique_key", ignoreDuplicates: true })
      .select("id,employee_id,source,source_seen,callback_received_at,ingested_at")
      .maybeSingle();
    if (attendanceError) throw attendanceError;
    inserted = Boolean(insertedAttendance);

    let existingAttendance = insertedAttendance;
    if (!existingAttendance) {
      const { data, error } = await supabase.from("attendance_events")
        .select("id,employee_id,source,source_seen,callback_received_at,ingested_at")
        .eq("unique_key", hash).maybeSingle();
      if (error) throw error;
      existingAttendance = data;
    }
    if (!existingAttendance) throw new Error("Idempotent attendance event could not be resolved");

    const seen = new Set<string>(existingAttendance.source_seen ?? [existingAttendance.source]);
    const observedNewSource = !seen.has(ingestionSource);
    seen.add(ingestionSource);
    const resolvedEmployee = !existingAttendance.employee_id && Boolean(employee?.id);
    if (!inserted && (resolvedEmployee || observedNewSource || (!existingAttendance.callback_received_at && callbackReceivedAt))) {
      const { error: updateError } = await supabase.from("attendance_events").update({
        ...(resolvedEmployee ? normalizedEvent : {}),
        source: existingAttendance.source === "realtime" || ingestionSource === "realtime" ? "realtime" : ingestionSource,
        source_seen: [...seen],
        callback_received_at: existingAttendance.callback_received_at ?? callbackReceivedAt,
        ingested_at: existingAttendance.ingested_at,
        synced_at: ingestedAt
      }).eq("id", existingAttendance.id);
      if (updateError) throw updateError;
      updated = true;
    }

    if (ingestionSource === "realtime") scheduleRealtimeStateUpdate(device, payload, options);
    if (employee?.id && (inserted || updated) && options.recalculateAttendance !== false) {
      scheduleAttendanceRecalculation(employee.id, device.branch_id, local.date);
    }

    await markQueue(queueId, "success");
    return {
      inserted,
      updated,
      duplicated: rawDuplicated || (!inserted && !updated),
      raw_event_id: rawEvent.id,
      event_hash: hash,
      event_type: eventType,
      callback_received_at: callbackReceivedAt,
      ingested_at: insertedAttendance?.ingested_at ?? existingAttendance.ingested_at
    };
  } catch (error) {
    await markQueue(queueId, "failed", error instanceof Error ? error.message : String(error));
    await recordFailedEvent(payload, device?.id ?? null, error);
    logger.error({ err: error, deviceId: device?.id }, "Failed to process gateway event");
    throw error;
  }
}

function guatemalaDateTime(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, dateTime: `${date}T${parts.hour}:${parts.minute}:${parts.second}` };
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function optionalInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function optionalTimestamp(value: unknown) {
  const text = optionalText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function scheduleRealtimeStateUpdate(device: DeviceRow, payload: GatewayEventPayload, options: ProcessEventOptions) {
  const now = new Date().toISOString();
  const tasks = [
    supabase.from("devices").update({
      status: "online",
      status_reason: "event_received",
      last_seen_at: now
    }).eq("id", device.id),
    supabase.from("device_sync_state").upsert({
      device_id: device.id,
      last_realtime_event_at: payload.occurred_at,
      last_successful_event_at: payload.occurred_at,
      last_successful_external_event_id: payload.external_event_id ?? null,
      last_seen_at: now,
      is_online: true,
      sync_status: "idle",
      sync_error: null
    }, { onConflict: "device_id" })
  ];
  if (options.updateCursor !== false) {
    tasks.push(supabase.from("device_event_cursors").upsert({
      device_id: device.id,
      cursor_type: payload.external_event_id ? "external_event_id" : "timestamp",
      cursor_value: payload.external_event_id ?? payload.occurred_at,
      last_event_at: payload.occurred_at
    }, { onConflict: "device_id" }));
  }
  if (device.status !== "online") {
    tasks.push(supabase.from("device_status_logs").insert({
      device_id: device.id,
      status: "online",
      message: "Event received",
      metadata: { reason: "event_received", source: options.source ?? "realtime" }
    }));
  }
  void Promise.all(tasks).then((results) => {
    const failure = results.find((result) => result.error);
    if (failure?.error) logger.warn({ error: failure.error, deviceId: device.id }, "Realtime state update failed");
  }).catch((error) => logger.warn({ err: error, deviceId: device.id }, "Realtime state update failed"));
}

function scheduleAttendanceRecalculation(employeeId: string, branchId: string | null, date: string) {
  const key = `${employeeId}:${date}`;
  const pending = attendanceRecalculationTimers.get(key);
  if (pending) clearTimeout(pending);
  attendanceRecalculationTimers.set(key, setTimeout(() => {
    attendanceRecalculationTimers.delete(key);
    void supabase.functions.invoke("calculate-daily-attendance", {
      body: { date, employee_id: employeeId, branch_id: branchId ?? undefined }
    }).then(({ error }) => {
      if (error) logger.warn({ calculateError: error, employeeId, date }, "Attendance recalculation failed");
    }).catch((error) => logger.warn({ err: error, employeeId, date }, "Attendance recalculation failed"));
  }, 1_000));
}

function sanitizeGatewayPayload(payload: GatewayEventPayload): GatewayEventPayload {
  return { ...payload, payload: sanitizeObject(payload.payload ?? {}) as Record<string, unknown> };
}

function normalizeIncomingDate(input: unknown) {
  if (!input || typeof input !== "object") return input;
  const copy = { ...(input as Record<string, unknown>) };
  if (typeof copy.occurred_at === "string") {
    let value = copy.occurred_at.trim().replace(" ", "T");
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) value += "-06:00";
    const parsed = new Date(value);
    if (Number.isFinite(parsed.valueOf())) copy.occurred_at = parsed.toISOString();
  }
  return copy;
}

function sanitizeObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/finger|face|photo|picture|image|template|password|secret|ehomekey/i.test(key))
    .map(([key, item]) => [key, sanitizeObject(item)]));
}
