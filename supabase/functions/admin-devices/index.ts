import { z } from "npm:zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const editable = z.object({
  branch_id: z.string().uuid().nullable().optional(),
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

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), device: editable }),
  z.object({ action: z.literal("update"), id: z.string().uuid(), device: editable }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() })
]);

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin"]);
    if (actor.type !== "user") throw new Error("Device administration requires an authenticated user");
    const input = requestSchema.parse(await req.json());

    if (input.action !== "delete" && input.device.branch_id) {
      const { data: branch, error } = await supabase.from("branches").select("id,company_id").eq("id", input.device.branch_id).maybeSingle();
      if (error) throw error;
      if (!branch) throw new Error("Branch not found or outside the administrative scope");
      await assertCompanyScope(supabase, actor.user_id, branch.company_id);
    }

    if (input.action !== "create") {
      const { data: existing, error } = await supabase.from("devices").select("id,branches:branch_id(company_id)").eq("id", input.id).maybeSingle();
      if (error) throw error;
      if (!existing) throw new Error("Device not found");
      const relation = Array.isArray(existing.branches) ? existing.branches[0] : existing.branches;
      if (relation?.company_id) await assertCompanyScope(supabase, actor.user_id, relation.company_id);
    }

    if (input.action === "create") {
      const { data, error } = await supabase.from("devices").insert({
        ...input.device, status: "offline", status_reason: "no_events", last_seen_at: null
      }).select("*").single();
      if (error) throw error;
      return jsonResponse({ device: data }, 201);
    }

    if (input.action === "update") {
      const { data, error } = await supabase.from("devices").update(input.device).eq("id", input.id).select("*").single();
      if (error) throw error;
      return jsonResponse({ device: data });
    }

    const { error } = await supabase.from("devices").delete().eq("id", input.id);
    if (error) throw error;
    return jsonResponse({ deleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /Unauthorized|Missing Authorization/.test(message) ? 401 : /Forbidden/.test(message) ? 403 : 400;
    return jsonResponse({ error: message }, status);
  }
});

async function assertCompanyScope(supabase: any, userId: string, companyId: string) {
  const { data, error } = await supabase.from("user_roles").select("company_id,roles:role_id(key)").eq("user_id", userId);
  if (error) throw error;
  const permitted = (data ?? []).some((entry: any) => {
    const role = Array.isArray(entry.roles) ? entry.roles[0] : entry.roles;
    return ["super_admin", "it_admin"].includes(role?.key) && (entry.company_id === null || entry.company_id === companyId);
  });
  if (!permitted) throw new Error("Forbidden: company is outside the user's scope");
}
