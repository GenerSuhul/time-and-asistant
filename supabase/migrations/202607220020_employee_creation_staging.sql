-- Coordinated employee creation and biometric staging. No biometric template is persisted.

create table if not exists public.employee_creation_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete restrict,
  department_id uuid references public.departments(id) on delete restrict,
  employee_no text not null,
  full_name text not null,
  status text not null default 'draft' check (status in ('draft','enrolling','captured','committed','cancelled','failed')),
  draft_data jsonb not null default '{}'::jsonb,
  staged_device_ids uuid[] not null default '{}'::uuid[],
  trace_id uuid not null default gen_random_uuid(),
  requested_by uuid references auth.users(id) on delete set null,
  committed_employee_id uuid references public.employees(id) on delete set null,
  error_code text,
  error_message text,
  expires_at timestamptz not null default (now()+interval '20 minutes'),
  committed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists employee_creation_one_active_number_idx
  on public.employee_creation_sessions(company_id,employee_no)
  where status in ('draft','enrolling','captured');
create index if not exists employee_creation_expiry_idx
  on public.employee_creation_sessions(status,expires_at)
  where status in ('draft','enrolling','captured');

drop trigger if exists set_employee_creation_sessions_updated_at on public.employee_creation_sessions;
create trigger set_employee_creation_sessions_updated_at before update on public.employee_creation_sessions
for each row execute function public.set_updated_at();

alter table public.employee_creation_sessions enable row level security;
drop policy if exists "employee_creation_owner_select" on public.employee_creation_sessions;
create policy "employee_creation_owner_select" on public.employee_creation_sessions for select to authenticated
using (requested_by=auth.uid() and public.has_any_role(array['super_admin','it_admin','hr_admin']));
revoke insert,update,delete on public.employee_creation_sessions from anon,authenticated;
grant select on public.employee_creation_sessions to authenticated;
grant all on public.employee_creation_sessions to service_role;

alter table public.biometric_enrollment_sessions alter column employee_id drop not null;
alter table public.device_commands add column if not exists depends_on_command_id uuid references public.device_commands(id) on delete set null;
create index if not exists device_commands_depends_on_idx on public.device_commands(depends_on_command_id) where depends_on_command_id is not null;
alter table public.biometric_enrollment_sessions
  add column if not exists creation_session_id uuid references public.employee_creation_sessions(id) on delete cascade,
  add column if not exists trace_id uuid,
  add column if not exists device_command_id uuid references public.device_commands(id) on delete set null,
  add column if not exists status_detail text,
  add column if not exists worker_started_at timestamptz,
  add column if not exists device_request_started_at timestamptz,
  add column if not exists device_response_at timestamptz;
alter table public.biometric_enrollment_sessions drop constraint if exists biometric_enrollment_subject_check;
alter table public.biometric_enrollment_sessions add constraint biometric_enrollment_subject_check check (
  (employee_id is not null and creation_session_id is null)
  or (employee_id is null and creation_session_id is not null)
);
create unique index if not exists biometric_creation_one_active_idx
  on public.biometric_enrollment_sessions(creation_session_id,device_id,finger_no)
  where status in ('pending','processing');

do $$ begin
  alter publication supabase_realtime add table public.employee_creation_sessions;
exception when duplicate_object then null;
end $$;

