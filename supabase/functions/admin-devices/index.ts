import { z } from "npm:zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { EdgeError, edgeErrorResponse } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/supabase.ts";

const editable = z.object({
  branch_id: z.string().uuid().nullable().optional(),
  branch_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().max(120).nullable().optional(),
  serial_number: z.string().trim().max(120).nullable().optional(),
  firmware_version: z.string().trim().max(120).nullable().optional(),
  protocol: z.enum(["isup", "isapi", "hik_devicegateway"]),
  device_identifier: z.string().trim().min(1).max(120),
  dev_index: z.string().trim().max(120).nullable().optional(),
  gateway_url: z.string().url().nullable().optional(),
  connection_mode: z.enum(["devicegateway", "direct_isup", "direct_isapi"]),
  timezone: z.string().trim().min(1).max(80),
  offline_timeout_seconds: z.number().int().min(30).max(86400)
}).strict();

const createDevice = editable.extend({
  ehome_key: z.string().min(1).max(256)
});

const updateDevice = editable.extend({
  ehome_key: z.string().max(256).nullable().optional()
});

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), device: createDevice }),
  z.object({ action: z.literal("update"), id: z.string().uuid(), device: updateDevice }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() })
]);

Deno.serve(async (req) => {
  const traceId = crypto.randomUUID();
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return edgeErrorResponse(new EdgeError("METHOD_NOT_ALLOWED", "Método no permitido.", 405), traceId);

  try {
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin"]);
    if (actor.type !== "user") throw new Error("Device administration requires an authenticated user");
    const input = requestSchema.parse(await req.json());

    const assignment = input.action === "delete" ? null : await validateBranches(supabase, input.device.branch_ids, input.device.branch_id);
    if (assignment) await assertCompanyScope(supabase, actor.user_id, assignment.companyId);

    if (input.action !== "create") {
      const { data: existing, error } = await supabase.from("devices").select("id,branches:branch_id(company_id)").eq("id", input.id).maybeSingle();
      if (error) throw error;
      if (!existing) throw new Error("Device not found");
      const relation = Array.isArray(existing.branches) ? existing.branches[0] : existing.branches;
      if (relation?.company_id) await assertCompanyScope(supabase, actor.user_id, relation.company_id);
    }

    if (input.action === "create") {
      const { ehome_key, branch_ids: _branchIds, branch_id: _branchId, ...deviceInput } = input.device;
      const { data, error } = await supabase.from("devices").insert({
        ...deviceInput, branch_id: assignment!.primaryBranchId,
        status: "offline", status_reason: "registration_pending", last_seen_at: null
      }).select("*").single();
      if (error) throw error;

      try {
        await setDeviceBranches(supabase, data.id, assignment!);
        await queueProvisioning(supabase, data.id, ehome_key);
      } catch (queueError) {
        await supabase.from("devices").delete().eq("id", data.id);
        throw queueError;
      }
      return jsonResponse({ device: data }, 201);
    }

    if (input.action === "update") {
      const { ehome_key, branch_ids: _branchIds, branch_id: _branchId, ...deviceInput } = input.device;
      const { data, error } = await supabase.from("devices").update({
        ...deviceInput, branch_id: assignment!.primaryBranchId,
        ...(ehome_key ? { status: "offline", status_reason: "registration_pending" } : {})
      }).eq("id", input.id).select("*").single();
      if (error) throw error;
      await setDeviceBranches(supabase, input.id, assignment!);
      if (ehome_key) await queueProvisioning(supabase, input.id, ehome_key);
      return jsonResponse({ device: data });
    }

    const { error } = await supabase.from("devices").delete().eq("id", input.id);
    if (error) throw error;
    return jsonResponse({ deleted: true });
  } catch (error) {
    return edgeErrorResponse(error, traceId);
  }
});

async function validateBranches(supabase: any, requested: string[] | undefined, primary: string | null | undefined) {
  const branchIds = [...new Set((requested?.length ? requested : primary ? [primary] : []))];
  if (branchIds.length === 0) throw new Error("DEVICE_BRANCH_REQUIRED");
  const primaryBranchId = primary ?? branchIds[0];
  if (!branchIds.includes(primaryBranchId)) throw new Error("DEVICE_PRIMARY_BRANCH_NOT_ASSIGNED");
  const { data, error } = await supabase.from("branches").select("id,company_id").in("id", branchIds);
  if (error) throw error;
  if ((data ?? []).length !== branchIds.length) throw new Error("DEVICE_BRANCH_NOT_FOUND");
  const companies = [...new Set((data ?? []).map((branch: any) => branch.company_id))];
  if (companies.length !== 1) throw new Error("DEVICE_BRANCH_COMPANY_MISMATCH");
  return { branchIds, primaryBranchId, companyId: companies[0] as string };
}

async function setDeviceBranches(supabase: any, deviceId: string, assignment: { branchIds: string[]; primaryBranchId: string }) {
  const { error } = await supabase.rpc("admin_set_device_branches", {
    p_device_id: deviceId,
    p_branch_ids: assignment.branchIds,
    p_primary_branch_id: assignment.primaryBranchId
  });
  if (error) throw error;
}

async function queueProvisioning(supabase: any, deviceId: string, value: string) {
  const encrypted = await encryptRegistrationKey(value);
  const { error } = await supabase.from("device_registration_requests").upsert({
    device_id: deviceId,
    encrypted_key: encrypted.ciphertext,
    iv: encrypted.iv,
    status: "pending",
    attempts: 0,
    last_error: null,
    next_attempt_at: new Date().toISOString(),
    completed_at: null,
    updated_at: new Date().toISOString()
  }, { onConflict: "device_id" });
  if (error) throw error;
}

async function encryptRegistrationKey(value: string) {
  const secret = Deno.env.get("GATEWAY_API_SECRET");
  if (!secret) throw new Error("GATEWAY_API_SECRET is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  return { ciphertext: toBase64(encrypted), iv: toBase64(iv) };
}

function toBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function assertCompanyScope(supabase: any, userId: string, companyId: string) {
  const { data, error } = await supabase.from("user_roles").select("company_id,roles:role_id(key)").eq("user_id", userId);
  if (error) throw error;
  const permitted = (data ?? []).some((entry: any) => {
    const role = Array.isArray(entry.roles) ? entry.roles[0] : entry.roles;
    return ["super_admin", "it_admin"].includes(role?.key) && (entry.company_id === null || entry.company_id === companyId);
  });
  if (!permitted) throw new Error("Forbidden: company is outside the user's scope");
}
