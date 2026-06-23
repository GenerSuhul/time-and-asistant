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

  try {
    const payload = schema.parse(safeJsonParse(rawBody));

    const deviceQuery = payload.device_identifier
      ? supabase.from("devices").select("*").eq("device_identifier", payload.device_identifier).maybeSingle()
      : supabase.from("devices").select("*").eq("serial_number", payload.serial_number).maybeSingle();

    const { data: device, error: deviceError } = await deviceQuery;
    if (deviceError) throw deviceError;
    if (!device) return jsonResponse({ error: "Device not registered" }, 404);

    await supabase.from("event_ingestion_queue").insert({ device_id: device.id, payload, status: "processing" });

    const { data: employee } = payload.employee_external_id
      ? await supabase
          .from("employees")
          .select("id, branch_id")
          .eq("external_employee_id", payload.employee_external_id)
          .maybeSingle()
      : { data: null };

    const eventHash = await sha256(
      payload.external_event_id
        ? `${device.id}:${payload.external_event_id}`
        : `${device.id}:${payload.employee_external_id ?? ""}:${payload.occurred_at}:${payload.raw_event_type}`
    );

    const { data: rawEvent, error: rawError } = await supabase
      .from("raw_access_events")
      .upsert(
        {
          device_id: device.id,
          branch_id: device.branch_id,
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

    if (employee?.id) {
      const { error: eventError } = await supabase.from("attendance_events").insert({
        raw_event_id: rawEvent.id,
        employee_id: employee.id,
        branch_id: device.branch_id,
        device_id: device.id,
        event_type: payload.event_type,
        occurred_at: payload.occurred_at,
        source: "device",
        confidence: payload.event_type === "unknown" ? 0.4 : 1.0
      });
      if (eventError && eventError.code !== "23505") throw eventError;

      await calculateAttendanceForDate(supabase, {
        date: payload.occurred_at.slice(0, 10),
        employee_id: employee.id,
        branch_id: device.branch_id ?? undefined
      });
    }

    await supabase.from("devices").update({ status: "online", last_seen_at: new Date().toISOString() }).eq("id", device.id);
    await supabase.from("device_sync_state").upsert(
      {
        device_id: device.id,
        last_realtime_event_at: payload.occurred_at,
        last_successful_event_at: payload.occurred_at,
        last_successful_external_event_id: payload.external_event_id ?? null,
        last_seen_at: new Date().toISOString(),
        is_online: true,
        sync_status: "idle",
        sync_error: null
      },
      { onConflict: "device_id" }
    );

    return jsonResponse({ inserted: true, raw_event_id: rawEvent.id, event_hash: eventHash }, 201);
  } catch (error) {
    await supabase.from("failed_event_ingestions").insert({
      payload: safeJsonParse(rawBody),
      error_message: error instanceof Error ? error.message : String(error)
    });
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
