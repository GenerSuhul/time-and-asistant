import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.FIRST_ADMIN_EMAIL;
const password = process.env.FIRST_ADMIN_PASSWORD;

if (!url || !serviceRoleKey || !email) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and FIRST_ADMIN_EMAIL are required");
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

let userId;

const { data: users, error: listError } = await supabase.auth.admin.listUsers();
if (listError) throw listError;

const existing = users.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
if (existing) {
  userId = existing.id;
} else {
  if (!password) throw new Error("FIRST_ADMIN_PASSWORD is required when the user does not exist");
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "First Admin" }
  });
  if (error) throw error;
  userId = data.user.id;
}

const { data: role, error: roleError } = await supabase.from("roles").select("id").eq("key", "super_admin").single();
if (roleError) throw roleError;

const { data: existingAssignment, error: existingError } = await supabase
  .from("user_roles")
  .select("id")
  .eq("user_id", userId)
  .eq("role_id", role.id)
  .is("company_id", null)
  .maybeSingle();
if (existingError) throw existingError;

const { error: assignError } = existingAssignment
  ? { error: null }
  : await supabase
      .from("user_roles")
      .insert({ user_id: userId, role_id: role.id, company_id: null });
if (assignError) throw assignError;

console.log(`super_admin assigned to ${email}`);
