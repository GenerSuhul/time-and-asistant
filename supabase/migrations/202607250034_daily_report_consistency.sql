-- Keep the daily report authorization aligned with the two production roles.
-- IT and RRHH assignments with no company are global; company-scoped
-- assignments continue to see only their own companies.
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
          and role.key in ('super_admin','it_admin','hr_admin')
      )
      or report.company_id in(
        select assignment.company_id
        from public.user_roles assignment
        where assignment.user_id=auth.uid()
          and assignment.company_id is not null
      )
    )
  order by report.employee_name;
$$;

revoke all on function public.get_attendance_daily_report(date,uuid,uuid) from public,anon;
grant execute on function public.get_attendance_daily_report(date,uuid,uuid) to authenticated;

-- devices_total is a stored invariant, not a presentation fallback. Older
-- deployed attendance-sync versions left it at zero even after the worker had
-- processed devices, which produced messages such as "17 de 0".
create or replace function public.normalize_attendance_sync_job_totals()
returns trigger
language plpgsql
set search_path=public
as $$
declare
  result_count integer;
begin
  result_count:=case
    when jsonb_typeof(coalesce(new.device_results,'[]'::jsonb))='array'
      then jsonb_array_length(coalesce(new.device_results,'[]'::jsonb))
    else 0
  end;
  new.devices_total:=greatest(
    coalesce(new.devices_total,0),
    coalesce(cardinality(new.device_ids),0),
    coalesce(new.devices_done,0),
    result_count
  );
  return new;
end;
$$;

drop trigger if exists normalize_attendance_sync_job_totals on public.attendance_sync_jobs;
create trigger normalize_attendance_sync_job_totals
before insert or update of device_ids,device_results,devices_total,devices_done
on public.attendance_sync_jobs
for each row execute function public.normalize_attendance_sync_job_totals();

update public.attendance_sync_jobs
set devices_total=greatest(
  devices_total,
  coalesce(cardinality(device_ids),0),
  devices_done,
  case when jsonb_typeof(coalesce(device_results,'[]'::jsonb))='array'
    then jsonb_array_length(coalesce(device_results,'[]'::jsonb))
    else 0 end
)
where devices_total<greatest(
  coalesce(cardinality(device_ids),0),
  devices_done,
  case when jsonb_typeof(coalesce(device_results,'[]'::jsonb))='array'
    then jsonb_array_length(coalesce(device_results,'[]'::jsonb))
    else 0 end
);

comment on function public.normalize_attendance_sync_job_totals() is
  'Maintains the real eligible/consulted device total used by attendance synchronization summaries.';
