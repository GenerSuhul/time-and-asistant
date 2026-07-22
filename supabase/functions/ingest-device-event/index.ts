import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";

const schema = z.object({
  device_identifier: z.string().optional(),
  serial_number: z.string().optional(),
  external_event_id: z.string().optional(),
  employee_external_id: z.string().optional(),
  occurred_at: z.string().datetime(),
  raw_event_type: z.string(),
  auth_method: z.enum(["fingerprint", "face", "card", "pin", "unknown"]).default("unknown"),
  access_result: z.enum(["granted", "denied", "unknown"]).default("unknown"),
  event_type: z.enum(["check_in", "lunch_out", "lunch_in", "check_out", "break_out", "break_in", "unknown"]).default("unknown"),
  payload: z.record(z.unknown()).default({})
}).refine((value) => value.device_identifier || value.serial_number, {
  message: "device_identifier or serial_number is required"
});

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeJsonParse(value: string) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return { unparseable: true };
  }
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const expectedSecret = Deno.env.get("GATEWAY_API_SECRET");
  if (!expectedSecret || req.headers.get("x-gateway-secret") !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized gateway" }, 401);
  }

  const supabase = serviceClient();
  const rawBody = await req.text();
  const safeBody = sanitizeObject(safeJsonParse(rawBody));

  try {
    const payload = schema.parse(safeBody);
    payload.payload = sanitizeObject(payload.payload) as Record<string, unknown>;

    const deviceQuery = payload.device_identifier
      ? supabase.from("devices").select("*").eq("device_identifier", payload.device_identifier).maybeSingle()
      : supabase.from("devices").select("*").eq("serial_number", payload.serial_number).maybeSingle();

    const { data: device, error: deviceError } = await deviceQuery;
    if (deviceError) throw deviceError;
    if (!device) return jsonResponse({ error: "Device not registered" }, 404);

    const [{ data: branch }, { data: assignedBranches, error: assignedError }] = await Promise.all([
      device.branch_id
        ? supabase.from("branches").select("company_id").eq("id", device.branch_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("device_branches").select("branch_id").eq("device_id", device.id)
    ]);
    if (assignedError) throw assignedError;
    const companyId = branch?.company_id ?? null;

    let employee = null;
    if (payload.employee_external_id && companyId) {
      const { data: link, error: linkError } = await supabase.from("employee_devices")
        .select("employees:employee_id(id,branch_id,employee_code,full_name)")
        .eq("device_id", device.id).eq("external_person_id", payload.employee_external_id).maybeSingle();
      if (linkError) throw linkError;
      employee = relation(link?.employees);
      if (!employee) {
        const { data, error } = await supabase.from("employees")
          .select("id,branch_id,employee_code,full_name")
          .eq("company_id", companyId).eq("hikvision_employee_no", payload.employee_external_id).maybeSingle();
        if (error) throw error;
        employee = data;
      }
      if (!employee) {
        const { data, error } = await supabase.from("employees")
          .select("id,branch_id,employee_code,full_name")
          .eq("company_id", companyId).eq("external_employee_id", payload.employee_external_id).maybeSingle();
        if (error) throw error;
        employee = data;
      }
    }
    const assignedBranchIds = new Set((assignedBranches ?? []).map((item: any) => item.branch_id));
    const eventBranchId = employee?.branch_id && assignedBranchIds.has(employee.branch_id)
      ? employee.branch_id
      : device.branch_id;

    const eventHash = await sha256(
      payload.external_event_id
        ? `${device.id}:${payload.external_event_id}`
        : `${device.id}:${payload.employee_external_id ?? ""}:${payload.occurred_at}:${payload.raw_event_type}:${String(payload.payload.attendanceStatus ?? payload.payload.attendance_status ?? "").trim().toLowerCase()}`
    );

    const { data: rawEvent, error: rawError } = await supabase
      .from("raw_access_events")
      .upsert(
        {
          device_id: device.id,
          branch_id: eventBranchId,
          external_event_id: payload.external_event_id ?? null,
          employee_external_id: payload.employee_external_id ?? null,
          employee_id: employee?.id ?? null,
          occurred_at: payload.occurred_at,
          raw_event_type: payload.raw_event_type,
          raw_payload: payload.payload,
          auth_method: payload.auth_method,
          access_result: payload.access_result,
          event_hash: eventHash
        },
        { onConflict: "event_hash", ignoreDuplicates: true }
      )
      .select("*")
      .maybeSingle();
    if (rawError) throw rawError;

    if (!rawEvent) {
      return jsonResponse({ duplicated: true, event_hash: eventHash });
    }

    const local = guatemalaDateTime(payload.occurred_at);
    const eventType = normalizeEventType(payload.event_type, payload.payload);
    const ingestedAt = new Date().toISOString();
    const callbackReceivedAt = optionalTimestamp(payload.payload.callback_received_at);
    const { error: eventError } = await supabase.from("attendance_events").insert({
      raw_event_id: rawEvent.id,
      employee_id: employee?.id ?? null,
      company_id: companyId,
      branch_id: eventBranchId,
      device_id: device.id,
      device_identifier: device.device_identifier ?? device.serial_number,
      dev_index: device.dev_index ?? null,
      employee_no: payload.employee_external_id ?? null,
      employee_code: employee?.employee_code ?? null,
      person_name: payload.payload.name ?? employee?.full_name ?? null,
      event_type: eventType,
      occurred_at: payload.occurred_at,
      event_time_utc: payload.occurred_at,
      event_time_local: local.dateTime,
      event_date_local: local.date,
      source: "realtime",
      raw_event_type: payload.raw_event_type,
      major: optionalInteger(payload.payload.major),
      minor: optionalInteger(payload.payload.minor),
      attendance_status: payload.payload.attendanceStatus ?? payload.payload.attendance_status ?? null,
      raw_payload: payload.payload,
      synced_at: ingestedAt,
      callback_received_at: callbackReceivedAt,
      ingested_at: ingestedAt,
      source_seen: ["realtime"],
      unique_key: eventHash,
      confidence: eventType === "unknown" ? 0.4 : 1.0
    });
    if (eventError && eventError.code !== "23505") throw eventError;

    const background = Promise.all([
      employee?.id ? calculateAttendanceForDate(supabase, {
        date: local.date,
        employee_id: employee.id,
        branch_id: eventBranchId ?? undefined
      }) : Promise.resolve(),
      supabase.from("devices").update({ status: "online", last_seen_at: ingestedAt }).eq("id", device.id),
      supabase.from("device_sync_state").upsert(
        {
          device_id: device.id,
          last_realtime_event_at: payload.occurred_at,
          last_successful_event_at: payload.occurred_at,
          last_successful_external_event_id: payload.external_event_id ?? null,
          last_seen_at: ingestedAt,
          is_online: true,
          sync_status: "idle",
          sync_error: null
        },
        { onConflict: "device_id" }
      )
    ]).catch(() => undefined);
    runInBackground(background);

    return jsonResponse({ inserted: true, raw_event_id: rawEvent.id, event_hash: eventHash, callback_received_at: callbackReceivedAt, ingested_at: ingestedAt }, 201);
  } catch (error) {
    await supabase.from("failed_event_ingestions").insert({
      payload: safeBody,
      error_message: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

function normalizeEventType(current: string, raw: Record<string, unknown>) {
  if (current !== "unknown") return current;
  const value = String(raw.attendanceStatus ?? raw.attendance_status ?? "").toLowerCase();
  return ({ checkin: "check_in", checkout: "check_out", breakout: "break_out", breakin: "break_in" } as Record<string, string>)[value] ?? "unknown";
}

function relation(value: any) {
  return Array.isArray(value) ? value[0] : value;
}

function guatemalaDateTime(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, dateTime: `${date}T${parts.hour}:${parts.minute}:${parts.second}` };
}

function optionalInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function optionalTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function runInBackground(promise: Promise<unknown>) {
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(promise);
  else void promise;
}

function sanitizeObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/finger|face|photo|picture|image|template|password|secret|ehomekey/i.test(key))
    .map(([key, item]) => [key, sanitizeObject(item)]));
}
