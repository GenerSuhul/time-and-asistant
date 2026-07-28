-- Historical late-arrivals analytics.
-- The report uses daily_attendance.late_minutes, which is calculated after the
-- configured check-in tolerance. A late arrival is therefore retained even if
-- the final daily status later becomes "incomplete".

create index if not exists daily_attendance_late_history_idx
  on public.daily_attendance(attendance_date desc,branch_id,employee_id)
  include (late_minutes,actual_check_in,expected_check_in,rule_id)
  where late_minutes > 0;

create or replace function public.get_late_arrivals_report_filters()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
  with access as (
    select
      exists(
        select 1
        from public.user_roles assignment
        join public.roles role on role.id=assignment.role_id
        where assignment.user_id=auth.uid()
          and assignment.company_id is null
          and role.key in ('it_admin','hr_admin')
      ) as is_global,
      coalesce(
        array_agg(distinct assignment.company_id)
          filter (where assignment.company_id is not null and role.key='hr_admin'),
        '{}'::uuid[]
      ) as company_ids
    from public.user_roles assignment
    join public.roles role on role.id=assignment.role_id
    where assignment.user_id=auth.uid()
  ),
  allowed_companies as (
    select company.id,company.name
    from public.companies company
    cross join access
    where access.is_global or company.id=any(access.company_ids)
  )
  select jsonb_build_object(
    'companies',coalesce((
      select jsonb_agg(
        jsonb_build_object('id',company.id,'name',company.name)
        order by company.name
      )
      from allowed_companies company
    ),'[]'::jsonb),
    'branches',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',branch.id,
          'company_id',branch.company_id,
          'name',branch.name
        )
        order by branch.name
      )
      from public.branches branch
      join allowed_companies company on company.id=branch.company_id
      where branch.is_active
    ),'[]'::jsonb),
    'departments',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',department.id,
          'company_id',department.company_id,
          'name',department.name
        )
        order by department.name
      )
      from public.departments department
      join allowed_companies company on company.id=department.company_id
      where department.is_active
    ),'[]'::jsonb),
    'employees',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',employee.id,
          'company_id',employee.company_id,
          'branch_id',employee.branch_id,
          'department_id',employee.department_id,
          'employee_code',employee.employee_code,
          'full_name',employee.full_name
        )
        order by employee.full_name
      )
      from public.employees employee
      join allowed_companies company on company.id=employee.company_id
      where employee.status='active'
    ),'[]'::jsonb)
  );
$$;

revoke all on function public.get_late_arrivals_report_filters() from public,anon;
grant execute on function public.get_late_arrivals_report_filters() to authenticated;

