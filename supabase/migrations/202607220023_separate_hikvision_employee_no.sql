-- Separate the internal HR code from the numeric identifier required by Hikvision.
-- Existing device mappings are preserved because external_person_id represents what
-- currently exists on each physical device and may require a controlled migration.

insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220023','employee_identifiers',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'company_id',company_id,'employee_code',employee_code,
    'external_employee_id',external_employee_id
  ) order by id),'[]'::jsonb)
from public.employees on conflict do nothing;

insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220023','employee_device_identifiers',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'employee_id',employee_id,'device_id',device_id,
    'external_person_id',external_person_id
  ) order by id),'[]'::jsonb)
from public.employee_devices on conflict do nothing;

create sequence if not exists public.hikvision_employee_no_seq start with 8000000000;

alter table public.employees add column if not exists hikvision_employee_no text;

update public.employees
set hikvision_employee_no=case
  when trim(coalesce(external_employee_id,''))~'^[0-9]+$' then trim(external_employee_id)
  when trim(employee_code)~'^[0-9]+$' then trim(employee_code)
  else null
end
where hikvision_employee_no is null;

create or replace function public.allocate_hikvision_employee_no(p_company_id uuid)
returns text language plpgsql security definer set search_path=public as $$
declare candidate text;
begin
  loop
    candidate:=nextval('public.hikvision_employee_no_seq')::text;
    exit when not exists(
      select 1 from public.employees
      where company_id=p_company_id and hikvision_employee_no=candidate
    ) and not exists(
      select 1 from public.employee_creation_sessions
      where company_id=p_company_id and employee_no=candidate
        and status in ('draft','enrolling','captured')
    );
  end loop;
  return candidate;
end $$;

revoke all on function public.allocate_hikvision_employee_no(uuid) from public,anon,authenticated;
grant execute on function public.allocate_hikvision_employee_no(uuid) to service_role;

do $$
declare employee record;
begin
  for employee in select id,company_id from public.employees where hikvision_employee_no is null order by company_id,id loop
    update public.employees
    set hikvision_employee_no=public.allocate_hikvision_employee_no(employee.company_id)
    where id=employee.id;
  end loop;
end $$;

alter table public.employees alter column hikvision_employee_no set not null;
alter table public.employees drop constraint if exists employees_hikvision_employee_no_numeric_check;
alter table public.employees add constraint employees_hikvision_employee_no_numeric_check
  check (hikvision_employee_no~'^[0-9]+$');
create unique index if not exists employees_company_hikvision_employee_no_uidx
  on public.employees(company_id,hikvision_employee_no);

comment on column public.employees.employee_code is 'Internal HR code. May be alphanumeric and is never sent to Hikvision.';
comment on column public.employees.hikvision_employee_no is 'Canonical numeric employeeNo used for all new Hikvision person and biometric commands.';
comment on column public.employees.external_employee_id is 'Optional external integration identifier; not a Hikvision identity.';
comment on column public.employee_devices.external_person_id is 'Identifier currently materialized on this physical device; may temporarily differ during controlled migration.';
comment on column public.employee_creation_sessions.employee_no is 'Numeric Hikvision employeeNo reserved for this staged creation session.';

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
  requested_hikvision_no text:=nullif(trim(p_employee->>'hikvision_employee_no'),'');
  saved public.employee_creation_sessions;
