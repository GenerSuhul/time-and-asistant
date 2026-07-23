import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { EdgeError, edgeErrorResponse } from "../_shared/errors.ts";
import { requireRole } from "../_shared/auth.ts";
import { authenticatedClient, serviceClient } from "../_shared/supabase.ts";

const employeeSchema = z.object({
  company_id: z.string().uuid(), branch_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  employee_code: z.string().trim().min(1).max(64), external_employee_id: z.string().trim().max(64).nullable().optional(),
  hikvision_employee_no: z.string().trim().regex(/^\d*$/, "employeeNo Hikvision debe contener únicamente dígitos").max(32).nullable().optional(),
  full_name: z.string().trim().min(1).max(160), email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(), document_number: z.string().max(80).nullable().optional(),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  hikvision_is_admin: z.boolean().default(false),
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
  z.object({ action: z.literal("list_active_credential_failures") }),
  z.object({ action: z.literal("enroll_fingerprint"), employee_id: z.string().uuid(), device_id: z.string().uuid(), finger_no: z.number().int().min(1).max(10).default(1) }),
  z.object({ action: z.literal("verify_employee_credentials"), employee_id: z.string().uuid(), device_ids: z.array(z.string().uuid()).max(200).optional() }),
  z.object({ action: z.literal("repair_employee_credentials"), employee_id: z.string().uuid(), device_ids: z.array(z.string().uuid()).max(200).optional() }),
  z.object({
    action: z.literal("replicate_fingerprint_to_devices"), employee_id: z.string().uuid(),
    source_device_id: z.string().uuid(), destination_device_ids: z.array(z.string().uuid()).min(1).max(200),
    finger_nos: z.array(z.number().int().min(1).max(10)).min(1).max(10)
  }),
  z.object({ action: z.literal("retry_failed_commands"), command_ids: z.array(z.string().uuid()).max(100).optional() }),
  z.object({ action: z.literal("resolve_command"), command_id: z.string().uuid() })
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
        id: data.id, status: data.status, trace_id: data.trace_id, expires_at: data.expires_at,
        hikvision_employee_no: data.employee_no
      }, trace_id: traceId, edge_duration_ms: Math.round(performance.now() - startedAt) }, 201);
    }

    const actor = await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    if (actor.type !== "user") throw new EdgeError("USER_REQUIRED", "Se requiere un usuario autenticado.", 401);

    if (input.action === "list_active_credential_failures") {
      const { data, error } = await supabase.from("device_commands")
        .select("id,status,command_type,device_id,employee_id,error_message,error_code,resolution_status,created_at,payload,devices:device_id(name)")
        .eq("status", "failed").eq("resolution_status", "active")
        .not("employee_id", "is", null)
        .in("command_type", employeeCredentialCommandTypes)
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return jsonResponse({ commands: (data ?? []).map((command: any) => ({
        id: command.id,
        status: command.status,
        command_type: command.command_type,
        device_id: command.device_id,
        employee_id: command.employee_id,
        error_message: command.error_message,
        error_code: command.error_code,
        resolution_status: command.resolution_status,
        created_at: command.created_at,
        payload: { trace_id: command.payload?.trace_id ?? command.id },
        devices: command.devices
      })) });
    }

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
      const uniqueDeviceIds = [...new Set(device_ids)];
      const { data, error } = await supabase.rpc("admin_commit_employee_creation_session", {
        p_session_id: input.session_id, p_employee: { ...employee, metadata: sanitizeMetadata(metadata) },
        p_device_ids: uniqueDeviceIds, p_requested_by: actor.user_id
      });
      if (error) throw error;
      const repairJobs = await enqueuePostAssignmentRepairs(
        supabase, data.id, uniqueDeviceIds, actor.user_id, traceId
      );
      return jsonResponse({
        employee: data, queued_credential_repairs: repairJobs.length, trace_id: traceId
      }, 201);
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
      const { data, error } = await supabase.rpc("admin_enroll_employee_fingerprint", {
        p_employee_id: input.employee_id, p_device_id: input.device_id, p_finger_no: input.finger_no,
        p_requested_by: actor.user_id, p_trace_id: traceId
      });
      if (error) throw error;
      return jsonResponse({ ...data, trace_id: traceId }, 202);
    }
    if (input.action === "verify_employee_credentials" || input.action === "repair_employee_credentials") {
      const jobs = await enqueueEmployeeVerification(
        supabase, input.employee_id, input.device_ids,
        input.action, actor.user_id, traceId
      );
      return jsonResponse({ queued: jobs.length, job_ids: jobs, trace_id: traceId }, 202);
    }
    if (input.action === "replicate_fingerprint_to_devices") {
      const jobs = await enqueueFingerprintReplication(supabase, {
        employeeId: input.employee_id, sourceDeviceId: input.source_device_id,
        destinationDeviceIds: input.destination_device_ids, fingerNos: input.finger_nos,
        requestedBy: actor.user_id, traceId
      });
      return jsonResponse({ queued: jobs.length, job_ids: jobs, trace_id: traceId }, 202);
    }
    if (input.action === "retry_failed_commands") {
      let request = supabase.from("device_commands").select("id")
        .eq("status", "failed").eq("resolution_status", "active")
        .not("employee_id", "is", null)
        .in("command_type", employeeCredentialCommandTypes);
      if (input.command_ids?.length) request = request.in("id", [...new Set(input.command_ids)]);
      const { data: failed, error: failedError } = await request.limit(100);
      if (failedError) throw failedError;
      const ids = (failed ?? []).map((item: any) => item.id);
      if (ids.length) {
        const { error } = await supabase.from("device_commands").update({
          status: "pending", attempts: 0, next_run_at: new Date().toISOString(),
          processed_at: null, locked_at: null, error_message: null, error_code: null,
          resolution_reason: null, resolved_at: null
        }).in("id", ids);
        if (error) throw error;
      }
      return jsonResponse({ queued: ids.length, job_ids: ids, trace_id: traceId }, 202);
    }
    if (input.action === "resolve_command") {
      await resolveVerifiedCommand(supabase, input.command_id);
      return jsonResponse({ resolved: true, command_id: input.command_id, trace_id: traceId });
    }

    const { device_ids, metadata, ...employee } = input.employee;
    const uniqueDeviceIds = [...new Set(device_ids)];
    let previousDeviceIds: string[] = [];
    let previousIsAdmin = false;
    if (input.action === "update") {
      const [previousEmployee, previousLinks] = await Promise.all([
        supabase.from("employees").select("hikvision_is_admin").eq("id", input.id).single(),
        supabase.from("employee_devices").select("device_id").eq("employee_id", input.id)
      ]);
      if (previousEmployee.error) throw previousEmployee.error;
      if (previousLinks.error) throw previousLinks.error;
      previousIsAdmin = Boolean(previousEmployee.data.hikvision_is_admin);
      previousDeviceIds = (previousLinks.data ?? []).map((item: any) => item.device_id);
    }
    const { data: saved, error: employeeError } = await supabase.rpc("admin_save_employee", {
      p_employee: { ...employee, metadata: sanitizeMetadata(metadata) }, p_device_ids: uniqueDeviceIds,
      p_requested_by: actor.user_id, p_employee_id: input.action === "update" ? input.id : null
    });
    if (employeeError) throw employeeError;
    const previousSet = new Set(previousDeviceIds);
    const newlyAssigned = uniqueDeviceIds.filter((deviceId) => !previousSet.has(deviceId));
    const roleChanged = input.action === "update"
      && previousIsAdmin !== Boolean(input.employee.hikvision_is_admin);
    const repairDeviceIds = roleChanged ? uniqueDeviceIds : newlyAssigned;
    const repairJobs = await enqueuePostAssignmentRepairs(
      supabase, saved.id, repairDeviceIds, actor.user_id, traceId
    );
    return jsonResponse({
      employee: saved, queued_devices: uniqueDeviceIds.length,
      queued_credential_repairs: repairJobs.length, trace_id: traceId
    }, input.action === "create" ? 201 : 200);
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

