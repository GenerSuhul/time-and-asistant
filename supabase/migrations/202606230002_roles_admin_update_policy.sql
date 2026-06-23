drop policy if exists "admin_update_roles" on public.roles;
create policy "admin_update_roles"
on public.roles for update
to authenticated
using (public.has_any_role(array['super_admin','it_admin']))
with check (public.has_any_role(array['super_admin','it_admin']));