begin
  if actor is null or not public.has_any_role(array['super_admin','it_admin','hr_admin']) then raise exception 'FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended(company::text||':'||lower(requested_code),0));
  if requested_hikvision_no is null then
    requested_hikvision_no:=case when requested_code~'^[0-9]+$' then requested_code else public.allocate_hikvision_employee_no(company) end;
  end if;
  if requested_hikvision_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  if branch is not null and not exists(select 1 from public.branches where id=branch and company_id=company) then raise exception 'BRANCH_COMPANY_MISMATCH'; end if;
  if department is not null and (branch is null or not exists(
    select 1 from public.department_branches where department_id=department and branch_id=branch
  )) then raise exception 'DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH'; end if;
  if exists(select 1 from public.employees where company_id=company and employee_code=requested_code) then raise exception 'EMPLOYEE_CODE_ALREADY_EXISTS'; end if;
  if exists(select 1 from public.employee_creation_sessions
    where company_id=company and status in ('draft','enrolling','captured')
      and trim(draft_data->>'employee_code')=requested_code) then
    raise exception 'EMPLOYEE_CREATION_SESSION_ALREADY_ACTIVE';
  end if;
  if exists(select 1 from public.employees where company_id=company and hikvision_employee_no=requested_hikvision_no) then raise exception 'HIKVISION_EMPLOYEE_NO_ALREADY_EXISTS'; end if;

  insert into public.employee_creation_sessions(
    company_id,branch_id,department_id,employee_no,full_name,draft_data,requested_by,trace_id
  ) values (
    company,branch,department,requested_hikvision_no,trim(p_employee->>'full_name'),
    p_employee||jsonb_build_object('hikvision_employee_no',requested_hikvision_no),actor,p_trace_id
  ) returning * into saved;
  return saved;
end $$;

revoke all on function public.admin_start_employee_creation_session(jsonb,uuid) from public,anon;
grant execute on function public.admin_start_employee_creation_session(jsonb,uuid) to authenticated;

