import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { EdgeError, edgeErrorResponse } from "../_shared/errors.ts";
import { requireRole } from "../_shared/auth.ts";
import { authenticatedClient, serviceClient } from "../_shared/supabase.ts";

const employeeSchema = z.object({
  company_id: z.string().uuid(), branch_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  employee_code: z.string().trim().min(1).max(64), external_employee_id: z.string().trim().max(64).nullable().optional(),
  full_name: z.string().trim().min(1).max(160), email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(), document_number: z.string().max(80).nullable().optional(),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  card_number: z.string().trim().max(64).nullable().optional(), pin_enabled: z.boolean().default(false),
  hired_at: z.string().nullable().optional(), terminated_at: z.string().nullable().optional(),
  access_valid_from: z.string().nullable().optional(), access_valid_to: z.string().nullable().optional(),
  device_ids: z.array(z.string().uuid()).max(200).default([]), metadata: z.record(z.unknown()).default({})
});

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), employee: employeeSchema }),
  z.object({ action: z.literal("update"), id: z.string().uuid(), employee: employeeSchema }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("start_creation_session"), employee: employeeSchema }),
  z.object({ action: z.literal("stage_fingerprint"), session_id: z.string().uuid(), employee: employeeSchema, device_id: z.string().uuid(), finger_no: z.number().int().min(1).max(10).default(1) }),
  z.object({ action: z.literal("commit_creation_session"), session_id: z.string().uuid(), employee: employeeSchema }),
  z.object({ action: z.literal("cancel_creation_session"), session_id: z.string().uuid(), reason: z.string().max(120).default("cancelled_by_user") }),
  z.object({ action: z.literal("sync_device_people"), device_id: z.string().uuid() }),
  z.object({ action: z.literal("sync_all_device_people") }),
  z.object({ action: z.literal("enroll_fingerprint"), employee_id: z.string().uuid(), device_id: z.string().uuid(), finger_no: z.number().int().min(1).max(10).default(1) })
]);

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  const traceId = crypto.randomUUID();
  if (req.method !== "POST") return edgeErrorResponse(new EdgeError("METHOD_NOT_ALLOWED", "Método no permitido.", 405), traceId);
  try {
    const input = requestSchema.parse(await req.json());
    const supabase = serviceClient();

    if (input.action === "start_creation_session") {
      const startedAt = performance.now();
      const { device_ids: _devices, metadata, ...draft } = input.employee;
      const safeDraft = { ...draft, metadata: sanitizeMetadata(metadata) };
      const { data, error } = await authenticatedClient(req).rpc("admin_start_employee_creation_session", {
        p_employee: safeDraft, p_trace_id: traceId
      });
      if (error) throw error;
      return jsonResponse({ session: {
        id: data.id, status: data.status, trace_id: data.trace_id, expires_at: data.expires_at
      }, trace_id: traceId, edge_duration_ms: Math.round(performance.now() - startedAt) }, 201);
    }

    const actor = await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    if (actor.type !== "user") throw new EdgeError("USER_REQUIRED", "Se requiere un usuario autenticado.", 401);

    if (input.action === "stage_fingerprint") {
      const { device_ids: _devices, metadata, ...draft } = input.employee;
      const startedAt = performance.now();
      const { data, error } = await supabase.rpc("admin_stage_employee_fingerprint", {
        p_session_id: input.session_id, p_device_id: input.device_id, p_finger_no: input.finger_no,
        p_employee: { ...draft, metadata: sanitizeMetadata(metadata) }, p_requested_by: actor.user_id, p_trace_id: traceId
      });
      if (error) throw error;
      return jsonResponse({ ...data, edge_duration_ms: Math.round(performance.now() - startedAt) }, 202);
    }

    if (input.action === "commit_creation_session") {
      const { device_ids, metadata, ...employee } = input.employee;
      const { data, error } = await supabase.rpc("admin_commit_employee_creation_session", {
        p_session_id: input.session_id, p_employee: { ...employee, metadata: sanitizeMetadata(metadata) },
        p_device_ids: [...new Set(device_ids)], p_requested_by: actor.user_id
      });
      if (error) throw error;
      return jsonResponse({ employee: data, trace_id: traceId }, 201);
    }

    if (input.action === "cancel_creation_session") {
      const { data, error } = await supabase.rpc("admin_cancel_employee_creation_session", {
        p_session_id: input.session_id, p_requested_by: actor.user_id, p_reason: input.reason
      });
      if (error) throw error;
      return jsonResponse({ ok: true, cleanup_job_ids: data ?? [], trace_id: traceId }, 202);
    }

    if (input.action === "sync_device_people") {
      const command = await enqueueImport(supabase, input.device_id, actor.user_id, traceId);
      return jsonResponse({ command, trace_id: traceId, job_id: command.id }, 202);
    }
    if (input.action === "delete") {
      const { data: links, error: linksError } = await supabase.from("employee_devices")
        .select("device_id,devices:device_id(name,status)").eq("employee_id", input.id);
      if (linksError) throw linksError;
      const { error } = await supabase.rpc("admin_delete_employee", { p_employee_id: input.id, p_requested_by: actor.user_id });
      if (error) throw error;
      return jsonResponse({ ok: true, trace_id: traceId, queued_devices: (links ?? []).map((link: any) => ({
        id: link.device_id, name: relation(link.devices)?.name ?? link.device_id, status: relation(link.devices)?.status ?? "unknown"
      })) });
    }
    if (input.action === "sync_all_device_people") {
      const { data: devices, error } = await supabase.from("devices").select("id").not("dev_index", "is", null);
      if (error) throw error;
      const commands = [];
      for (const device of devices ?? []) commands.push(await enqueueImport(supabase, device.id, actor.user_id, traceId));
      return jsonResponse({ queued: commands.length, trace_id: traceId, job_ids: commands.map((item) => item.id) }, 202);
    }
    if (input.action === "enroll_fingerprint") {
      const { data: link, error: linkError } = await supabase.from("employee_devices")
        .select("external_person_id,devices:device_id(name,status,dev_index)").eq("employee_id", input.employee_id).eq("device_id", input.device_id).maybeSingle();
      if (linkError) throw linkError;
      if (!link?.external_person_id) throw new EdgeError("PERSON_NOT_SYNCED", "Sincroniza la persona con el dispositivo antes de capturar huella.", 409);
      const device = relation(link.devices);
      if (!device?.dev_index) throw new EdgeError("DEVICE_NOT_LINKED", "El dispositivo no está enlazado con DeviceGateway.", 409, { device: device?.name });
      const { data: session, error: sessionError } = await supabase.from("biometric_enrollment_sessions").insert({
        employee_id: input.employee_id, device_id: input.device_id, finger_no: input.finger_no, requested_by: actor.user_id,
        trace_id: traceId, status_detail: "Solicitud recibida; esperando worker"
      }).select("*").single();
      if (sessionError) throw sessionError;
      const { data: command, error: commandError } = await supabase.from("device_commands").insert({
        device_id: input.device_id, employee_id: input.employee_id, command_type: "enroll_fingerprint", requested_by: actor.user_id,
        payload: { employee_no: link.external_person_id, finger_no: input.finger_no, session_id: session.id, trace_id: traceId }
      }).select("id").single();
      if (commandError) {
        await supabase.from("biometric_enrollment_sessions").update({ status: "failed", error_message: "No se pudo encolar la captura" }).eq("id", session.id);
        throw commandError;
      }
      await supabase.from("biometric_enrollment_sessions").update({ device_command_id: command.id }).eq("id", session.id);
      await supabase.from("employees").update({ fingerprint_status: "pending" }).eq("id", input.employee_id);
      return jsonResponse({ session, trace_id: traceId, job_id: command.id }, 202);
    }

    const { device_ids, metadata, ...employee } = input.employee;
    const { data: saved, error: employeeError } = await supabase.rpc("admin_save_employee", {
      p_employee: { ...employee, metadata: sanitizeMetadata(metadata) }, p_device_ids: [...new Set(device_ids)],
      p_requested_by: actor.user_id, p_employee_id: input.action === "update" ? input.id : null
    });
    if (employeeError) throw employeeError;
    return jsonResponse({ employee: saved, queued_devices: device_ids.length, trace_id: traceId }, input.action === "create" ? 201 : 200);
  } catch (error) {
    return edgeErrorResponse(error, traceId);
  }
});

async function enqueueImport(supabase: any, deviceId: string, requestedBy: string, traceId: string) {
  const { data, error } = await supabase.from("device_commands").insert({
    device_id: deviceId, command_type: "sync_device_people", requested_by: requestedBy, payload: { trace_id: traceId }
  }).select("*").single();
  if (error) throw error;
  return data;
}

function sanitizeMetadata(value: Record<string, unknown>) {
  const allowed = new Set(["notes", "source", "custom_fields"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key) && !/finger|face|template|password|secret|key|token/i.test(key))
    .map(([key, item]) => [key, sanitizeMetadataValue(item)]));
}
function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(sanitizeMetadataValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/finger|face|template|password|secret|key|token/i.test(key)).map(([key, item]) => [key, sanitizeMetadataValue(item)]));
  return typeof value === "string" ? value.slice(0, 1000) : value;
}
function relation(value: any) { return Array.isArray(value) ? value[0] : value; }
