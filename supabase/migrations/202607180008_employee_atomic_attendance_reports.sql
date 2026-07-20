-- Atomic employee/device credential workflows and report contract.
alter table public.employees
  add column if not exists access_valid_from date,
  add column if not exists access_valid_to date,
  add column if not exists credential_status jsonb not null default '{"card":"none","fingerprint":"none","face":"none","pin":"none"}'::jsonb;

alter table public.employees drop constraint if exists employees_access_valid_range_check;
alter table public.employees add constraint employees_access_valid_range_check
  check (access_valid_to is null or access_valid_from is null or access_valid_to >= access_valid_from);

alter table public.device_commands drop constraint if exists device_commands_employee_id_fkey;
alter table public.device_commands add constraint device_commands_employee_id_fkey
  foreign key (employee_id) references public.employees(id) on delete set null;

create table if not exists public.device_sync_logs (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  command_id uuid references public.device_commands(id) on delete set null,
  sync_type text not null check (sync_type in ('people','events','credentials','biometric')),
  status public.command_status not null default 'pending',
  records_found integer not null default 0,
  records_upserted integer not null default 0,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists device_sync_logs_device_created_idx on public.device_sync_logs(device_id, created_at desc);
alter table public.device_sync_logs enable row level security;
drop policy if exists "role_select" on public.device_sync_logs;
create policy "role_select" on public.device_sync_logs for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));

-- The service-role Edge Function is the only caller. All changes and queue jobs
-- are committed together, so a partially synchronized UI state cannot exist.
create or replace function public.admin_save_employee(
  p_employee jsonb,
  p_device_ids uuid[],
  p_requested_by uuid,
  p_employee_id uuid default null
) returns public.employees
language plpgsql security definer set search_path = public
as $$
declare
  saved public.employees;
  old_employee public.employees;
  target_device uuid;
  removed_device uuid;
  old_device_ids uuid[] := '{}'::uuid[];
  external_id text;
  command_kind public.device_command_type;
  safe_metadata jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  safe_metadata := coalesce(p_employee->'metadata', '{}'::jsonb);
  safe_metadata := safe_metadata - 'fingerData' - 'finger_data' - 'template' - 'password' - 'secret' - 'device_key' - 'service_role';
  external_id := coalesce(nullif(trim(p_employee->>'external_employee_id'), ''), trim(p_employee->>'employee_code'));

  if p_employee_id is not null then
    select * into old_employee from public.employees where id = p_employee_id for update;
    if not found then raise exception 'employee not found'; end if;
    select coalesce(array_agg(device_id), '{}'::uuid[]) into old_device_ids
      from public.employee_devices where employee_id = p_employee_id;
    update public.employees set
      company_id=(p_employee->>'company_id')::uuid, branch_id=nullif(p_employee->>'branch_id','')::uuid,
      department_id=nullif(p_employee->>'department_id','')::uuid,
      attendance_group_id=nullif(p_employee->>'attendance_group_id','')::uuid,
      employee_code=trim(p_employee->>'employee_code'), external_employee_id=external_id,
      full_name=trim(p_employee->>'full_name'), email=nullif(trim(p_employee->>'email'),''),
      phone=nullif(trim(p_employee->>'phone'),''), document_number=nullif(trim(p_employee->>'document_number'),''),
      status=(p_employee->>'status')::public.employee_status, card_number=nullif(trim(p_employee->>'card_number'),''),
      pin_enabled=coalesce((p_employee->>'pin_enabled')::boolean,false),
      hired_at=nullif(p_employee->>'hired_at','')::date, terminated_at=nullif(p_employee->>'terminated_at','')::date,
      access_valid_from=nullif(p_employee->>'access_valid_from','')::date,
      access_valid_to=nullif(p_employee->>'access_valid_to','')::date, metadata=safe_metadata,
      credential_status=jsonb_build_object(
        'card', case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
        'fingerprint', fingerprint_status, 'face', face_status,
        'pin', case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end)
    where id=p_employee_id returning * into saved;
    command_kind := 'update_person';
  else
    insert into public.employees(company_id,branch_id,department_id,attendance_group_id,employee_code,
      external_employee_id,full_name,email,phone,document_number,status,card_number,pin_enabled,hired_at,
      terminated_at,access_valid_from,access_valid_to,metadata,credential_status)
    values ((p_employee->>'company_id')::uuid,nullif(p_employee->>'branch_id','')::uuid,
      nullif(p_employee->>'department_id','')::uuid,nullif(p_employee->>'attendance_group_id','')::uuid,
      trim(p_employee->>'employee_code'),external_id,trim(p_employee->>'full_name'),nullif(trim(p_employee->>'email'),''),
      nullif(trim(p_employee->>'phone'),''),nullif(trim(p_employee->>'document_number'),''),
      (p_employee->>'status')::public.employee_status,nullif(trim(p_employee->>'card_number'),''),
      coalesce((p_employee->>'pin_enabled')::boolean,false),nullif(p_employee->>'hired_at','')::date,
      nullif(p_employee->>'terminated_at','')::date,nullif(p_employee->>'access_valid_from','')::date,
      nullif(p_employee->>'access_valid_to','')::date,safe_metadata,
      jsonb_build_object('card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
        'fingerprint','none','face','none','pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end))
    returning * into saved;
    command_kind := 'sync_person';
  end if;

  foreach target_device in array coalesce(p_device_ids, '{}'::uuid[]) loop
    insert into public.employee_devices(employee_id,device_id,external_person_id,sync_status,last_error)
    values(saved.id,target_device,external_id,'pending',null)
    on conflict(employee_id,device_id) do update set external_person_id=excluded.external_person_id,sync_status='pending',last_error=null;
    insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
    values(target_device,saved.id,case when target_device=any(old_device_ids) then command_kind else 'sync_person'::public.device_command_type end,p_requested_by,jsonb_build_object('employee_no',external_id,'name',saved.full_name,
      'valid_from',coalesce(saved.access_valid_from::text,'2020-01-01')||'T00:00:00',
      'valid_to',coalesce(saved.access_valid_to::text,'2037-12-31')||'T23:59:59'));
    if saved.card_number is not null and (old_employee.id is null or old_employee.card_number is distinct from saved.card_number or not target_device=any(old_device_ids)) then
      if old_employee.card_number is not null and target_device=any(old_device_ids) then
        insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
        values(target_device,saved.id,'delete_card',p_requested_by,jsonb_build_object('employee_no',external_id,'card_no',old_employee.card_number));
      end if;
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target_device,saved.id,'sync_card',p_requested_by,jsonb_build_object('employee_no',external_id,'card_no',saved.card_number));
    elsif saved.card_number is null and old_employee.card_number is not null then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target_device,saved.id,'delete_card',p_requested_by,jsonb_build_object('employee_no',external_id,'card_no',old_employee.card_number));
    end if;
  end loop;

  foreach removed_device in array (select coalesce(array_agg(x), '{}'::uuid[]) from unnest(old_device_ids) x where not (x=any(coalesce(p_device_ids,'{}'::uuid[])))) loop
    insert into public.device_commands(device_id,command_type,requested_by,payload)
    values(removed_device,'delete_person',p_requested_by,jsonb_build_object('employee_no',coalesce(old_employee.external_employee_id,old_employee.employee_code)));
    delete from public.employee_devices where employee_id=saved.id and device_id=removed_device;
  end loop;
  return saved;