create or replace function public.admin_save_employee(
  p_employee jsonb,p_device_ids uuid[],p_requested_by uuid,p_employee_id uuid default null
) returns public.employees
language plpgsql security definer set search_path=public as $$
declare
  saved public.employees; previous public.employees; target uuid; removed uuid;
  old_devices uuid[]:='{}'::uuid[]; requested_hikvision_no text; old_hikvision_no text;
  requested_external_id text; safe_metadata jsonb; person_changed boolean:=true;
  card_changed boolean:=true; hikvision_no_changed boolean:=false; existed boolean;
  actual_device_no text; device_migration_pending boolean; desired_command public.device_command_type; person_payload jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  safe_metadata:=coalesce(p_employee->'metadata','{}'::jsonb)-'fingerData'-'finger_data'-'template'-'password'-'secret'-'device_key'-'service_role';
  requested_external_id:=nullif(trim(p_employee->>'external_employee_id'),'');
  requested_hikvision_no:=nullif(trim(p_employee->>'hikvision_employee_no'),'');
  if nullif(p_employee->>'department_id','') is not null and nullif(p_employee->>'branch_id','') is not null
    and not exists(select 1 from public.department_branches where department_id=(p_employee->>'department_id')::uuid and branch_id=(p_employee->>'branch_id')::uuid)
    then raise exception 'DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH'; end if;

  if p_employee_id is null then
    if requested_hikvision_no is null then requested_hikvision_no:=case
      when trim(p_employee->>'employee_code')~'^[0-9]+$' then trim(p_employee->>'employee_code')
      else public.allocate_hikvision_employee_no((p_employee->>'company_id')::uuid) end;
    end if;
    if requested_hikvision_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
    insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,hikvision_employee_no,
      full_name,email,phone,document_number,status,card_number,pin_enabled,hired_at,terminated_at,
      access_valid_from,access_valid_to,metadata,credential_status)
    values((p_employee->>'company_id')::uuid,nullif(p_employee->>'branch_id','')::uuid,nullif(p_employee->>'department_id','')::uuid,
      trim(p_employee->>'employee_code'),requested_external_id,requested_hikvision_no,trim(p_employee->>'full_name'),
      nullif(trim(p_employee->>'email'),''),nullif(trim(p_employee->>'phone'),''),nullif(trim(p_employee->>'document_number'),''),
      (p_employee->>'status')::public.employee_status,nullif(trim(p_employee->>'card_number'),''),
      coalesce((p_employee->>'pin_enabled')::boolean,false),nullif(p_employee->>'hired_at','')::date,
      nullif(p_employee->>'terminated_at','')::date,nullif(p_employee->>'access_valid_from','')::date,
      nullif(p_employee->>'access_valid_to','')::date,safe_metadata,
      jsonb_build_object('card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
        'fingerprint','none','face','none','pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end))
    returning * into saved;
    old_hikvision_no:=requested_hikvision_no;
  else
    select * into previous from public.employees where id=p_employee_id for update;
    if not found then raise exception 'employee not found'; end if;
    old_hikvision_no:=previous.hikvision_employee_no;
    requested_hikvision_no:=coalesce(requested_hikvision_no,old_hikvision_no);
    if requested_hikvision_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
    select coalesce(array_agg(device_id),'{}'::uuid[]) into old_devices from public.employee_devices where employee_id=p_employee_id;
    if requested_hikvision_no is distinct from old_hikvision_no and cardinality(old_devices)>0 then raise exception 'HIKVISION_EMPLOYEE_NO_LOCKED'; end if;
    update public.employees set company_id=(p_employee->>'company_id')::uuid,branch_id=nullif(p_employee->>'branch_id','')::uuid,
      department_id=nullif(p_employee->>'department_id','')::uuid,employee_code=trim(p_employee->>'employee_code'),
      external_employee_id=coalesce(requested_external_id,external_employee_id),
      hikvision_employee_no=requested_hikvision_no,full_name=trim(p_employee->>'full_name'),email=nullif(trim(p_employee->>'email'),''),
      phone=nullif(trim(p_employee->>'phone'),''),document_number=nullif(trim(p_employee->>'document_number'),''),
      status=(p_employee->>'status')::public.employee_status,card_number=nullif(trim(p_employee->>'card_number'),''),
      pin_enabled=coalesce((p_employee->>'pin_enabled')::boolean,false),hired_at=nullif(p_employee->>'hired_at','')::date,
      terminated_at=nullif(p_employee->>'terminated_at','')::date,access_valid_from=nullif(p_employee->>'access_valid_from','')::date,
      access_valid_to=nullif(p_employee->>'access_valid_to','')::date,metadata=safe_metadata,
      credential_status=jsonb_build_object('card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
        'fingerprint',fingerprint_status,'face',face_status,'pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end)
    where id=p_employee_id returning * into saved;
    hikvision_no_changed:=old_hikvision_no is distinct from requested_hikvision_no;
    person_changed:=hikvision_no_changed or previous.full_name is distinct from saved.full_name
      or previous.access_valid_from is distinct from saved.access_valid_from or previous.access_valid_to is distinct from saved.access_valid_to;
    card_changed:=previous.card_number is distinct from saved.card_number;
  end if;

  person_payload:=jsonb_build_object('employee_no',requested_hikvision_no,'name',saved.full_name,
    'valid_from',coalesce(saved.access_valid_from::text,'2020-01-01')||'T00:00:00',
    'valid_to',coalesce(saved.access_valid_to::text,'2037-12-31')||'T23:59:59');
  foreach target in array coalesce(p_device_ids,'{}'::uuid[]) loop
    existed:=target=any(old_devices);
    actual_device_no:=null;
    if existed then select external_person_id into actual_device_no from public.employee_devices where employee_id=saved.id and device_id=target; end if;
    device_migration_pending:=existed and actual_device_no is distinct from requested_hikvision_no;
    insert into public.employee_devices(employee_id,device_id,external_person_id,sync_status,last_error)
    values(saved.id,target,requested_hikvision_no,
      case when not existed then 'pending'::public.command_status else 'success'::public.command_status end,null)
    on conflict(employee_id,device_id) do update set
      sync_status=case when not device_migration_pending and (person_changed or card_changed) then 'pending'::public.command_status else public.employee_devices.sync_status end,
      last_error=case when not device_migration_pending and (person_changed or card_changed) then null else public.employee_devices.last_error end;

    if not existed or (person_changed and not device_migration_pending) then
      desired_command:=case when not existed or hikvision_no_changed then 'sync_person'::public.device_command_type else 'update_person'::public.device_command_type end;
      update public.device_commands set payload=person_payload,command_type=desired_command,requested_by=p_requested_by,next_run_at=now(),error_message=null
      where id=(select id from public.device_commands where device_id=target and employee_id=saved.id
        and command_type in ('sync_person','update_person') and status='pending' and payload->>'employee_no'=requested_hikvision_no
        order by created_at limit 1);
      if not found then insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
        values(target,saved.id,desired_command,p_requested_by,person_payload); end if;
    end if;
    if existed and card_changed and previous.card_number is not null and not device_migration_pending then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target,saved.id,'delete_card',p_requested_by,jsonb_build_object('employee_no',requested_hikvision_no,'card_no',previous.card_number));
    end if;
    if saved.card_number is not null and (not existed or card_changed) and not device_migration_pending then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      select target,saved.id,'sync_card',p_requested_by,jsonb_build_object('employee_no',requested_hikvision_no,'card_no',saved.card_number)
      where not exists(select 1 from public.device_commands where device_id=target and employee_id=saved.id
        and command_type='sync_card' and status in ('pending','processing') and payload->>'employee_no'=requested_hikvision_no);
    end if;
  end loop;

  foreach removed in array(select coalesce(array_agg(device_id),'{}'::uuid[]) from unnest(old_devices) device_id
    where not device_id=any(coalesce(p_device_ids,'{}'::uuid[]))) loop
    select external_person_id into actual_device_no from public.employee_devices where employee_id=saved.id and device_id=removed;
    insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
    select removed,saved.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',actual_device_no)
    where actual_device_no is not null and not exists(select 1 from public.device_commands command where command.device_id=removed
      and command.command_type='delete_person' and command.status in ('pending','processing') and command.payload->>'employee_no'=actual_device_no);
    delete from public.employee_devices where employee_id=saved.id and device_id=removed;
  end loop;
  return saved;
end $$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;

create or replace function public.admin_commit_employee_creation_session(
  p_session_id uuid,p_employee jsonb,p_device_ids uuid[],p_requested_by uuid
) returns public.employees
language plpgsql security definer set search_path=public as $$
declare creation public.employee_creation_sessions; saved public.employees; target uuid; staged_device uuid;
  requested_external_id text; safe_metadata jsonb; person_payload jsonb; staged boolean;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into creation from public.employee_creation_sessions where id=p_session_id for update;
  if not found then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_FOUND'; end if;
  if creation.requested_by is distinct from p_requested_by then raise exception 'EMPLOYEE_CREATION_SESSION_OWNER_MISMATCH'; end if;
  if creation.status not in ('draft','captured') then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_COMMITTABLE:%',creation.status; end if;
  if creation.expires_at<=now() then raise exception 'EMPLOYEE_CREATION_SESSION_EXPIRED'; end if;
  if creation.employee_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  if nullif(trim(p_employee->>'hikvision_employee_no'),'') is not null
    and trim(p_employee->>'hikvision_employee_no') is distinct from creation.employee_no then raise exception 'EMPLOYEE_NO_CHANGED_AFTER_STAGING'; end if;
  if exists(select 1 from public.employees where company_id=(p_employee->>'company_id')::uuid and employee_code=trim(p_employee->>'employee_code'))
    then raise exception 'EMPLOYEE_CODE_ALREADY_EXISTS'; end if;
  if exists(select 1 from public.employees where company_id=(p_employee->>'company_id')::uuid and hikvision_employee_no=creation.employee_no)
    then raise exception 'HIKVISION_EMPLOYEE_NO_ALREADY_EXISTS'; end if;
  if nullif(p_employee->>'department_id','') is not null and nullif(p_employee->>'branch_id','') is not null
    and not exists(select 1 from public.department_branches where department_id=(p_employee->>'department_id')::uuid and branch_id=(p_employee->>'branch_id')::uuid)
    then raise exception 'DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH'; end if;

  safe_metadata:=coalesce(p_employee->'metadata','{}'::jsonb)-'fingerData'-'finger_data'-'template'-'password'-'secret'-'device_key'-'service_role';
  requested_external_id:=nullif(trim(p_employee->>'external_employee_id'),'');
  insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,hikvision_employee_no,
    full_name,email,phone,document_number,status,card_number,pin_enabled,hired_at,terminated_at,access_valid_from,
    access_valid_to,metadata,fingerprint_status,fingerprint_count,credential_status)
  values((p_employee->>'company_id')::uuid,nullif(p_employee->>'branch_id','')::uuid,nullif(p_employee->>'department_id','')::uuid,
    trim(p_employee->>'employee_code'),requested_external_id,creation.employee_no,trim(p_employee->>'full_name'),
    nullif(trim(p_employee->>'email'),''),nullif(trim(p_employee->>'phone'),''),nullif(trim(p_employee->>'document_number'),''),
    (p_employee->>'status')::public.employee_status,nullif(trim(p_employee->>'card_number'),''),
    coalesce((p_employee->>'pin_enabled')::boolean,false),nullif(p_employee->>'hired_at','')::date,
    nullif(p_employee->>'terminated_at','')::date,nullif(p_employee->>'access_valid_from','')::date,
    nullif(p_employee->>'access_valid_to','')::date,safe_metadata,
    case when creation.status='captured' then 'enrolled'::public.enrollment_status else 'none'::public.enrollment_status end,
    case when creation.status='captured' then 1 else 0 end,
    jsonb_build_object('card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
      'fingerprint',case when creation.status='captured' then 'enrolled' else 'none' end,'face','none',
      'pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end)) returning * into saved;

  person_payload:=jsonb_build_object('employee_no',creation.employee_no,'name',saved.full_name,
    'valid_from',coalesce(saved.access_valid_from::text,'2020-01-01')||'T00:00:00',
    'valid_to',coalesce(saved.access_valid_to::text,'2037-12-31')||'T23:59:59');
  foreach target in array coalesce(p_device_ids,'{}'::uuid[]) loop
    staged:=target=any(creation.staged_device_ids);
    insert into public.employee_devices(employee_id,device_id,external_person_id,sync_status,last_error,last_synced_at)
    values(saved.id,target,creation.employee_no,
      case when staged and saved.card_number is null then 'success'::public.command_status else 'pending'::public.command_status end,
      null,case when staged then now() else null end)
    on conflict(employee_id,device_id) do update set external_person_id=excluded.external_person_id,
      sync_status=excluded.sync_status,last_error=null,last_synced_at=excluded.last_synced_at;
    if not staged then insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target,saved.id,'sync_person',p_requested_by,person_payload); end if;
    if saved.card_number is not null then insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target,saved.id,'sync_card',p_requested_by,jsonb_build_object('employee_no',creation.employee_no,'card_no',saved.card_number)); end if;
  end loop;
  foreach staged_device in array creation.staged_device_ids loop
    if not staged_device=any(coalesce(p_device_ids,'{}'::uuid[])) then insert into public.device_commands(device_id,command_type,requested_by,payload)
      values(staged_device,'delete_person',p_requested_by,jsonb_build_object('employee_no',creation.employee_no,'creation_session_id',creation.id)); end if;
  end loop;
  update public.device_commands set employee_id=saved.id where employee_id is null and payload->>'creation_session_id'=creation.id::text;
  update public.biometric_enrollment_sessions set employee_id=saved.id,creation_session_id=null where creation_session_id=creation.id;
  update public.employee_creation_sessions set status='committed',committed_employee_id=saved.id,committed_at=now(),
    draft_data='{}'::jsonb,error_code=null,error_message=null where id=creation.id;
  return saved;
end $$;

revoke all on function public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid) to service_role;

