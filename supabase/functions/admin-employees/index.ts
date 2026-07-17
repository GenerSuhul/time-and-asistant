import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const employeeSchema = z.object({
  company_id: z.string().uuid(), branch_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(), attendance_group_id: z.string().uuid().nullable().optional(),
  employee_code: z.string().trim().min(1).max(64), external_employee_id: z.string().trim().max(64).nullable().optional(),
  full_name: z.string().trim().min(1).max(160), email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(), document_number: z.string().max(80).nullable().optional(),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  card_number: z.string().trim().max(64).nullable().optional(), hired_at: z.string().nullable().optional(),
  terminated_at: z.string().nullable().optional(), device_ids: z.array(z.string().uuid()).default([])
});

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), employee: employeeSchema }),
  z.object({ action: z.literal("update"), id: z.string().uuid(), employee: employeeSchema }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("sync_device_people"), device_id: z.string().uuid() }),
  z.object({ action: z.literal("sync_all_device_people") }),
  z.object({ action: z.literal("enroll_fingerprint"), employee_id: z.string().uuid(), device_id: z.string().uuid(), finger_no: z.number().int().min(1).max(10).default(1) })
]);

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const input = requestSchema.parse(await req.json());
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    if (actor.type !== "user") throw new Error("An authenticated user is required");

    if (input.action === "sync_device_people") {
      const command = await enqueueImport(supabase, input.device_id, actor.user_id);
      return jsonResponse({ command }, 202);
    }
    if (input.action === "delete") {
      const { error } = await supabase.from("employees").delete().eq("id", input.id);
      if (error) throw error;
      return jsonResponse({ ok: true });
    }
    if (input.action === "sync_all_device_people") {
      const { data: devices, error } = await supabase.from("devices").select("id").not("dev_index", "is", null);
      if (error) throw error;
      const commands = [];
      for (const device of devices ?? []) commands.push(await enqueueImport(supabase, device.id, actor.user_id));
      return jsonResponse({ queued: commands.length }, 202);
    }
    if (input.action === "enroll_fingerprint") {
      const { data: link, error: linkError } = await supabase.from("employee_devices")
        .select("external_person_id").eq("employee_id", input.employee_id).eq("device_id", input.device_id).maybeSingle();
      if (linkError) throw linkError;
      if (!link?.external_person_id) throw new Error("Employee must be synchronized to the selected device first");
      const { data: session, error: sessionError } = await supabase.from("biometric_enrollment_sessions").insert({
        employee_id: input.employee_id, device_id: input.device_id, finger_no: input.finger_no, requested_by: actor.user_id
      }).select("*").single();
      if (sessionError) throw sessionError;
      const { error: commandError } = await supabase.from("device_commands").insert({
        device_id: input.device_id, employee_id: input.employee_id, command_type: "enroll_fingerprint", requested_by: actor.user_id,
        payload: { employee_no: link.external_person_id, finger_no: input.finger_no, session_id: session.id }
      });
      if (commandError) {
        await supabase.from("biometric_enrollment_sessions").update({ status: "failed", error_message: "Unable to queue enrollment" }).eq("id", session.id);
        throw commandError;
      }
      await supabase.from("employees").update({ fingerprint_status: "pending" }).eq("id", input.employee_id);
      return jsonResponse({ session }, 202);
    }

    const { device_ids, ...employee } = input.employee;
    const externalId = employee.external_employee_id || employee.employee_code;
    const commandType = input.action === "create" ? "sync_person" : "update_person";
    const mutation = input.action === "create"
      ? supabase.from("employees").insert({ ...employee, external_employee_id: externalId })
      : supabase.from("employees").update({ ...employee, external_employee_id: externalId }).eq("id", input.id);
    const { data: saved, error: employeeError } = await mutation.select("*").single();
    if (employeeError) throw employeeError;

    for (const deviceId of device_ids) {
      const { error: linkError } = await supabase.from("employee_devices").upsert({
        employee_id: saved.id, device_id: deviceId, external_person_id: externalId, sync_status: "pending", last_error: null
      }, { onConflict: "employee_id,device_id" });
      if (linkError) throw linkError;
      const commands = [{
        device_id: deviceId, employee_id: saved.id, command_type: commandType, requested_by: actor.user_id,
        payload: { employee_no: externalId, name: saved.full_name }
      }];
      if (employee.card_number) commands.push({
        device_id: deviceId, employee_id: saved.id, command_type: "sync_card", requested_by: actor.user_id,
        payload: { employee_no: externalId, card_no: employee.card_number }
      });
      const { error: commandError } = await supabase.from("device_commands").insert(commands);
      if (commandError) throw commandError;
    }
    return jsonResponse({ employee: saved, queued_devices: device_ids.length }, input.action === "create" ? 201 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: /fingerData|password|secret|key/i.test(message) ? "Sensitive operation failed" : message.slice(0, 500) }, 400);
  }
});

async function enqueueImport(supabase: any, deviceId: string, requestedBy: string) {
  const { data, error } = await supabase.from("device_commands").insert({
    device_id: deviceId, command_type: "sync_device_people", requested_by: requestedBy, payload: {}
  }).select("*").single();
  if (error) throw error;
  return data;
}