async function enqueueEmployeeVerification(supabase: any, employeeId: string, requestedDeviceIds: string[] | undefined,
  mode: "verify_employee_credentials" | "repair_employee_credentials", requestedBy: string, traceId: string,
  dependsOnByDevice: Map<string, string> = new Map()) {
  const { data: employee, error: employeeError } = await supabase.from("employees")
    .select("id,hikvision_employee_no").eq("id", employeeId).single();
  if (employeeError) throw employeeError;
  const employeeNo = String(employee.hikvision_employee_no ?? "").trim();
  if (!/^\d+$/.test(employeeNo)) throw new EdgeError("HIKVISION_EMPLOYEE_NO_INVALID", "La persona no tiene employeeNo Hikvision numérico.", 409);
  let linksRequest = supabase.from("employee_devices").select("device_id").eq("employee_id", employeeId);
  if (requestedDeviceIds?.length) linksRequest = linksRequest.in("device_id", [...new Set(requestedDeviceIds)]);
  const { data: links, error: linksError } = await linksRequest;
  if (linksError) throw linksError;
  const deviceIds = (links ?? []).map((item: any) => item.device_id);
  if (!deviceIds.length) throw new EdgeError("EMPLOYEE_HAS_NO_DEVICES", "La persona no tiene dispositivos asignados.", 409);
  const { data: active, error: activeError } = await supabase.from("device_commands")
    .select("device_id,payload").eq("employee_id", employeeId).eq("command_type", "sync_device_people")
    .in("status", ["pending", "processing"]).in("device_id", deviceIds);
  if (activeError) throw activeError;
  const activeDevices = new Set((active ?? []).filter((item: any) => item.payload?.mode === mode).map((item: any) => item.device_id));
  const rows = deviceIds.filter((deviceId: string) => !activeDevices.has(deviceId)).map((deviceId: string) => ({
    device_id: deviceId, employee_id: employeeId, command_type: "sync_device_people",
    requested_by: requestedBy,
    payload: { mode, employee_no: employeeNo, trace_id: traceId },
    depends_on_command_id: dependsOnByDevice.get(deviceId) ?? null
  }));
  if (!rows.length) return [];
  const { data, error } = await supabase.from("device_commands").insert(rows).select("id");
  if (error) throw error;
  return (data ?? []).map((item: any) => item.id);
}