create or replace function public.admin_stage_employee_fingerprint(
  p_session_id uuid,p_device_id uuid,p_finger_no integer,p_employee jsonb,p_requested_by uuid,p_trace_id uuid
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare creation public.employee_creation_sessions; device public.devices; enrollment_id uuid; command_id uuid;
  person_command_id uuid; person_payload jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into creation from public.employee_creation_sessions where id=p_session_id for update;
  if not found then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_FOUND'; end if;
  if creation.requested_by is distinct from p_requested_by then raise exception 'EMPLOYEE_CREATION_SESSION_OWNER_MISMATCH'; end if;
  if creation.status not in ('draft','failed','captured') then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_COMMITTABLE:%',creation.status; end if;
  if creation.expires_at<=now() then raise exception 'EMPLOYEE_CREATION_SESSION_EXPIRED'; end if;
  if creation.employee_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  select * into device from public.devices where id=p_device_id for update;
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;
  if device.dev_index is null then raise exception 'DEVICE_NOT_LINKED'; end if;
  if device.status<>'online' then raise exception 'DEVICE_OFFLINE:%',device.name; end if;
  if exists(select 1 from public.biometric_enrollment_sessions where creation_session_id=creation.id
    and device_id=device.id and finger_no=p_finger_no and status in ('pending','processing')) then raise exception 'FINGERPRINT_ENROLLMENT_ALREADY_ACTIVE'; end if;

  person_payload:=jsonb_build_object('employee_no',creation.employee_no,'name',trim(p_employee->>'full_name'),
    'valid_from',coalesce(nullif(p_employee->>'access_valid_from',''),'2020-01-01')||'T00:00:00',
    'valid_to',coalesce(nullif(p_employee->>'access_valid_to',''),'2037-12-31')||'T23:59:59',
    'creation_session_id',creation.id,'trace_id',p_trace_id);
  if not device.id=any(creation.staged_device_ids) then
    select id into person_command_id from public.device_commands where device_id=device.id and command_type='sync_person'
      and status in ('pending','processing') and payload->>'employee_no'=creation.employee_no order by created_at limit 1;
    if person_command_id is null then insert into public.device_commands(device_id,command_type,requested_by,payload)
      values(device.id,'sync_person',p_requested_by,person_payload) returning id into person_command_id; end if;
  end if;
  insert into public.biometric_enrollment_sessions(employee_id,creation_session_id,device_id,finger_no,status,requested_by,trace_id,status_detail)
  values(null,creation.id,device.id,p_finger_no,'pending',p_requested_by,p_trace_id,'Preparando persona numérica en el dispositivo') returning id into enrollment_id;
  insert into public.device_commands(device_id,command_type,requested_by,payload,depends_on_command_id)
  values(device.id,'enroll_fingerprint',p_requested_by,jsonb_build_object('employee_no',creation.employee_no,
    'finger_no',p_finger_no,'session_id',enrollment_id,'creation_session_id',creation.id,'trace_id',p_trace_id),person_command_id)
  returning id into command_id;
  update public.biometric_enrollment_sessions set device_command_id=command_id where id=enrollment_id;
  update public.employee_creation_sessions set status='enrolling',
    draft_data=p_employee||jsonb_build_object('hikvision_employee_no',creation.employee_no),
    staged_device_ids=array(select distinct value from unnest(array_append(staged_device_ids,device.id)) value),
    trace_id=p_trace_id,error_code=null,error_message=null,expires_at=now()+interval '20 minutes' where id=creation.id;
  return jsonb_build_object('session_id',creation.id,'hikvision_employee_no',creation.employee_no,
    'enrollment_session_id',enrollment_id,'job_id',command_id,'prepare_job_id',person_command_id,'trace_id',p_trace_id);
end $$;

revoke all on function public.admin_stage_employee_fingerprint(uuid,uuid,integer,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_stage_employee_fingerprint(uuid,uuid,integer,jsonb,uuid,uuid) to service_role;

create or replace function public.admin_enroll_employee_fingerprint(
  p_employee_id uuid,p_device_id uuid,p_finger_no integer,p_requested_by uuid,p_trace_id uuid
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare employee public.employees; device public.devices; link public.employee_devices; enrollment_id uuid;
  prepare_id uuid; command_id uuid; previous_no text; person_payload jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into employee from public.employees where id=p_employee_id for update;
  if not found then raise exception 'employee not found'; end if;
  if employee.hikvision_employee_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  select * into link from public.employee_devices where employee_id=p_employee_id and device_id=p_device_id for update;
  if not found then raise exception 'PERSON_NOT_SYNCED'; end if;
  select * into device from public.devices where id=p_device_id for update;
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;
  if device.dev_index is null then raise exception 'DEVICE_NOT_LINKED'; end if;
  if device.status<>'online' then raise exception 'DEVICE_OFFLINE:%',device.name; end if;
  if exists(select 1 from public.biometric_enrollment_sessions where employee_id=employee.id
    and device_id=device.id and finger_no=p_finger_no and status in ('pending','processing')) then raise exception 'FINGERPRINT_ENROLLMENT_ALREADY_ACTIVE'; end if;

  previous_no:=case when link.external_person_id is distinct from employee.hikvision_employee_no then link.external_person_id else null end;
  if previous_no is not null then
    if employee.fingerprint_count>0 or employee.card_number is not null or employee.face_status='enrolled' then
      raise exception 'HIKVISION_IDENTIFIER_MIGRATION_REQUIRES_RECREDENTIAL';
    end if;
    person_payload:=jsonb_build_object('employee_no',employee.hikvision_employee_no,'name',employee.full_name,
      'valid_from',coalesce(employee.access_valid_from::text,'2020-01-01')||'T00:00:00',
      'valid_to',coalesce(employee.access_valid_to::text,'2037-12-31')||'T23:59:59',
      'migration_from_employee_no',previous_no,'trace_id',p_trace_id);
    select id into prepare_id from public.device_commands where device_id=device.id and command_type='sync_person'
      and status in ('pending','processing') and payload->>'employee_no'=employee.hikvision_employee_no order by created_at limit 1;
    if prepare_id is null then insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(device.id,employee.id,'sync_person',p_requested_by,person_payload) returning id into prepare_id; end if;
  end if;
  insert into public.biometric_enrollment_sessions(employee_id,device_id,finger_no,status,requested_by,trace_id,status_detail)
  values(employee.id,device.id,p_finger_no,'pending',p_requested_by,p_trace_id,
    case when previous_no is null then 'Solicitud recibida; esperando worker' else 'Preparando identidad numérica en el dispositivo' end)
  returning id into enrollment_id;
  insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload,depends_on_command_id)
  values(device.id,employee.id,'enroll_fingerprint',p_requested_by,jsonb_strip_nulls(jsonb_build_object(
    'employee_no',employee.hikvision_employee_no,'previous_employee_no',previous_no,'finger_no',p_finger_no,
    'session_id',enrollment_id,'trace_id',p_trace_id)),prepare_id) returning id into command_id;
  update public.biometric_enrollment_sessions set device_command_id=command_id where id=enrollment_id;
  update public.employees set fingerprint_status='pending' where id=employee.id;
  return jsonb_build_object('session_id',enrollment_id,'enrollment_session_id',enrollment_id,
    'hikvision_employee_no',employee.hikvision_employee_no,'job_id',command_id,'prepare_job_id',prepare_id,'trace_id',p_trace_id);
end $$;

revoke all on function public.admin_enroll_employee_fingerprint(uuid,uuid,integer,uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_enroll_employee_fingerprint(uuid,uuid,integer,uuid,uuid) to service_role;

create or replace function public.admin_delete_employee(p_employee_id uuid,p_requested_by uuid)
returns void language plpgsql security definer set search_path=public as $$
declare employee public.employees; link record; actual_device_no text;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into employee from public.employees where id=p_employee_id for update;
  if not found then raise exception 'employee not found'; end if;
  for link in select device_id,external_person_id from public.employee_devices where employee_id=employee.id loop
    actual_device_no:=coalesce(nullif(link.external_person_id,''),employee.hikvision_employee_no);
    insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
    select link.device_id,employee.id,'delete_person',p_requested_by,jsonb_build_object('employee_no',actual_device_no)
    where not exists(select 1 from public.device_commands command where command.device_id=link.device_id
      and command.command_type='delete_person' and command.status in ('pending','processing')
      and command.payload->>'employee_no'=actual_device_no);
  end loop;
  delete from public.employees where id=employee.id;
end $$;

revoke all on function public.admin_delete_employee(uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_delete_employee(uuid,uuid) to service_role;
