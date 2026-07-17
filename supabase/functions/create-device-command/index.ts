import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { requireRole } from "../_shared/auth.ts";

const schema = z.object({
  device_id: z.string().uuid(),
  command_type: z.enum([
    "sync_person",
    "update_person",
    "delete_person",
    "sync_card",
    "delete_card",
    "sync_face",
    "delete_face",
    "enroll_fingerprint",
    "delete_fingerprint",
    "remote_door",
    "sync_permission_schedule",
    "fetch_events",
    "reboot",
    "sync_time"
  ]),
  payload: z.record(z.unknown()).default({})
});

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const payload = schema.parse(await req.json());
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin"]);
    if (actor.type !== "user") throw new Error("Device commands require an authenticated user");
    const { data: device, error: deviceError } = await supabase
      .from("devices").select("id,branches:branch_id(company_id)").eq("id", payload.device_id).maybeSingle();
    if (deviceError) throw deviceError;
    if (!device) throw new Error("Device not found");
    const relation = Array.isArray(device.branches) ? device.branches[0] : device.branches;
    if (relation?.company_id) {
      const { data: roles, error: rolesError } = await supabase.from("user_roles").select("company_id,roles:role_id(key)").eq("user_id", actor.user_id);
      if (rolesError) throw rolesError;
      const permitted = (roles ?? []).some((entry: any) => {
        const role = Array.isArray(entry.roles) ? entry.roles[0] : entry.roles;
        return ["super_admin", "it_admin"].includes(role?.key) && (entry.company_id === null || entry.company_id === relation.company_id);
      });
      if (!permitted) throw new Error("Forbidden: device is outside the user's scope");
    }
    const { data, error } = await supabase
      .from("device_commands")
      .insert({
        ...payload,
        status: "pending",
        requested_by: actor.user_id
      })
      .select("*")
      .single();

    if (error) throw error;
    return jsonResponse({ command: data }, 201);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
