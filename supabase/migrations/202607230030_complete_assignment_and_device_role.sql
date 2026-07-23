-- Provision the Hikvision local device role as first-class credential state.
-- Fingerprint templates remain transient in the gateway and are never stored here.

alter table public.employees
  add column if not exists hikvision_is_admin boolean not null default false;

comment on column public.employees.hikvision_is_admin is
  'Canonical Hikvision terminal role. true maps to UserInfo.localUIRight=true.';

-- Explicit production correction requested for Gener Alexander Suhul Amador.
update public.employees
set hikvision_is_admin=true
where id='00f3f4cd-322e-44c6-9d5a-4b8c4c4fa13d'
  and hikvision_employee_no='8000000005';

alter table public.employee_device_credentials
  drop constraint if exists employee_device_credentials_credential_type_check;
alter table public.employee_device_credentials
  add constraint employee_device_credentials_credential_type_check
  check (credential_type in ('person','role','card','fingerprint','face','pin'));

insert into public.employee_device_credentials(
  employee_id,device_id,credential_type,status,verified_count,metadata
)
select link.employee_id,link.device_id,'role','pending',0,
  jsonb_build_object('expected_admin',employee.hikvision_is_admin)
from public.employee_devices link
join public.employees employee on employee.id=link.employee_id
on conflict(employee_id,device_id,credential_type) do nothing;

create or replace function public.record_employee_device_credential_state(
  p_employee_id uuid,p_device_id uuid,p_credential_type text,p_status text,
  p_command_id uuid default null,p_trace_id uuid default null,p_last_error text default null,
  p_verified_count integer default null,p_metadata jsonb default '{}'::jsonb
) returns public.employee_device_credentials
language plpgsql security definer set search_path=public as $$
declare saved public.employee_device_credentials; safe_metadata jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  if p_credential_type not in ('person','role','card','fingerprint','face','pin') then raise exception 'INVALID_CREDENTIAL_TYPE'; end if;
  if p_status not in ('none','pending','processing','captured','synced','failed') then raise exception 'INVALID_CREDENTIAL_STATUS'; end if;
  safe_metadata:=coalesce(p_metadata,'{}'::jsonb)-'fingerData'-'finger_data'-'template'-'faceData'-'password'-'secret'-'token';
  insert into public.employee_device_credentials(employee_id,device_id,credential_type,status,verified_count,
    command_id,trace_id,last_error,last_verified_at,metadata)
  values(p_employee_id,p_device_id,p_credential_type,p_status,coalesce(p_verified_count,0),p_command_id,p_trace_id,
    left(p_last_error,700),case when p_verified_count is not null then now() else null end,safe_metadata)
  on conflict(employee_id,device_id,credential_type) do update set
    status=case when public.employee_device_credentials.credential_type='fingerprint'
      and public.employee_device_credentials.verified_count>0
      and excluded.status in ('pending','processing','failed')
      then public.employee_device_credentials.status else excluded.status end,
    verified_count=case when p_verified_count is null then public.employee_device_credentials.verified_count else excluded.verified_count end,
    command_id=coalesce(excluded.command_id,public.employee_device_credentials.command_id),
    trace_id=coalesce(excluded.trace_id,public.employee_device_credentials.trace_id),
    last_error=excluded.last_error,
    last_verified_at=case when p_verified_count is null then public.employee_device_credentials.last_verified_at else now() end,
    metadata=public.employee_device_credentials.metadata||excluded.metadata,
    updated_at=now()
  returning * into saved;
  perform public.recompute_employee_credential_summary(p_employee_id);
  return saved;
end $$;

