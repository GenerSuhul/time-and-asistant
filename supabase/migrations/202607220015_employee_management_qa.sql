-- Employee management QA hardening: idempotent device commands and fingerprint requests.

with duplicate_sessions as (
  select id, row_number() over (
    partition by employee_id, device_id, finger_no order by created_at asc, id asc
  ) as position
  from public.biometric_enrollment_sessions
  where status in ('pending', 'processing')
)
update public.biometric_enrollment_sessions session
set status = 'timeout', completed_at = now(), error_message = 'Superseded duplicate enrollment request'
from duplicate_sessions duplicate
where session.id = duplicate.id and duplicate.position > 1;

create unique index if not exists biometric_enrollment_one_active_idx
  on public.biometric_enrollment_sessions(employee_id, device_id, finger_no)
  where status in ('pending', 'processing');

with duplicate_deletes as (
  select id, row_number() over (
    partition by device_id, payload->>'employee_no' order by created_at asc, id asc
  ) as position
  from public.device_commands
  where command_type = 'delete_person'
    and status in ('pending', 'processing')
    and coalesce(payload->>'employee_no', '') <> ''
)
update public.device_commands command
set status = 'cancelled', error_message = 'Superseded duplicate delete_person command', processed_at = now()
from duplicate_deletes duplicate
where command.id = duplicate.id and duplicate.position > 1;