create or replace function public.admin_commit_employee_creation_session(
  p_session_id uuid,
  p_employee jsonb,
  p_device_ids uuid[],
  p_requested_by uuid
) returns public.employees
language plpgsql security definer set search_path=public as $$
declare
  creation public.employee_creation_sessions;
  saved public.employees;
  target_device uuid;
  staged_device uuid;
  external_id text;
  safe_metadata jsonb;
  person_payload jsonb;
  staged boolean;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into creation from public.employee_creation_sessions where id=p_session_id for update;
  if not found then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_FOUND'; end if;
  if creation.requested_by is distinct from p_requested_by then raise exception 'EMPLOYEE_CREATION_SESSION_OWNER_MISMATCH'; end if;
  if creation.status not in ('draft','captured') then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_COMMITTABLE:%',creation.status; end if;
  if creation.expires_at<=now() then raise exception 'EMPLOYEE_CREATION_SESSION_EXPIRED'; end if;

  external_id:=coalesce(nullif(trim(p_employee->>'external_employee_id'),''),trim(p_employee->>'employee_code'));
  if external_id is distinct from creation.employee_no then raise exception 'EMPLOYEE_NO_CHANGED_AFTER_STAGING'; end if;
  if exists(select 1 from public.employees where company_id=(p_employee->>'company_id')::uuid and (employee_code=trim(p_employee->>'employee_code') or external_employee_id=external_id))
    then raise exception 'EMPLOYEE_NO_ALREADY_EXISTS'; end if;
  if nullif(p_employee->>'department_id','') is not null and nullif(p_employee->>'branch_id','') is not null
    and not exists(select 1 from public.department_branches where department_id=(p_employee->>'department_id')::uuid and branch_id=(p_employee->>'branch_id')::uuid)
    then raise exception 'DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH'; end if;

  safe_metadata:=coalesce(p_employee->'metadata','{}'::jsonb)-'fingerData'-'finger_data'-'template'-'password'-'secret'-'device_key'-'service_role';
  insert into public.employees(company_id,branch_id,department_id,employee_code,
    external_employee_id,full_name,email,phone,document_number,status,card_number,pin_enabled,hired_at,
    terminated_at,access_valid_from,access_valid_to,metadata,fingerprint_status,fingerprint_count,credential_status)
  values((p_employee->>'company_id')::uuid,nullif(p_employee->>'branch_id','')::uuid,
    nullif(p_employee->>'department_id','')::uuid,trim(p_employee->>'employee_code'),external_id,
    trim(p_employee->>'full_name'),nullif(trim(p_employee->>'email'),''),nullif(trim(p_employee->>'phone'),''),
    nullif(trim(p_employee->>'document_number'),''),(p_employee->>'status')::public.employee_status,
    nullif(trim(p_employee->>'card_number'),''),coalesce((p_employee->>'pin_enabled')::boolean,false),
    nullif(p_employee->>'hired_at','')::date,nullif(p_employee->>'terminated_at','')::date,
    nullif(p_employee->>'access_valid_from','')::date,nullif(p_employee->>'access_valid_to','')::date,safe_metadata,
    case when creation.status='captured' then 'enrolled'::public.enrollment_status else 'none'::public.enrollment_status end,
    case when creation.status='captured' then 1 else 0 end,
    jsonb_build_object(
      'card',case when nullif(trim(p_employee->>'card_number'),'') is null then 'none' else 'pending' end,
      'fingerprint',case when creation.status='captured' then 'enrolled' else 'none' end,
      'face','none','pin',case when coalesce((p_employee->>'pin_enabled')::boolean,false) then 'configured' else 'none' end
    )) returning * into saved;

  person_payload:=jsonb_build_object('employee_no',external_id,'name',saved.full_name,
    'valid_from',coalesce(saved.access_valid_from::text,'2020-01-01')||'T00:00:00',
    'valid_to',coalesce(saved.access_valid_to::text,'2037-12-31')||'T23:59:59');

  foreach target_device in array coalesce(p_device_ids,'{}'::uuid[]) loop
    staged:=target_device=any(creation.staged_device_ids);
    insert into public.employee_devices(employee_id,device_id,external_person_id,sync_status,last_error,last_synced_at)
    values(saved.id,target_device,external_id,
      case when staged and saved.card_number is null then 'success'::public.command_status else 'pending'::public.command_status end,
      null,case when staged then now() else null end)
    on conflict(employee_id,device_id) do update set external_person_id=excluded.external_person_id,
      sync_status=excluded.sync_status,last_error=null,last_synced_at=excluded.last_synced_at;
    if not staged then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target_device,saved.id,'sync_person',p_requested_by,person_payload);
    end if;
    if saved.card_number is not null then
      insert into public.device_commands(device_id,employee_id,command_type,requested_by,payload)
      values(target_device,saved.id,'sync_card',p_requested_by,jsonb_build_object('employee_no',external_id,'card_no',saved.card_number));
    end if;
  end loop;

  foreach staged_device in array creation.staged_device_ids loop
    if not (staged_device=any(coalesce(p_device_ids,'{}'::uuid[]))) then
      insert into public.device_commands(device_id,command_type,requested_by,payload)
      values(staged_device,'delete_person',p_requested_by,jsonb_build_object('employee_no',external_id,'creation_session_id',creation.id));
    end if;
  end loop;

  update public.device_commands set employee_id=saved.id
    where employee_id is null and payload->>'creation_session_id'=creation.id::text;
  update public.biometric_enrollment_sessions set employee_id=saved.id,creation_session_id=null
    where creation_session_id=creation.id;
  update public.employee_creation_sessions set status='committed',committed_employee_id=saved.id,
    committed_at=now(),draft_data='{}'::jsonb,error_code=null,error_message=null where id=creation.id;
  return saved;
end $$;

