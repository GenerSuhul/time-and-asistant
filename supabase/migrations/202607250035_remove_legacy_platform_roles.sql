-- Production exposes exactly two platform roles:
--   * IT is always global and keeps full platform administration.
--   * RRHH keeps the module and company boundaries defined in migration 033.
-- Legacy platform roles are migrated before their definitions are removed.

do $$
declare
  it_role_id uuid;
  hr_role_id uuid;
begin
  select id into it_role_id from public.roles where key='it_admin';
  select id into hr_role_id from public.roles where key='hr_admin';

  if it_role_id is null or hr_role_id is null then
    raise exception 'ROLE_CONSOLIDATION_ABORTED: IT and RRHH roles must exist';
  end if;

  -- Every existing IT or legacy super-admin assignment becomes one global IT
  -- assignment. The expression unique index makes this idempotent.
  insert into public.user_roles(user_id,company_id,role_id)
  select distinct assignment.user_id,null::uuid,it_role_id
  from public.user_roles assignment
  join public.roles role on role.id=assignment.role_id
  where role.key in ('super_admin','it_admin')
  on conflict do nothing;

  delete from public.user_roles
  where role_id=it_role_id and company_id is not null;

  -- Preserve the already-defined RRHH scope while absorbing the two legacy
  -- operational roles. Company-scoped assignments stay company-scoped.
  insert into public.user_roles(user_id,company_id,role_id)
  select distinct assignment.user_id,assignment.company_id,hr_role_id
  from public.user_roles assignment
  join public.roles role on role.id=assignment.role_id
  where role.key in ('branch_manager','viewer')
  on conflict do nothing;

  -- Never apply the destructive part if production would be left without a
  -- global IT administrator.
  if not exists(
    select 1 from public.user_roles
    where role_id=it_role_id and company_id is null
  ) then
    raise exception 'ROLE_CONSOLIDATION_ABORTED: at least one global IT assignment is required';
  end if;

  delete from public.roles where key not in ('it_admin','hr_admin');

  update public.roles
  set name='IT',
      description='Acceso global completo a todos los módulos, usuarios, configuración y operación técnica.',
      updated_at=now()
  where id=it_role_id;

  update public.roles
  set name='RRHH',
      description='Personas, horarios, asignaciones, credenciales, asistencia y reportes según su alcance asignado.',
      updated_at=now()
  where id=hr_role_id;
end $$;

-- Keep the legacy compatibility RPC aligned with the only two surviving roles.
create or replace function public.get_attendance_daily_report(
  p_date date,
  p_branch_id uuid default null,
  p_employee_id uuid default null
)
returns setof public.attendance_report_rows
language sql
stable
security definer
set search_path=public
as $$
  select report.*
  from public.attendance_report_rows report
  where report.attendance_date=p_date
    and (p_branch_id is null or report.branch_id=p_branch_id)
    and (p_employee_id is null or report.employee_id=p_employee_id)
    and (
      exists(
        select 1
        from public.user_roles assignment
        join public.roles role on role.id=assignment.role_id
        where assignment.user_id=auth.uid()
          and assignment.company_id is null
          and role.key in ('it_admin','hr_admin')
      )
      or report.company_id in(
        select assignment.company_id
        from public.user_roles assignment
        join public.roles role on role.id=assignment.role_id
        where assignment.user_id=auth.uid()
          and assignment.company_id is not null
          and role.key='hr_admin'
      )
    )
  order by report.employee_name;
$$;

revoke all on function public.get_attendance_daily_report(date,uuid,uuid) from public,anon;
grant execute on function public.get_attendance_daily_report(date,uuid,uuid) to authenticated;

comment on table public.roles is
  'Platform roles. Production supports only it_admin (global) and hr_admin (configured HR scope).';
