import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const baseUserSchema = z.object({
  email: z.string().email(),
  full_name: z.string().min(2),
  status: z.enum(["active", "inactive", "suspended"]).default("active"),
  company_id: z.string().uuid().nullable().optional(),
  role_company_id: z.string().uuid().nullable().optional(),
  role_ids: z.array(z.string().uuid()).length(1)
});

const schema = z.discriminatedUnion("action", [
  baseUserSchema.extend({
    action: z.literal("create_user"),
    password: z.string().min(8)
  }),
  baseUserSchema.extend({
    action: z.literal("update_user"),
    user_id: z.string().uuid()
  })
]);

function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

async function assertRolesExist(supabase: ReturnType<typeof serviceClient>, roleIds: string[]) {
  const { data, error } = await supabase.from("roles").select("id,key")
    .in("id", roleIds).in("key", ["it_admin", "hr_admin"]);
  if (error) throw error;
  if ((data ?? []).length !== new Set(roleIds).size) {
    throw new Error("Solo se pueden asignar los roles IT o RRHH.");
  }
}

async function assertDoesNotRemoveLastItAdmin(
  supabase: ReturnType<typeof serviceClient>,
  userId: string,
  roleIds: string[]
) {
  const { data: itAdminRole, error: roleError } = await supabase
    .from("roles")
    .select("id")
    .eq("key", "it_admin")
    .single();
  if (roleError) throw roleError;
  if (roleIds.includes(itAdminRole.id)) return;

  const { count, error } = await supabase
    .from("user_roles")
    .select("id", { count: "exact", head: true })
    .eq("role_id", itAdminRole.id)
    .neq("user_id", userId);
  if (error) throw error;
  if ((count ?? 0) === 0) {
    throw new Error("No puedes quitar el último usuario con rol IT.");
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

    await assertDoesNotRemoveLastItAdmin(supabase, payload.user_id, payload.role_ids);

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
    return jsonResponse({ error: errorMessage(error) }, 400);
  }
});
