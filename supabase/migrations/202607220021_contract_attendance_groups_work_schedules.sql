-- Contract phase. Apply only after all application consumers use attendance_report_rules.
-- Pre-contract data is retained in migration_snapshots with migration_key 202607220019.

do $$
begin
  if not exists(select 1 from public.migration_snapshots where migration_key='202607220019' and table_name='attendance_groups')
    or not exists(select 1 from public.migration_snapshots where migration_key='202607220019' and table_name='work_schedules')
    or not exists(select 1 from public.migration_snapshots where migration_key='202607220019' and table_name='schedule_rules') then
    raise exception 'Required migration snapshots are missing';
  end if;
end $$;

drop function if exists public.get_attendance_daily_report(date,uuid,uuid);
drop view if exists public.attendance_report_rows;
drop function if exists public.admin_save_employee(jsonb,uuid[],uuid,uuid);

alter table public.employees drop column if exists attendance_group_id;
alter table public.daily_attendance drop column if exists schedule_id;
alter table public.departments drop column if exists branch_id;
drop table if exists public.schedule_rules;
drop table if exists public.work_schedules;
drop table if exists public.attendance_groups;

create or replace function public.admin_save_employee(
  p_employee jsonb,
  p_device_ids uuid[],
  p_requested_by uuid,
  p_employee_id uuid default null
) returns public.employees
language plpgsql security definer set search_path=public as $$
declare
  saved public.employees; previous public.employees; target uuid; removed uuid;
  old_devices uuid[]:='{}'::uuid[]; external_id text; old_external_id text; safe_metadata jsonb;
  person_changed boolean:=true; card_changed boolean:=true; external_changed boolean:=false; existed boolean;
  desired_command public.device_command_type; person_payload jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  safe_metadata:=coalesce(p_employee->'metadata','{}'::jsonb)-'fingerData'-'finger_data'-'template'-'password'-'secret'-'device_key'-'service_role';
  external_id:=coalesce(nullif(trim(p_employee->>'external_employee_id'),''),trim(p_employee->>'employee_code'));
  if nullif(p_employee->>'department_id','') is not null and nullif(p_employee->>'branch_id','') is not null
    and not exists(select 1 from public.department_branches where department_id=(p_employee->>'department_id')::uuid and branch_id=(p_employee->>'branch_id')::uuid)
    then raise exception 'DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH'; end if;

  if p_employee_id is null then
    insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,full_name,email,phone,
      document_number,status,card_number,pin_enabled,hired_at,terminated_at,access_valid_from,access_valid_to,metadata,credential_status)
    values((p_employee->>'company_id')::uuid,nullif(p_employee->>'branch_id','')::uuid,nullif(p_employee->>'department_id','')::uuid,
      trim(p_employee->>'employee_code'),external_id,trim(p_employee->>'full_name'),nullif(trim(p_employee->>'email'),''),
      nullif(trim(p_employee->>'phone'),''),nullif(trim(p_employee->>'document_number'),''),(p_employee->>'status')::public.employee_status,
      nullif(trim(p_employee->>'card_number'),''),coalesce((p_employee->>'pin_enabled')::boolean,false),nullif(p_employee->>'hired_at','')::date,
      nullif(p_employee->>'terminated_at','')::date,nullif(p_employee->>'access_valid_from','')::date,nullif(p_employee->>'access_valid_to','')::date,
      safe_metadata,jsonb_build_object('card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
        'fingerprint','none','face','none','pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end))
    returning * into saved;
    old_external_id:=external_id;
  else
    select * into previous from public.employees where id=p_employee_id for update;
    if not found then raise exception 'employee not found'; end if;
    old_external_id:=coalesce(previous.external_employee_id,previous.employee_code);
    select coalesce(array_agg(device_id),'{}'::uuid[]) into old_devices from public.employee_devices where employee_id=p_employee_id;
    update public.employees set company_id=(p_employee->>'company_id')::uuid,branch_id=nullif(p_employee->>'branch_id','')::uuid,
      department_id=nullif(p_employee->>'department_id','')::uuid,employee_code=trim(p_employee->>'employee_code'),external_employee_id=external_id,
      full_name=trim(p_employee->>'full_name'),email=nullif(trim(p_employee->>'email'),''),phone=nullif(trim(p_employee->>'phone'),''),
      document_number=nullif(trim(p_employee->>'document_number'),''),status=(p_employee->>'status')::public.employee_status,
      card_number=nullif(trim(p_employee->>'card_number'),''),pin_enabled=coalesce((p_employee->>'pin_enabled')::boolean,false),
      hired_at=nullif(p_employee->>'hired_at','')::date,terminated_at=nullif(p_employee->>'terminated_at','')::date,
      access_valid_from=nullif(p_employee->>'access_valid_from','')::date,access_valid_to=nullif(p_employee->>'access_valid_to','')::date,metadata=safe_metadata,
      credential_status=jsonb_build_object('card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
        'fingerprint',fingerprint_status,'face',face_status,'pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end)
    where id=p_employee_id returning * into saved;
    external_changed:=old_external_id is distinct from external_id;
    person_changed:=external_changed or previous.full_name is distinct from saved.full_name
      or previous.access_valid_from is distinct from saved.access_valid_from or previous.access_valid_to is distinct from saved.access_valid_to;
    card_changed:=previous.card_number is distinct from saved.card_number;
  end if;

  person_payload:=jsonb_build_object('employee_no',external_id,'name',saved.full_name,
    'valid_from',coalesce(saved.access_valid_from::text,'2020-01-01')||'T00:00:00',
    'valid_to',coalesce(saved.access_valid_to::text,'2037-12-31')||'T23:59:59');
  foreach target in array coalesce(p_device_ids,'{}'::uuid[]) loop
    existed:=target=any(old_devices);
    insert into public.employee_devices(employee_id,device_id,external_person_id,sync_status,last_error)
    values(saved.id,target,external_id,case when not existed or person_changed or card_changed then 'pending'::public.command_status else 'success'::public.command_status end,null)
    on conflict(employee_id,device_id) do update set external_person_id=excluded.external_person_id,
      sync_status=case when person_changed or card_changed then 'pending'::public.command_status else public.employee_devices.sync_status end,
      last_error=case when person_changed or card_changed then null else public.employee_devices.last_error end;

    if external_changed and existed then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target,saved.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',old_external_id));
    end if;
    if not existed or person_changed then
      desired_command:=case when not existed or external_changed then 'sync_person'::public.device_command_type else 'update_person'::public.device_command_type end;
      update public.device_commands set payload=person_payload,command_type=desired_command,requested_by=p_requested_by,next_run_at=now(),error_message=null
      where id=(select id from public.device_commands where device_id=target and employee_id=saved.id
        and command_type in ('sync_person','update_person') and status='pending'
        and created_at>coalesce((select max(created_at) from public.device_commands where device_id=target and command_type='delete_person' and payload->>'employee_no'=external_id),'-infinity'::timestamptz)
        order by created_at limit 1);
      if not found then insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
        values(target,saved.id,desired_command,p_requested_by,person_payload); end if;
    end if;
    if existed and (card_changed or external_changed) and previous.card_number is not null then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target,saved.id,'delete_card',p_requested_by,jsonb_build_object('employee_no',old_external_id,'card_no',previous.card_number));
    end if;
    if saved.card_number is not null and (not existed or card_changed or external_changed) then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target,saved.id,'sync_card',p_requested_by,jsonb_build_object('employee_no',external_id,'card_no',saved.card_number));
    end if;
  end loop;

  foreach removed in array(select coalesce(array_agg(device_id),'{}'::uuid[]) from unnest(old_devices) device_id
    where not device_id=any(coalesce(p_device_ids,'{}'::uuid[]))) loop
    insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
    select removed,saved.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',old_external_id)
    where not exists(select 1 from public.device_commands command where command.device_id=removed and command.command_type='delete_person'
      and command.status in ('pending','processing') and command.payload->>'employee_no'=old_external_id
      and command.created_at>coalesce((select max(created_at) from public.device_commands person where person.device_id=removed
        and person.employee_id=saved.id and person.command_type in ('sync_person','update_person')),'-infinity'::timestamptz));
    delete from public.employee_devices where employee_id=saved.id and device_id=removed;
  end loop;
  return saved;
end $$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;

create or replace view public.attendance_report_rows with (security_invoker=true) as
select daily.id,daily.employee_id,employee.company_id,daily.branch_id,employee.department_id,daily.rule_id,
  department.name as department,rule.name as attendance_rule,employee.full_name as employee_name,
  daily.attendance_date,daily.actual_check_in,daily.actual_check_out,
  case when daily.actual_check_in is null then 'Ninguno' else to_char(daily.actual_check_in at time zone 'America/Guatemala','HH24:MI:SS') end as check_in_record,
  case when daily.actual_check_out is null then 'Ninguno' else to_char(daily.actual_check_out at time zone 'America/Guatemala','HH24:MI:SS') end as check_out_record,
  daily.worked_minutes as attendance_minutes,daily.lunch_minutes as break_minutes,daily.break_records,
  case when daily.actual_check_in is null or daily.actual_check_out is null then '-'
    else to_char(daily.actual_check_in at time zone 'America/Guatemala','HH24:MI')||' - '||to_char(daily.actual_check_out at time zone 'America/Guatemala','HH24:MI') end as time_period,
  daily.status,daily.warnings,daily.device_ids,daily.calculated_at
from public.daily_attendance daily join public.employees employee on employee.id=daily.employee_id
left join public.departments department on department.id=employee.department_id
left join public.attendance_report_rules rule on rule.id=daily.rule_id;
grant select on public.attendance_report_rows to authenticated,service_role;

create or replace function public.get_attendance_daily_report(p_date date,p_branch_id uuid default null,p_employee_id uuid default null)
returns setof public.attendance_report_rows language sql stable security definer set search_path=public as $$
  select report.* from public.attendance_report_rows report
  where report.attendance_date=p_date and (p_branch_id is null or report.branch_id=p_branch_id)
    and (p_employee_id is null or report.employee_id=p_employee_id)
    and (exists(select 1 from public.user_roles ur join public.roles role on role.id=ur.role_id
      where ur.user_id=auth.uid() and role.key='super_admin' and ur.company_id is null)
      or report.company_id in(select company_id from public.user_roles where user_id=auth.uid() and company_id is not null))
  order by report.employee_name;
$$;
revoke all on function public.get_attendance_daily_report(date,uuid,uuid) from public,anon;
grant execute on function public.get_attendance_daily_report(date,uuid,uuid) to authenticated;

comment on table public.migration_snapshots is
  'Rollback source for 202607220021. Restore attendance_groups/work_schedules/schedule_rules and legacy references from migration_key 202607220019 if rollback is required.';
