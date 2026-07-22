-- Start an employee draft in one authenticated database round-trip.
-- Authorization, duplicate detection and insert remain atomic and server-side.

create or replace function public.admin_start_employee_creation_session(
  p_employee jsonb,
  p_trace_id uuid
) returns public.employee_creation_sessions
language plpgsql security definer set search_path=public as $$
declare
  actor uuid:=auth.uid();
  company uuid:=(p_employee->>'company_id')::uuid;
  branch uuid:=nullif(p_employee->>'branch_id','')::uuid;
  department uuid:=nullif(p_employee->>'department_id','')::uuid;
  requested_code text:=trim(p_employee->>'employee_code');
  employee_no text:=coalesce(nullif(trim(p_employee->>'external_employee_id'),''),requested_code);
  saved public.employee_creation_sessions;
begin
  if actor is null or not public.has_any_role(array['super_admin','it_admin','hr_admin']) then
    raise exception 'FORBIDDEN';
  end if;
  if branch is not null and not exists(select 1 from public.branches where id=branch and company_id=company) then
    raise exception 'BRANCH_COMPANY_MISMATCH';
  end if;
  if department is not null and (branch is null or not exists(
    select 1 from public.department_branches where department_id=department and branch_id=branch
  )) then
    raise exception 'DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH';
  end if;
  if exists(
    select 1 from public.employees employee
    where employee.company_id=company and (employee.employee_code=requested_code or employee.external_employee_id=employee_no)
  ) then
    raise exception 'EMPLOYEE_NO_ALREADY_EXISTS';
  end if;

  insert into public.employee_creation_sessions(
    company_id,branch_id,department_id,employee_no,full_name,draft_data,requested_by,trace_id
  ) values (
    company,branch,department,employee_no,trim(p_employee->>'full_name'),p_employee,actor,p_trace_id
  ) returning * into saved;
  return saved;
end $$;

revoke all on function public.admin_start_employee_creation_session(jsonb,uuid) from public,anon;
grant execute on function public.admin_start_employee_creation_session(jsonb,uuid) to authenticated;

comment on function public.admin_start_employee_creation_session(jsonb,uuid) is
  'Atomically authorizes and creates a staged employee draft using the caller JWT.';
