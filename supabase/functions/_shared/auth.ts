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

  // Hosted Functions validate JWTs before invocation (verify_jwt=true). Supabase can
  // expose a rotated service key to the runtime while internal services still use a
  // valid legacy service-role JWT, so recognize the already-verified role claim.
  if (token && jwtRole(token) === "service_role") {
    return { type: "service_role", user_id: null };
  }

  if (!token) throw new Error("Missing Authorization header");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error("Unauthorized");
  return { type: "user", user_id: data.user.id };
}

function jwtRole(token: string) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(normalized))?.role ?? null;
  } catch {
    return null;
  }
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