create or replace function public.admin_cancel_employee_creation_session(
  p_session_id uuid,
  p_requested_by uuid,
  p_reason text default 'cancelled_by_user'
) returns uuid[]
language plpgsql security definer set search_path=public as $$
declare creation public.employee_creation_sessions; staged_device uuid; cleanup_ids uuid[]:='{}'::uuid[]; command_id uuid;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into creation from public.employee_creation_sessions where id=p_session_id for update;
  if not found then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_FOUND'; end if;
  if p_requested_by is not null and creation.requested_by is distinct from p_requested_by then raise exception 'EMPLOYEE_CREATION_SESSION_OWNER_MISMATCH'; end if;
  if creation.status='committed' then raise exception 'EMPLOYEE_CREATION_SESSION_ALREADY_COMMITTED'; end if;
  if creation.status='cancelled' then return cleanup_ids; end if;

  update public.device_commands set status='cancelled',processed_at=now(),error_message='Creation session cancelled'
    where status='pending' and payload->>'creation_session_id'=creation.id::text;
  update public.biometric_enrollment_sessions set status='failed',completed_at=now(),error_message='Creation session cancelled',status_detail='cancelled'
    where creation_session_id=creation.id and status in ('pending','processing');
  foreach staged_device in array creation.staged_device_ids loop
    if exists(select 1 from public.device_commands where device_id=staged_device
      and payload->>'creation_session_id'=creation.id::text and command_type='sync_person' and status in ('processing','success')) then
      insert into public.device_commands(device_id,command_type,requested_by,payload)
      values(staged_device,'delete_person',coalesce(p_requested_by,creation.requested_by),
        jsonb_build_object('employee_no',creation.employee_no,'creation_session_id',creation.id,'cleanup',true))
      returning id into command_id;
      cleanup_ids:=array_append(cleanup_ids,command_id);
    end if;
  end loop;
  update public.employee_creation_sessions set status='cancelled',cancelled_at=now(),draft_data='{}'::jsonb,
    error_code=p_reason,error_message=null where id=creation.id;
  return cleanup_ids;
end $$;

