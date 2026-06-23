type SupabaseClientLike = any;

export type FunctionActor =
  | { type: "service_role"; user_id: null }
  | { type: "user"; user_id: string };

function bearerToken(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

export async function requireActor(req: Request, supabase: SupabaseClientLike): Promise<FunctionActor> {
  const token = bearerToken(req);
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (token && serviceRoleKey && token === serviceRoleKey) {
    return { type: "service_role", user_id: null };
  }

  if (!token) throw new Error("Missing Authorization header");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error("Unauthorized");
  return { type: "user", user_id: data.user.id };
}

export async function requireRole(req: Request, supabase: SupabaseClientLike, allowedRoles: string[]) {
  const actor = await requireActor(req, supabase);
  if (actor.type === "service_role") return actor;

  const { data, error } = await supabase
    .from("user_roles")
    .select("roles:role_id(key)")
    .eq("user_id", actor.user_id);
  if (error) throw error;

  const hasRole = (data ?? []).some((row) => {
    const roles = Array.isArray(row.roles) ? row.roles : [row.roles];
    return roles.some((role) => role?.key && allowedRoles.includes(role.key));
  });
  if (!hasRole) throw new Error("Forbidden: missing required role");
  return actor;
}