end $$;

create or replace function public.admin_delete_employee(p_employee_id uuid, p_requested_by uuid)
returns void language plpgsql security definer set search_path=public as $$
declare e public.employees; link record;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select * into e from public.employees where id=p_employee_id for update;
  if not found then raise exception 'employee not found'; end if;
  for link in select device_id from public.employee_devices where employee_id=e.id loop
    insert into public.device_commands(device_id,command_type,requested_by,payload)
    values(link.device_id,'delete_person',p_requested_by,jsonb_build_object('employee_no',coalesce(e.external_employee_id,e.employee_code)));
  end loop;
  delete from public.employees where id=e.id;
end $$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_employee(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;
grant execute on function public.admin_delete_employee(uuid,uuid) to service_role;

create or replace view public.attendance_report_rows with (security_invoker=true) as
select da.id, da.employee_id, e.company_id, da.branch_id, e.department_id, e.attendance_group_id,
  d.name as department, ag.name as attendance_group, e.full_name as employee_name,
  da.attendance_date, da.actual_check_in, da.actual_check_out,
  case when da.actual_check_in is null then 'Ninguno' else to_char(da.actual_check_in at time zone 'America/Guatemala','HH24:MI:SS') end as check_in_record,
  case when da.actual_check_out is null then 'Ninguno' else to_char(da.actual_check_out at time zone 'America/Guatemala','HH24:MI:SS') end as check_out_record,
  da.worked_minutes as attendance_minutes, da.lunch_minutes as break_minutes, da.break_records,
  case when da.actual_check_in is null or da.actual_check_out is null then '-'
    else to_char(da.actual_check_in at time zone 'America/Guatemala','HH24:MI')||' - '||to_char(da.actual_check_out at time zone 'America/Guatemala','HH24:MI') end as time_period,
  da.status, da.warnings, da.device_ids
from public.daily_attendance da join public.employees e on e.id=da.employee_id
left join public.departments d on d.id=e.department_id
left join public.attendance_groups ag on ag.id=e.attendance_group_id;
grant select on public.attendance_report_rows to authenticated, service_role;

-- Existing account receives full administration without embedding credentials.
insert into public.user_roles(user_id,role_id)
select u.id,r.id from auth.users u cross join public.roles r
where lower(u.email)='it.agrisystem@gmail.com' and r.key='super_admin'
on conflict do nothing;