create or replace function public.get_late_arrivals_report(
  p_start_date date,
  p_end_date date,
  p_company_id uuid default null,
  p_branch_id uuid default null,
  p_department_id uuid default null,
  p_employee_id uuid default null,
  p_min_late_minutes integer default 1,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  range_days integer;
  safe_page integer;
  safe_page_size integer;
  bucket_kind text;
  result jsonb;
begin
  if p_start_date is null or p_end_date is null then
    raise exception using message='Debes indicar las fechas de inicio y fin.';
  end if;
  if p_end_date < p_start_date then
    raise exception using message='La fecha final no puede ser anterior a la fecha inicial.';
  end if;

  range_days := p_end_date-p_start_date+1;
  if range_days > 1827 then
    raise exception using message='El período máximo permitido es de cinco años.';
  end if;
  if coalesce(p_min_late_minutes,0) < 1 or p_min_late_minutes > 1440 then
    raise exception using message='El mínimo de tardanza debe estar entre 1 y 1440 minutos.';
  end if;

  safe_page := greatest(coalesce(p_page,1),1);
  safe_page_size := least(greatest(coalesce(p_page_size,25),10),100);
  bucket_kind := case
    when range_days <= 45 then 'day'
    when range_days <= 180 then 'week'
    else 'month'
  end;

  with access as (
    select
      exists(
        select 1
        from public.user_roles assignment
        join public.roles role on role.id=assignment.role_id
        where assignment.user_id=auth.uid()
          and assignment.company_id is null
          and role.key in ('it_admin','hr_admin')
      ) as is_global,
      coalesce(
        array_agg(distinct assignment.company_id)
          filter (where assignment.company_id is not null and role.key='hr_admin'),
        '{}'::uuid[]
      ) as company_ids
    from public.user_roles assignment
    join public.roles role on role.id=assignment.role_id
    where assignment.user_id=auth.uid()
  ),
  late_rows as materialized (
    select
      daily.id,
      daily.attendance_date,
      daily.employee_id,
      employee.employee_code,
      employee.full_name as employee_name,
      employee.company_id,
      company.name as company_name,
      daily.branch_id,
      coalesce(branch.name,'Sin tienda asignada') as branch_name,
      employee.department_id,
      coalesce(department.name,'Sin departamento') as department_name,
      daily.rule_id,
      rule.name as rule_name,
      daily.expected_check_in,
      daily.actual_check_in,
      daily.late_minutes
    from public.daily_attendance daily
    join public.employees employee on employee.id=daily.employee_id
    join public.companies company on company.id=employee.company_id
    left join public.branches branch on branch.id=daily.branch_id
    left join public.departments department on department.id=employee.department_id
    left join public.attendance_report_rules rule on rule.id=daily.rule_id
    cross join access
    where daily.attendance_date between p_start_date and p_end_date
      and daily.late_minutes >= p_min_late_minutes
      and (access.is_global or employee.company_id=any(access.company_ids))
      and (p_company_id is null or employee.company_id=p_company_id)
      and (p_branch_id is null or daily.branch_id=p_branch_id)
      and (p_department_id is null or employee.department_id=p_department_id)
      and (p_employee_id is null or daily.employee_id=p_employee_id)
  ),
  summary as (
    select
      count(*)::integer as total_late_arrivals,
      count(distinct employee_id)::integer as affected_employees,
      count(distinct branch_id)::integer as affected_branches,
      coalesce(round(avg(late_minutes),1),0) as average_late_minutes,
      coalesce(sum(late_minutes),0)::integer as total_late_minutes,
      coalesce(max(late_minutes),0)::integer as maximum_late_minutes
    from late_rows
  ),
  trend_rows as (
    select
      case bucket_kind
        when 'day' then date_trunc('day',attendance_date::timestamp)::date
        when 'week' then date_trunc('week',attendance_date::timestamp)::date
        else date_trunc('month',attendance_date::timestamp)::date
      end as bucket_start,
      count(*)::integer as late_arrivals,
      count(distinct employee_id)::integer as employees,
      sum(late_minutes)::integer as total_minutes,
      round(avg(late_minutes),1) as average_minutes
    from late_rows
    group by 1
  ),
  employee_ranking as (
    select
      employee_id,
      employee_code,
      employee_name,
      min(branch_name) as branch_name,
      count(*)::integer as late_arrivals,
      sum(late_minutes)::integer as total_minutes,
      round(avg(late_minutes),1) as average_minutes,
      max(late_minutes)::integer as maximum_minutes
    from late_rows
    group by employee_id,employee_code,employee_name
    order by count(*) desc,sum(late_minutes) desc,employee_name
    limit 10
  ),
  branch_ranking as (
    select
      branch_id,
      branch_name,
      count(*)::integer as late_arrivals,
      count(distinct employee_id)::integer as employees,
      sum(late_minutes)::integer as total_minutes,
      round(avg(late_minutes),1) as average_minutes
    from late_rows
    group by branch_id,branch_name
    order by count(*) desc,sum(late_minutes) desc,branch_name
    limit 10
  ),
  page_rows as (
    select *
    from late_rows
    order by attendance_date desc,late_minutes desc,employee_name
    offset (safe_page-1)*safe_page_size
    limit safe_page_size
  )
  select jsonb_build_object(
    'meta',jsonb_build_object(
      'start_date',p_start_date,
      'end_date',p_end_date,
      'bucket',bucket_kind,
      'page',safe_page,
      'page_size',safe_page_size,
      'total_rows',(select total_late_arrivals from summary)
    ),
    'summary',(select to_jsonb(summary) from summary),
    'trend',coalesce((
      select jsonb_agg(to_jsonb(trend) order by trend.bucket_start)
      from trend_rows trend
    ),'[]'::jsonb),
    'employee_ranking',coalesce((
      select jsonb_agg(to_jsonb(employee_rank))
      from employee_ranking employee_rank
    ),'[]'::jsonb),
    'branch_ranking',coalesce((
      select jsonb_agg(to_jsonb(branch_rank))
      from branch_ranking branch_rank
    ),'[]'::jsonb),
    'rows',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',page_row.id,
          'attendance_date',page_row.attendance_date,
          'employee_id',page_row.employee_id,
          'employee_code',page_row.employee_code,
          'employee_name',page_row.employee_name,
          'company_name',page_row.company_name,
          'branch_name',page_row.branch_name,
          'department_name',page_row.department_name,
          'rule_name',page_row.rule_name,
          'expected_check_in',
            case when page_row.expected_check_in is null then null
              else to_char(page_row.expected_check_in,'HH24:MI') end,
          'actual_check_in',page_row.actual_check_in,
          'actual_check_in_label',
            case when page_row.actual_check_in is null then null
              else to_char(page_row.actual_check_in at time zone 'America/Guatemala','HH12:MI AM') end,
          'late_minutes',page_row.late_minutes
        )
        order by page_row.attendance_date desc,page_row.late_minutes desc,page_row.employee_name
      )
      from page_rows page_row
    ),'[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

revoke all on function public.get_late_arrivals_report(date,date,uuid,uuid,uuid,uuid,integer,integer,integer)
  from public,anon;
grant execute on function public.get_late_arrivals_report(date,date,uuid,uuid,uuid,uuid,integer,integer,integer)
  to authenticated;
