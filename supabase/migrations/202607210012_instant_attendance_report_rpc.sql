-- One indexed database round trip for the authenticated daily report.
create or replace view public.attendance_report_rows with (security_invoker=true) as
select da.id, da.employee_id, e.company_id, da.branch_id, e.department_id, e.attendance_group_id,
  d.name as department, ag.name as attendance_group, e.full_name as employee_name,
  da.attendance_date, da.actual_check_in, da.actual_check_out,
  case when da.actual_check_in is null then 'Ninguno' else to_char(da.actual_check_in at time zone 'America/Guatemala','HH24:MI:SS') end as check_in_record,
  case when da.actual_check_out is null then 'Ninguno' else to_char(da.actual_check_out at time zone 'America/Guatemala','HH24:MI:SS') end as check_out_record,
  da.worked_minutes as attendance_minutes, da.lunch_minutes as break_minutes, da.break_records,
  case when da.actual_check_in is null or da.actual_check_out is null then '-'
    else to_char(da.actual_check_in at time zone 'America/Guatemala','HH24:MI')||' - '||to_char(da.actual_check_out at time zone 'America/Guatemala','HH24:MI') end as time_period,
  da.status, da.warnings, da.device_ids, da.calculated_at
from public.daily_attendance da join public.employees e on e.id=da.employee_id
left join public.departments d on d.id=e.department_id
left join public.attendance_groups ag on ag.id=e.attendance_group_id;

grant select on public.attendance_report_rows to authenticated, service_role;

create or replace function public.get_attendance_daily_report(
  p_date date,
  p_branch_id uuid default null,
  p_employee_id uuid default null
)
returns setof public.attendance_report_rows
language sql
stable
security definer
set search_path = public
as $$
  select report.*
  from public.attendance_report_rows report
  where report.attendance_date = p_date
    and (p_branch_id is null or report.branch_id = p_branch_id)
    and (p_employee_id is null or report.employee_id = p_employee_id)
    and (
      exists (
        select 1
        from public.user_roles ur
        join public.roles role on role.id = ur.role_id
        where ur.user_id = auth.uid()
          and role.key = 'super_admin'
          and ur.company_id is null
      )
      or report.company_id in (
        select ur.company_id
        from public.user_roles ur
        where ur.user_id = auth.uid() and ur.company_id is not null
      )
    )
  order by report.employee_name;
$$;

revoke all on function public.get_attendance_daily_report(date,uuid,uuid) from public, anon;
grant execute on function public.get_attendance_daily_report(date,uuid,uuid) to authenticated;

comment on function public.get_attendance_daily_report(date,uuid,uuid) is
  'Returns an RLS-scoped cached daily report in one database round trip; never contacts DeviceGateway.';