revoke all on function public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid) from public,anon,authenticated;
revoke all on function public.admin_cancel_employee_creation_session(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_commit_employee_creation_session(uuid,jsonb,uuid[],uuid) to service_role;
grant execute on function public.admin_cancel_employee_creation_session(uuid,uuid,text) to service_role;

create or replace function public.admin_stage_employee_fingerprint(
  p_session_id uuid,
  p_device_id uuid,
  p_finger_no integer,
  p_employee jsonb,
  p_requested_by uuid,
  p_trace_id uuid
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare creation public.employee_creation_sessions; device public.devices; enrollment_id uuid; command_id uuid; person_command_id uuid; external_id text; person_payload jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select * into creation from public.employee_creation_sessions where id=p_session_id for update;
  if not found then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_FOUND'; end if;
  if creation.requested_by is distinct from p_requested_by then raise exception 'EMPLOYEE_CREATION_SESSION_OWNER_MISMATCH'; end if;
  if creation.status not in ('draft','failed','captured') then raise exception 'EMPLOYEE_CREATION_SESSION_NOT_COMMITTABLE:%',creation.status; end if;
  if creation.expires_at<=now() then raise exception 'EMPLOYEE_CREATION_SESSION_EXPIRED'; end if;
  external_id:=coalesce(nullif(trim(p_employee->>'external_employee_id'),''),trim(p_employee->>'employee_code'));
  if external_id is distinct from creation.employee_no then raise exception 'EMPLOYEE_NO_CHANGED_AFTER_STAGING'; end if;
  if external_id!~'^[0-9]+$' then raise exception 'HIKVISION_EMPLOYEE_NO_INVALID'; end if;
  select * into device from public.devices where id=p_device_id for update;
  if not found then raise exception 'DEVICE_NOT_FOUND'; end if;
  if device.dev_index is null then raise exception 'DEVICE_NOT_LINKED'; end if;
  if device.status<>'online' then raise exception 'DEVICE_OFFLINE:%',device.name; end if;
  if exists(select 1 from public.biometric_enrollment_sessions where creation_session_id=creation.id and device_id=device.id and finger_no=p_finger_no and status in ('pending','processing'))
    then raise exception 'FINGERPRINT_ENROLLMENT_ALREADY_ACTIVE'; end if;

  person_payload:=jsonb_build_object('employee_no',external_id,'name',trim(p_employee->>'full_name'),
    'valid_from',coalesce(nullif(p_employee->>'access_valid_from',''),'2020-01-01')||'T00:00:00',
    'valid_to',coalesce(nullif(p_employee->>'access_valid_to',''),'2037-12-31')||'T23:59:59',
    'creation_session_id',creation.id,'trace_id',p_trace_id);
  if not (device.id=any(creation.staged_device_ids)) then
    insert into public.device_commands(device_id,command_type,requested_by,payload)
    values(device.id,'sync_person',p_requested_by,person_payload) returning id into person_command_id;
  end if;
  insert into public.biometric_enrollment_sessions(employee_id,creation_session_id,device_id,finger_no,status,requested_by,trace_id,status_detail)
  values(null,creation.id,device.id,p_finger_no,'pending',p_requested_by,p_trace_id,'Preparando persona en el dispositivo')
  returning id into enrollment_id;
  insert into public.device_commands(device_id,command_type,requested_by,payload,depends_on_command_id)
  values(device.id,'enroll_fingerprint',p_requested_by,jsonb_build_object(
    'employee_no',external_id,'finger_no',p_finger_no,'session_id',enrollment_id,
    'creation_session_id',creation.id,'trace_id',p_trace_id
  ),person_command_id) returning id into command_id;
  update public.biometric_enrollment_sessions set device_command_id=command_id where id=enrollment_id;
  update public.employee_creation_sessions set status='enrolling',draft_data=p_employee,
    staged_device_ids=array(select distinct value from unnest(array_append(staged_device_ids,device.id)) value),
    trace_id=p_trace_id,error_code=null,error_message=null,expires_at=now()+interval '20 minutes' where id=creation.id;
  return jsonb_build_object('session_id',creation.id,'enrollment_session_id',enrollment_id,'job_id',command_id,
    'prepare_job_id',person_command_id,'trace_id',p_trace_id);
end $$;

revoke all on function public.admin_stage_employee_fingerprint(uuid,uuid,integer,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.admin_stage_employee_fingerprint(uuid,uuid,integer,jsonb,uuid,uuid) to service_role;

create or replace function public.admin_save_department(
  p_department jsonb,
  p_branch_ids uuid[],
  p_department_id uuid default null
) returns public.departments
language plpgsql security definer set search_path=public as $$
declare saved public.departments; company uuid; requested_scope text; branches uuid[];
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  company:=(p_department->>'company_id')::uuid;
  requested_scope:=p_department->>'scope';
  branches:=array(select distinct value from unnest(coalesce(p_branch_ids,'{}'::uuid[])) value);
  if requested_scope not in ('global','branch') then raise exception 'DEPARTMENT_SCOPE_INVALID'; end if;
  if cardinality(branches)=0 then raise exception 'DEPARTMENT_BRANCH_REQUIRED'; end if;
  if requested_scope='branch' and cardinality(branches)<>1 then raise exception 'DEPARTMENT_BRANCH_SCOPE_REQUIRES_ONE'; end if;
  if exists(select 1 from unnest(branches) as selected(branch_id) left join public.branches branch on branch.id=selected.branch_id
    where branch.id is null or branch.company_id<>company) then raise exception 'DEPARTMENT_BRANCH_COMPANY_MISMATCH'; end if;
  if exists(select 1 from public.departments department where department.company_id=company
    and department.scope=requested_scope and lower(department.name)=lower(trim(p_department->>'name'))
    and department.id is distinct from p_department_id) then raise exception 'DEPARTMENT_DUPLICATE_NAME_SCOPE'; end if;

  if p_department_id is null then
    insert into public.departments(company_id,name,code,scope,is_active)
    values(company,trim(p_department->>'name'),
      nullif(trim(p_department->>'code'),''),requested_scope,coalesce((p_department->>'is_active')::boolean,true))
    returning * into saved;
  else
    update public.departments set company_id=company,name=trim(p_department->>'name'),code=nullif(trim(p_department->>'code'),''),scope=requested_scope,
      is_active=coalesce((p_department->>'is_active')::boolean,true)
    where id=p_department_id returning * into saved;
    if not found then raise exception 'DEPARTMENT_NOT_FOUND'; end if;
  end if;
  delete from public.department_branches where department_id=saved.id;
  insert into public.department_branches(department_id,branch_id) select saved.id,unnest(branches);
  return saved;
end $$;

create or replace function public.admin_delete_department(p_department_id uuid) returns void
language plpgsql security definer set search_path=public as $$
declare employee_count integer; config_count integer; contact_count integer;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  select count(*) into employee_count from public.employees where department_id=p_department_id;
  select count(*) into config_count from public.attendance_report_configs where department_id=p_department_id;
  select count(*) into contact_count from public.attendance_report_contacts where department_id=p_department_id;
  if employee_count+config_count+contact_count>0 then
    raise exception 'DEPARTMENT_IN_USE:employees=%,configs=%,contacts=%',employee_count,config_count,contact_count;
  end if;
  delete from public.departments where id=p_department_id;
  if not found then raise exception 'DEPARTMENT_NOT_FOUND'; end if;
end $$;

revoke all on function public.admin_save_department(jsonb,uuid[],uuid) from public,anon,authenticated;
revoke all on function public.admin_delete_department(uuid) from public,anon,authenticated;
grant execute on function public.admin_save_department(jsonb,uuid[],uuid) to service_role;
grant execute on function public.admin_delete_department(uuid) to service_role;
