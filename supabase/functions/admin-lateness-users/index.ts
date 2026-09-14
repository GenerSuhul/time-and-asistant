import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.1";
import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";

const input = z.object({
  action: z.enum(["create_user", "update_user"]),
  user_id: z.string().uuid().optional(),
  email: z.string().email(), full_name: z.string().trim().min(2),
  password: z.string().min(12).optional(),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  company_id: z.string().uuid(),
  region_ids: z.array(z.string().uuid()).max(100),
  branch_ids: z.array(z.string().uuid()).max(500)
}).refine((v) => v.region_ids.length + v.branch_ids.length > 0, "Selecciona una región o sucursal")
  .refine((v) => v.action === "create_user" ? Boolean(v.password) : Boolean(v.user_id), "Faltan datos de usuario");

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let createdId: string | null = null;
  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    // Authenticate with Auth, never trust an unverified role claim.
    const actor = await admin.auth.getUser(token);
    if (actor.error || !actor.data.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const roles = await admin.from("user_roles").select("roles:role_id(key)").eq("user_id", actor.data.user.id);
    if (roles.error) throw roles.error;
    const roleKeys = (roles.data ?? []).flatMap((row) => (Array.isArray(row.roles) ? row.roles : [row.roles])).map((role) => role?.key);
    if (!roleKeys.some((key) => ["super_admin", "it_admin", "hr_admin"].includes(key))) return jsonResponse({ error: "Forbidden" }, 403);
    const payload = input.parse(await req.json());
    if (payload.action === "update_user") {
      const target = await admin.from("user_roles").select("roles:role_id(key)").eq("user_id", payload.user_id!);
      if (target.error) throw target.error;
      const targetKeys = (target.data ?? []).flatMap((row) => Array.isArray(row.roles) ? row.roles : [row.roles]).map((role) => role?.key);
      if (!targetKeys.length || targetKeys.some((key) => key !== "regional_lateness_viewer")) return jsonResponse({ error: "Este módulo solo edita supervisores regionales." }, 403);
    }
    let userId = payload.user_id;
    if (payload.action === "create_user") {
      const created = await admin.auth.admin.createUser({ email: payload.email, password: payload.password, email_confirm: true, user_metadata: { full_name: payload.full_name } });
      if (created.error) throw created.error;
      userId = created.data.user.id;
      createdId = userId;
    }
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const scope = await caller.rpc("set_regional_lateness_scope", { p_user_id: userId, p_company_id: payload.company_id, p_region_ids: payload.region_ids, p_branch_ids: payload.branch_ids });
    if (scope.error) throw scope.error;
    const profile = await admin.from("profiles").upsert({ id: userId, email: payload.email, full_name: payload.full_name, company_id: payload.company_id, status: payload.status });
    if (profile.error) throw profile.error;
    if (payload.action === "update_user") {
      const updated = await admin.auth.admin.updateUserById(userId!, { email: payload.email, user_metadata: { full_name: payload.full_name } });
      if (updated.error) throw updated.error;
    }
    createdId = null;
    return jsonResponse({ user_id: userId }, payload.action === "create_user" ? 201 : 200);
  } catch (error) {
    // Roll back only the brand-new account created by this request, never an
    // existing user. Auth cascades clean up its new role/scope records.
    if (createdId) {
      const cleanup = await admin.auth.admin.deleteUser(createdId);
      if (cleanup.error) console.error("Supervisor creation cleanup failed", createdId);
    }
    return jsonResponse({ error: error instanceof Error ? error.message : "No se pudo guardar el supervisor" }, 400);
  }
});