async function enqueuePostAssignmentRepairs(supabase: any, employeeId: string, deviceIds: string[],
  requestedBy: string, traceId: string) {
  if (!deviceIds.length) return [];
  const { data: provisioning, error } = await supabase.from("device_commands")
    .select("id,device_id,created_at").eq("employee_id", employeeId)
    .in("device_id", deviceIds).in("command_type", ["sync_person", "update_person", "sync_card"])
    .in("status", ["pending", "processing"]).order("created_at", { ascending: false });
  if (error) throw error;
  const dependencies = new Map<string, string>();
  for (const command of provisioning ?? []) {
    if (!dependencies.has(command.device_id)) dependencies.set(command.device_id, command.id);
  }
  return enqueueEmployeeVerification(
    supabase, employeeId, deviceIds, "repair_employee_credentials",
    requestedBy, traceId, dependencies
  );
}

async function enqueueFingerprintReplication(supabase: any, input: {
  employeeId: string; sourceDeviceId: string; destinationDeviceIds: string[];
  fingerNos: number[]; requestedBy: string; traceId: string;
}) {
  const { data: employee, error: employeeError } = await supabase.from("employees")
    .select("hikvision_employee_no").eq("id", input.employeeId).single();
  if (employeeError) throw employeeError;
  const employeeNo = String(employee.hikvision_employee_no ?? "");
  if (!/^\d+$/.test(employeeNo)) throw new EdgeError("HIKVISION_EMPLOYEE_NO_INVALID", "La persona no tiene employeeNo Hikvision numérico.", 409);
  const { data: source, error: sourceError } = await supabase.from("employee_device_credentials")
    .select("status,verified_count").eq("employee_id", input.employeeId).eq("device_id", input.sourceDeviceId)
    .eq("credential_type", "fingerprint").maybeSingle();
  if (sourceError) throw sourceError;
  if (!source || !["captured", "synced"].includes(source.status) || Number(source.verified_count) < 1) {
    throw new EdgeError("FINGERPRINT_SOURCE_NOT_VERIFIED", "El dispositivo origen no tiene una huella verificada.", 409);
  }
  const destinationIds = [...new Set(input.destinationDeviceIds)].filter((id) => id !== input.sourceDeviceId);
  const { data: links, error: linksError } = await supabase.from("employee_devices")
    .select("device_id").eq("employee_id", input.employeeId).in("device_id", destinationIds);
  if (linksError) throw linksError;
  const assigned = new Set((links ?? []).map((item: any) => item.device_id));
  if (assigned.size !== destinationIds.length) {
    throw new EdgeError("FINGERPRINT_DESTINATION_NOT_ASSIGNED", "Todos los destinos deben estar asignados a la persona.", 409);
  }
  const fingerNos = [...new Set(input.fingerNos)];
  const rows = destinationIds.map((deviceId) => ({
    device_id: deviceId, employee_id: input.employeeId, command_type: "enroll_fingerprint",
    requested_by: input.requestedBy,
    payload: {
      mode: "replicate", source_device_id: input.sourceDeviceId,
      employee_no: employeeNo, finger_no: fingerNos[0], finger_nos: fingerNos, trace_id: input.traceId
    }
  }));
  const { data, error } = await supabase.from("device_commands").insert(rows).select("id");
  if (error) throw error;
  return (data ?? []).map((item: any) => item.id);
}