create unique index if not exists device_commands_one_active_delete_person_idx
  on public.device_commands(device_id, (payload->>'employee_no'))
  where command_type = 'delete_person'
    and status in ('pending', 'processing')
    and coalesce(payload->>'employee_no', '') <> '';

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
  old_external_id text;
  safe_metadata jsonb;
  person_changed boolean := true;
  card_changed boolean := true;
  external_changed boolean := false;
  existing_target boolean;
  desired_person_command public.device_command_type;
  person_payload jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  safe_metadata := coalesce(p_employee->'metadata', '{}'::jsonb);
  safe_metadata := safe_metadata - 'fingerData' - 'finger_data' - 'template' - 'password' - 'secret' - 'device_key' - 'service_role';
  external_id := coalesce(nullif(trim(p_employee->>'external_employee_id'), ''), trim(p_employee->>'employee_code'));

  if p_employee_id is not null then
    select * into old_employee from public.employees where id = p_employee_id for update;
    if not found then raise exception 'employee not found'; end if;
    old_external_id := coalesce(old_employee.external_employee_id, old_employee.employee_code);
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
    external_changed := old_external_id is distinct from external_id;
    person_changed := external_changed
      or old_employee.full_name is distinct from saved.full_name
      or old_employee.access_valid_from is distinct from saved.access_valid_from
      or old_employee.access_valid_to is distinct from saved.access_valid_to;
    card_changed := old_employee.card_number is distinct from saved.card_number;
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
    old_external_id := external_id;
  end if;

  person_payload := jsonb_build_object(
    'employee_no', external_id,
    'name', saved.full_name,
    'valid_from', coalesce(saved.access_valid_from::text,'2020-01-01')||'T00:00:00',
    'valid_to', coalesce(saved.access_valid_to::text,'2037-12-31')||'T23:59:59'
  );

  foreach target_device in array coalesce(p_device_ids, '{}'::uuid[]) loop
    existing_target := target_device=any(old_device_ids);
    insert into public.employee_devices(employee_id,device_id,external_person_id,sync_status,last_error)
    values(saved.id,target_device,external_id,
      case when not existing_target or person_changed or card_changed then 'pending' else 'success' end,
      null)
    on conflict(employee_id,device_id) do update set
      external_person_id=excluded.external_person_id,
      sync_status=case when person_changed or card_changed then 'pending' else public.employee_devices.sync_status end,
      last_error=case when person_changed or card_changed then null else public.employee_devices.last_error end;

    if external_changed and existing_target then
      update public.device_commands command
      set status='cancelled', processed_at=now(), error_message='Superseded after employee number changed'
      where command.device_id=target_device and command.employee_id=saved.id
        and command.command_type in ('sync_person','update_person') and command.status='pending';
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      select target_device,saved.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',old_external_id)
      where not exists (
        select 1 from public.device_commands command
        where command.device_id=target_device and command.command_type='delete_person'
          and command.status in ('pending','processing') and command.payload->>'employee_no'=old_external_id
      );
    end if;

    if not existing_target or person_changed then
      desired_person_command := case
        when not existing_target or external_changed then 'sync_person'::public.device_command_type
        else 'update_person'::public.device_command_type
      end;
      update public.device_commands command set
        payload=person_payload,
        command_type=case when command.command_type='sync_person' then command.command_type else desired_person_command end,
        requested_by=p_requested_by,
        next_run_at=now(),
        error_message=null
      where command.id=(
        select pending.id from public.device_commands pending
        where pending.device_id=target_device and pending.employee_id=saved.id
          and pending.command_type in ('sync_person','update_person') and pending.status='pending'
        order by pending.created_at asc limit 1
      );
      if not found then
        insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
        values(target_device,saved.id,desired_person_command,p_requested_by,person_payload);
      end if;
    end if;

    if existing_target and (card_changed or external_changed) and old_employee.card_number is not null then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      select target_device,saved.id,'delete_card',p_requested_by,
        jsonb_build_object('employee_no',old_external_id,'card_no',old_employee.card_number)
      where not exists (
        select 1 from public.device_commands command
        where command.device_id=target_device and command.command_type='delete_card'
          and command.status in ('pending','processing')
          and command.payload->>'card_no'=old_employee.card_number
      );
    end if;

    if saved.card_number is not null and (not existing_target or card_changed or external_changed) then
      update public.device_commands command set
        payload=jsonb_build_object('employee_no',external_id,'card_no',saved.card_number),
        requested_by=p_requested_by,
        next_run_at=now(),
        error_message=null
      where command.id=(
        select pending.id from public.device_commands pending
        where pending.device_id=target_device and pending.employee_id=saved.id
          and pending.command_type='sync_card' and pending.status='pending'
        order by pending.created_at asc limit 1
      );
      if not found then
        insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
        values(target_device,saved.id,'sync_card',p_requested_by,jsonb_build_object('employee_no',external_id,'card_no',saved.card_number));
      end if;
    end if;
  end loop;

  foreach removed_device in array (
    select coalesce(array_agg(device_id), '{}'::uuid[])
    from unnest(old_device_ids) as device_id
    where not (device_id=any(coalesce(p_device_ids,'{}'::uuid[])))
  ) loop
    insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
    select removed_device,saved.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',old_external_id)
    where not exists (
      select 1 from public.device_commands command
      where command.device_id=removed_device and command.command_type='delete_person'
        and command.status in ('pending','processing') and command.payload->>'employee_no'=old_external_id
    );
    delete from public.employee_devices where employee_id=saved.id and device_id=removed_device;
  end loop;
  return saved;
end $$;

create or replace function public.admin_delete_employee(p_employee_id uuid, p_requested_by uuid)
returns void language plpgsql security definer set search_path=public as $$
declare e public.employees; link record; external_id text;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  select * into e from public.employees where id=p_employee_id for update;
  if not found then raise exception 'employee not found'; end if;
  external_id := coalesce(e.external_employee_id,e.employee_code);
  for link in select device_id from public.employee_devices where employee_id=e.id loop
    insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
    select link.device_id,e.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',external_id)
    where not exists (
      select 1 from public.device_commands command
      where command.device_id=link.device_id and command.command_type='delete_person'
        and command.status in ('pending','processing') and command.payload->>'employee_no'=external_id
    );
  end loop;
  delete from public.employees where id=e.id;
end $$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_employee(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;
grant execute on function public.admin_delete_employee(uuid,uuid) to service_role;
