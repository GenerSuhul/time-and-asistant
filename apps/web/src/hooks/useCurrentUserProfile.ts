import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export type CurrentUserProfile = {
  user: {
    id: string;
    email?: string | null;
    user_metadata?: Record<string, unknown>;
  };
  profile: {
    id: string;
    email: string | null;
    full_name: string | null;
    status: string;
    company_id: string | null;
    companies?: { id: string; name: string } | null;
  } | null;
  roles: Array<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    company_id: string | null;
    company_name: string | null;
  }>;
};

function normalizeOne<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function displayName(data?: CurrentUserProfile) {
  const metadataName = data?.user.user_metadata?.full_name;
  return data?.profile?.full_name || (typeof metadataName === "string" ? metadataName : "") || data?.user.email || "Usuario";
}

export function useCurrentUserProfile() {
  return useQuery({
    queryKey: ["current-user-profile"],
    queryFn: async (): Promise<CurrentUserProfile> => {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const user = userData.user;
      if (!user) throw new Error("Sesion no encontrada");

      const [profileResult, rolesResult] = await Promise.all([
        supabase.from("profiles").select("id,email,full_name,status,company_id,companies:company_id(id,name)").eq("id", user.id).maybeSingle(),
        supabase
          .from("user_roles")
          .select("company_id,roles:role_id(id,key,name,description),companies:company_id(id,name)")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
      ]);

      if (profileResult.error) throw profileResult.error;
      if (rolesResult.error) throw rolesResult.error;

      return {
        user,
        profile: profileResult.data as CurrentUserProfile["profile"],
        roles: (rolesResult.data ?? []).map((assignment) => {
          const role = normalizeOne(assignment.roles);
          const company = normalizeOne(assignment.companies);
          return {
            id: role?.id ?? "",
            key: role?.key ?? "",
            name: role?.name ?? "",
            description: role?.description ?? null,
            company_id: assignment.company_id ?? null,
            company_name: company?.name ?? null
          };
        }).filter((role) => role.id)
      };
    }
  });
}