async function resolveVerifiedCommand(supabase: any, commandId: string) {
  const { data: command, error } = await supabase.from("device_commands")
    .select("id,device_id,employee_id,command_type,status,created_at").eq("id", commandId).single();
  if (error) throw error;
  if (!command.employee_id || !employeeCredentialCommandTypes.includes(command.command_type)) {
    throw new EdgeError("COMMAND_OUTSIDE_EMPLOYEE_CREDENTIAL_SCOPE", "Este comando solo puede administrarse desde el módulo técnico.", 403);
  }
  if (command.status !== "failed") throw new EdgeError("COMMAND_NOT_FAILED", "Solo se resuelven comandos fallidos.", 409);
  let verified = false;
  if (command.employee_id) {
    const credentialType = command.command_type.includes("fingerprint") ? "fingerprint"
      : command.command_type.includes("card") ? "card" : "person";
    const { data: state, error: stateError } = await supabase.from("employee_device_credentials")
      .select("status,last_verified_at,last_error").eq("employee_id", command.employee_id).eq("device_id", command.device_id)
      .eq("credential_type", credentialType).maybeSingle();
    if (stateError) throw stateError;
    verified = Boolean(state?.last_verified_at && new Date(state.last_verified_at) > new Date(command.created_at)
      && !state.last_error && ["none", "captured", "synced"].includes(state.status));
  } else if (command.command_type === "sync_device_people") {
    const { data: later, error: laterError } = await supabase.from("device_commands").select("id")
      .eq("device_id", command.device_id).eq("command_type", "sync_device_people").eq("status", "success")
      .gt("created_at", command.created_at).limit(1);
    if (laterError) throw laterError;
    verified = Boolean(later?.length);
  }
  if (!verified) throw new EdgeError("COMMAND_NOT_VERIFIED", "Primero verifica el estado real del dispositivo.", 409);
  const { error: updateError } = await supabase.from("device_commands").update({
    resolution_status: "resolved", resolved_at: new Date().toISOString(),
    resolution_reason: "verified_and_resolved_by_operator"
  }).eq("id", commandId);
  if (updateError) throw updateError;
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

const employeeCredentialCommandTypes = [
  "sync_person",
  "update_person",
  "delete_person",
  "sync_card",
  "delete_card",
  "sync_face",
  "delete_face",
  "enroll_fingerprint",
  "delete_fingerprint",
  "sync_device_people"
];