revoke all on function public.record_employee_device_credential_state(uuid,uuid,text,text,uuid,uuid,text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.record_employee_device_credential_state(uuid,uuid,text,text,uuid,uuid,text,integer,jsonb) to service_role;

create or replace function public.initialize_employee_device_credential_state()
returns trigger language plpgsql security definer set search_path=public as $$
declare employee public.employees;
begin
  select * into employee from public.employees where id=new.employee_id;
  insert into public.employee_device_credentials(employee_id,device_id,credential_type,status,verified_count,last_error,last_verified_at,metadata)
  values
    (new.employee_id,new.device_id,'person',case when new.sync_status='success' then 'synced' when new.sync_status='failed' then 'failed' else 'pending' end,case when new.sync_status='success' then 1 else 0 end,new.last_error,case when new.sync_status='success' then new.last_synced_at else null end,'{}'::jsonb),
    (new.employee_id,new.device_id,'role','pending',0,null,null,jsonb_build_object('expected_admin',employee.hikvision_is_admin)),
    (new.employee_id,new.device_id,'card',case when employee.card_number is null then 'none' else 'pending' end,0,null,null,'{}'::jsonb),
    (new.employee_id,new.device_id,'fingerprint',case when employee.fingerprint_count>0 then 'pending' else 'none' end,0,null,null,'{}'::jsonb)
  on conflict(employee_id,device_id,credential_type) do nothing;
  return new;
end $$;

-- Persist the canonical role and treat a role change as a person update.
do $migration$
declare original_body text; updated_body text;
begin
  select procedure.prosrc into original_body
  from pg_proc procedure
  where procedure.oid='public.admin_save_employee(jsonb,uuid[],uuid,uuid)'::regprocedure;

  updated_body:=replace(original_body,
    $old$insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,hikvision_employee_no,
      full_name$old$,
    $new$insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,hikvision_employee_no,hikvision_is_admin,
      full_name$new$);
  if updated_body=original_body then raise exception 'admin_save_employee insert column patch failed'; end if;
  original_body:=updated_body;

  updated_body:=replace(original_body,
    $old$trim(p_employee->>'employee_code'),requested_external_id,requested_hikvision_no,trim(p_employee->>'full_name'),$old$,
    $new$trim(p_employee->>'employee_code'),requested_external_id,requested_hikvision_no,
      coalesce((p_employee->>'hikvision_is_admin')::boolean,false),trim(p_employee->>'full_name'),$new$);
  if updated_body=original_body then raise exception 'admin_save_employee insert value patch failed'; end if;
  original_body:=updated_body;

  updated_body:=replace(original_body,
    $old$hikvision_employee_no=requested_hikvision_no,full_name=trim(p_employee->>'full_name')$old$,
    $new$hikvision_employee_no=requested_hikvision_no,
      hikvision_is_admin=coalesce((p_employee->>'hikvision_is_admin')::boolean,false),
      full_name=trim(p_employee->>'full_name')$new$);
  if updated_body=original_body then raise exception 'admin_save_employee update role patch failed'; end if;
  original_body:=updated_body;

  updated_body:=replace(original_body,
    $old$person_changed:=hikvision_no_changed or previous.full_name is distinct from saved.full_name$old$,
    $new$person_changed:=hikvision_no_changed
      or previous.hikvision_is_admin is distinct from saved.hikvision_is_admin
      or previous.full_name is distinct from saved.full_name$new$);
  if updated_body=original_body then raise exception 'admin_save_employee role change patch failed'; end if;

  execute format(
    'create or replace function public.admin_save_employee(p_employee jsonb,p_device_ids uuid[],p_requested_by uuid,p_employee_id uuid default null) returns public.employees language plpgsql security definer set search_path=public as %L',
    updated_body
  );
end $migration$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;

-- Creation sessions use a separate commit function, so persist the same role there.
do $migration$
declare original_body text; updated_body text;
begin
  select procedure.prosrc into original_body
  from pg_proc procedure
  where procedure.oid='public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid)'::regprocedure;

  updated_body:=replace(original_body,
    $old$insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,hikvision_employee_no,
    full_name$old$,
    $new$insert into public.employees(company_id,branch_id,department_id,employee_code,external_employee_id,hikvision_employee_no,hikvision_is_admin,
    full_name$new$);
  if updated_body=original_body then raise exception 'admin_commit_employee_creation_session insert column patch failed'; end if;
  original_body:=updated_body;

  updated_body:=replace(original_body,
    $old$trim(p_employee->>'employee_code'),requested_external_id,creation.employee_no,trim(p_employee->>'full_name'),$old$,
    $new$trim(p_employee->>'employee_code'),requested_external_id,creation.employee_no,
    coalesce((p_employee->>'hikvision_is_admin')::boolean,false),trim(p_employee->>'full_name'),$new$);
  if updated_body=original_body then raise exception 'admin_commit_employee_creation_session insert value patch failed'; end if;

  execute format(
    'create or replace function public.admin_commit_employee_creation_session(p_session_id uuid,p_employee jsonb,p_device_ids uuid[],p_requested_by uuid) returns public.employees language plpgsql security definer set search_path=public as %L',
    updated_body
  );
end $migration$;

revoke all on function public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid) to service_role;

create or replace function public.validate_hikvision_device_command()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  employee_no text:=nullif(trim(new.payload->>'employee_no'),'');
  finger_no integer;
  source_device uuid;
  canonical_admin boolean;
begin
  if new.command_type in (
    'sync_person','update_person','delete_person','sync_card','delete_card',
    'sync_face','delete_face','enroll_fingerprint','delete_fingerprint'
  ) then
    if employee_no is null then raise exception 'HIKVISION_EMPLOYEE_NO_REQUIRED'; end if;
    if employee_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  end if;

  if new.command_type in ('sync_person','update_person') then
    if new.employee_id is not null then
      select employee.hikvision_is_admin into canonical_admin
      from public.employees employee where employee.id=new.employee_id;
      if found then new.payload:=new.payload||jsonb_build_object('local_ui_right',canonical_admin); end if;
    elsif not new.payload?'local_ui_right' then
      new.payload:=new.payload||jsonb_build_object('local_ui_right',false);
    end if;
    if jsonb_typeof(new.payload->'local_ui_right')<>'boolean' then
      raise exception 'HIKVISION_LOCAL_UI_RIGHT_INVALID';
    end if;
  end if;

  if new.command_type='sync_device_people'
    and new.employee_id is not null
    and new.payload->>'mode' in ('verify_employee_credentials','repair_employee_credentials')
  then
    if employee_no is null then raise exception 'HIKVISION_EMPLOYEE_NO_REQUIRED'; end if;
    if employee_no!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  end if;

  if new.command_type='sync_card' and nullif(trim(new.payload->>'card_no'),'') is null then
    raise exception 'HIKVISION_CARD_NO_REQUIRED';
  end if;

  if new.command_type='enroll_fingerprint' then
    begin finger_no:=(new.payload->>'finger_no')::integer;
    exception when others then raise exception 'HIKVISION_FINGER_NO_INVALID'; end;
    if finger_no<1 or finger_no>10 then raise exception 'HIKVISION_FINGER_NO_INVALID'; end if;
    if new.payload->>'mode'='replicate' then
      begin source_device:=(new.payload->>'source_device_id')::uuid;
      exception when others then raise exception 'HIKVISION_FINGERPRINT_SOURCE_REQUIRED'; end;
      if source_device=new.device_id then raise exception 'HIKVISION_FINGERPRINT_SOURCE_EQUALS_DESTINATION'; end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists validate_hikvision_device_command on public.device_commands;
create trigger validate_hikvision_device_command
before insert or update of command_type,payload,employee_id on public.device_commands
for each row execute function public.validate_hikvision_device_command();
