import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const schema = z.object({
  action: z.enum(["create_user", "update_user"]),
  user_id: z.string().uuid().optional(),
  email: z.string().email(),
  password: z.string().min(8).optional(),
  full_name: z.string().min(2),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  company_id: z.string().uuid().nullable().optional(),
  role_company_id: z.string().uuid().nullable().optional(),
  role_ids: z.array(z.string().uuid()).min(1)
});

async function assertRolesExist(supabase: ReturnType<typeof serviceClient>, roleIds: string[]) {
  const { data, error } = await supabase.from("roles").select("id").in("id", roleIds);
  if (error) throw error;
  if ((data ?? []).length !== new Set(roleIds).size) {
    throw new Error("Uno o mas roles seleccionados no existen en la base de datos");
  }
}

async function replaceRoles(
  supabase: ReturnType<typeof serviceClient>,
  userId: string,
  roleIds: string[],
  companyId: string | null | undefined
) {
  await assertRolesExist(supabase, roleIds);

  const { error: deleteError } = await supabase.from("user_roles").delete().eq("user_id", userId);
  if (deleteError) throw deleteError;

  const rows = roleIds.map((role_id) => ({
    user_id: userId,
    role_id,
    company_id: companyId ?? null
  }));
  const { error: insertError } = await supabase.from("user_roles").insert(rows);
  if (insertError) throw insertError;
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const payload = schema.parse(await req.json());
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin"]);

    if (payload.action === "create_user") {
      if (!payload.password) throw new Error("Password is required when creating a user");

      const { data: created, error: createError } = await supabase.auth.admin.createUser({
        email: payload.email,
        password: payload.password,
        email_confirm: true,
        user_metadata: { full_name: payload.full_name }
      });
      if (createError) {
        const message = createError.message.toLowerCase();
        if (message.includes("already") || message.includes("registered") || message.includes("exists")) {
          throw new Error("Este correo ya existe. Usa el boton editar del usuario existente.");
        }
        throw createError;
      }
      if (!created.user) throw new Error("User was not created");

      const { error: profileError } = await supabase.from("profiles").upsert({
        id: created.user.id,
        email: payload.email,
        full_name: payload.full_name,
        status: payload.status,
        company_id: payload.company_id ?? null
      });
      if (profileError) throw profileError;

      await replaceRoles(supabase, created.user.id, payload.role_ids, payload.role_company_id);
      return jsonResponse({ user_id: created.user.id }, 201);
    }

    if (!payload.user_id) throw new Error("user_id is required when updating a user");

    const { error: authError } = await supabase.auth.admin.updateUserById(payload.user_id, {
      email: payload.email,
      user_metadata: { full_name: payload.full_name }
    });
    if (authError) throw authError;

    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        email: payload.email,
        full_name: payload.full_name,
        status: payload.status,
        company_id: payload.company_id ?? null
      })
      .eq("id", payload.user_id);
    if (profileError) throw profileError;

    await replaceRoles(supabase, payload.user_id, payload.role_ids, payload.role_company_id);
    return jsonResponse({ user_id: payload.user_id });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
