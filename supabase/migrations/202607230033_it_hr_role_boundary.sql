-- The operator-facing platform currently exposes exactly two assignable roles:
-- IT (full access) and RRHH (all HR/attendance/credential operations, excluding
-- platform users, technical commands, live events, audit and manual adjustments).
-- Legacy role rows remain for history, but existing assignments are migrated
-- without deleting production data and cannot be assigned by admin-users.

update public.roles
set name='IT',
    description='Acceso completo a todos los módulos, usuarios, configuración y operación técnica.',
    updated_at=now()
where key='it_admin';

update public.roles
set name='RRHH',
    description='Personas, horarios, asignaciones, credenciales, asistencia y reportes.',
    updated_at=now()
where key='hr_admin';

insert into public.audit_logs(action,table_name,record_id,old_values,new_values)
select 'ROLE_MIGRATION','user_roles',assignment.id,
  jsonb_build_object('role_key',source_role.key,'role_id',assignment.role_id),
  jsonb_build_object('role_key','it_admin','role_id',target_role.id)
from public.user_roles assignment
join public.roles source_role on source_role.id=assignment.role_id and source_role.key='super_admin'
cross join public.roles target_role
where target_role.key='it_admin'
  and not exists(
    select 1 from public.user_roles current_assignment
    where current_assignment.user_id=assignment.user_id
      and current_assignment.company_id is not distinct from assignment.company_id
      and current_assignment.role_id=target_role.id
  );

update public.user_roles assignment
set role_id=target_role.id,updated_at=now()
from public.roles source_role,public.roles target_role
where assignment.role_id=source_role.id
  and source_role.key='super_admin'
  and target_role.key='it_admin'
  and not exists(
    select 1 from public.user_roles current_assignment
    where current_assignment.user_id=assignment.user_id
      and current_assignment.company_id is not distinct from assignment.company_id
      and current_assignment.role_id=target_role.id
  );

insert into public.audit_logs(action,table_name,record_id,old_values,new_values)
select 'ROLE_MIGRATION','user_roles',assignment.id,
  jsonb_build_object('role_key',source_role.key,'role_id',assignment.role_id),
  jsonb_build_object('role_key','hr_admin','role_id',target_role.id)
from public.user_roles assignment
join public.roles source_role on source_role.id=assignment.role_id
  and source_role.key in ('branch_manager','viewer')
cross join public.roles target_role
where target_role.key='hr_admin'
  and not exists(
    select 1 from public.user_roles current_assignment
    where current_assignment.user_id=assignment.user_id
      and current_assignment.company_id is not distinct from assignment.company_id
      and current_assignment.role_id=target_role.id
  );

update public.user_roles assignment
set role_id=target_role.id,updated_at=now()
from public.roles source_role,public.roles target_role
where assignment.role_id=source_role.id
  and source_role.key in ('branch_manager','viewer')
  and target_role.key='hr_admin'
  and not exists(
    select 1 from public.user_roles current_assignment
    where current_assignment.user_id=assignment.user_id
      and current_assignment.company_id is not distinct from assignment.company_id
      and current_assignment.role_id=target_role.id
  );

-- A user can always read/update their own profile. Only IT can inspect or edit
-- another platform user's profile.
drop policy if exists "users_select_own_profile" on public.profiles;
create policy "users_select_own_profile"
on public.profiles for select to authenticated
using (id=auth.uid() or public.has_any_role(array['it_admin']));

drop policy if exists "users_update_own_profile" on public.profiles;
create policy "users_update_own_profile"
on public.profiles for update to authenticated
using (id=auth.uid() or public.has_any_role(array['it_admin']))
with check (id=auth.uid() or public.has_any_role(array['it_admin']));

-- RRHH needs its own assignment to resolve the current session role, but only
-- IT can list or mutate assignments belonging to other platform users.
drop policy if exists "admins_manage_user_roles" on public.user_roles;
drop policy if exists "user_roles_own_select" on public.user_roles;
drop policy if exists "it_manage_user_roles" on public.user_roles;
create policy "user_roles_own_select"
on public.user_roles for select to authenticated
using (user_id=auth.uid() or public.has_any_role(array['it_admin']));
create policy "it_manage_user_roles"
on public.user_roles for all to authenticated
using (public.has_any_role(array['it_admin']))
with check (public.has_any_role(array['it_admin']));

drop policy if exists "role_select" on public.roles;
drop policy if exists "roles_assigned_or_it_select" on public.roles;
create policy "roles_assigned_or_it_select"
on public.roles for select to authenticated
using (
  public.has_any_role(array['it_admin'])
  or exists(
    select 1 from public.user_roles assignment
    where assignment.user_id=auth.uid() and assignment.role_id=roles.id
  )
);

-- These tables back modules explicitly reserved for IT. Grants remain in place
-- for authenticated sessions; RLS is the authoritative boundary.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'attendance_events',
    'device_commands',
    'device_command_logs',
    'audit_logs',
    'manual_adjustments'
  ]
  loop
    execute format('drop policy if exists "role_select" on public.%I',table_name);
    execute format('drop policy if exists "admin_insert" on public.%I',table_name);
    execute format('drop policy if exists "admin_update" on public.%I',table_name);
    execute format('drop policy if exists "admin_delete" on public.%I',table_name);
    execute format('drop policy if exists "it_only_access" on public.%I',table_name);
    execute format(
      'create policy "it_only_access" on public.%I for all to authenticated using (public.has_any_role(array[''it_admin''])) with check (public.has_any_role(array[''it_admin'']))',
      table_name
    );
  end loop;
end $$;

drop policy if exists "admins_insert_audit_logs" on public.audit_logs;

comment on policy "it_only_access" on public.device_commands is
  'RRHH operates employee credential repairs through admin-employees but cannot read or create arbitrary device commands.';
