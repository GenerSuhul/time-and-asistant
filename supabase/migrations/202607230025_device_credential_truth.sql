-- Per-device credential truth and durable, template-free credential auditing.
-- No biometric template is stored by this migration.

insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607230025','employee_credential_summary',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'fingerprint_status',fingerprint_status,'fingerprint_count',fingerprint_count,
    'credential_status',credential_status
  ) order by id),'[]'::jsonb)
from public.employees on conflict do nothing;

insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607230025','employee_device_sync',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'employee_id',employee_id,'device_id',device_id,'external_person_id',external_person_id,
    'sync_status',sync_status,'last_synced_at',last_synced_at,'last_error',last_error
  ) order by id),'[]'::jsonb)
from public.employee_devices on conflict do nothing;

create table if not exists public.employee_device_credentials (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  credential_type text not null check (credential_type in ('person','card','fingerprint','face','pin')),
  status text not null default 'pending' check (status in ('none','pending','processing','captured','synced','failed')),
  verified_count integer not null default 0 check (verified_count >= 0),
  command_id uuid references public.device_commands(id) on delete set null,
  trace_id uuid,
  last_error text,
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(employee_id,device_id,credential_type)
);

create index if not exists employee_device_credentials_employee_idx
  on public.employee_device_credentials(employee_id,device_id);
create index if not exists employee_device_credentials_attention_idx
  on public.employee_device_credentials(status,credential_type) where status in ('pending','failed');

create table if not exists public.credential_audit_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete set null,
  creation_session_id uuid references public.employee_creation_sessions(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  command_id uuid references public.device_commands(id) on delete set null,
  action text not null,
  status text not null check (status in ('pending','processing','success','failed','cancelled')),
  trace_id uuid not null,
  sanitized_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Employee deletion must leave its already-enqueued physical cleanup command alive.
alter table public.device_commands drop constraint if exists device_commands_employee_id_fkey;
alter table public.device_commands add constraint device_commands_employee_id_fkey
  foreign key(employee_id) references public.employees(id) on delete set null;

create index if not exists credential_audit_employee_created_idx
  on public.credential_audit_events(employee_id,created_at desc);
create index if not exists credential_audit_device_created_idx
  on public.credential_audit_events(device_id,created_at desc);
create index if not exists credential_audit_trace_idx on public.credential_audit_events(trace_id);

alter table public.biometric_enrollment_sessions
  add column if not exists verified_count integer check (verified_count is null or verified_count >= 0);

alter table public.employee_device_credentials enable row level security;
alter table public.credential_audit_events enable row level security;
drop policy if exists "credential_device_admin_select" on public.employee_device_credentials;
create policy "credential_device_admin_select" on public.employee_device_credentials for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));
drop policy if exists "credential_audit_admin_select" on public.credential_audit_events;
create policy "credential_audit_admin_select" on public.credential_audit_events for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));
revoke insert,update,delete on public.employee_device_credentials from anon,authenticated;
revoke insert,update,delete on public.credential_audit_events from anon,authenticated;
grant select on public.employee_device_credentials,public.credential_audit_events to authenticated;
grant all on public.employee_device_credentials,public.credential_audit_events to service_role;

drop trigger if exists set_employee_device_credentials_updated_at on public.employee_device_credentials;
create trigger set_employee_device_credentials_updated_at before update on public.employee_device_credentials
for each row execute function public.set_updated_at();

create or replace function public.recompute_employee_credential_summary(p_employee_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare fp_count integer; fp_status text; card_status text; current_status jsonb;
begin
  select coalesce(max(verified_count),0) into fp_count
  from public.employee_device_credentials
  where employee_id=p_employee_id and credential_type='fingerprint'
    and status in ('captured','synced') and last_verified_at is not null;

  if fp_count>0 then
    fp_status:='enrolled';
    update public.employee_device_credentials
    set status='pending',last_error=null,
      metadata=metadata||jsonb_build_object('reason','capture_required_on_this_device')
    where employee_id=p_employee_id and credential_type='fingerprint'
      and status='none' and verified_count=0;
  elsif exists(select 1 from public.employee_device_credentials where employee_id=p_employee_id and credential_type='fingerprint' and status='failed') then
    fp_status:='failed';
  elsif exists(select 1 from public.employee_device_credentials where employee_id=p_employee_id and credential_type='fingerprint' and status in ('pending','processing')) then
    fp_status:='pending';
  else fp_status:='none'; end if;

  select case
    when bool_or(status='synced') then 'enrolled'
    when bool_or(status='failed') then 'failed'
    when bool_or(status in ('pending','processing')) then 'pending'
    else 'none' end into card_status
  from public.employee_device_credentials where employee_id=p_employee_id and credential_type='card';

  select coalesce(credential_status,'{}'::jsonb) into current_status from public.employees where id=p_employee_id;
  update public.employees set fingerprint_count=fp_count,
    fingerprint_status=fp_status::public.enrollment_status,
    credential_status=current_status||jsonb_build_object('fingerprint',fp_status,'card',coalesce(card_status,'none'))
  where id=p_employee_id;
end $$;

revoke all on function public.recompute_employee_credential_summary(uuid) from public,anon,authenticated;
grant execute on function public.recompute_employee_credential_summary(uuid) to service_role;

create or replace function public.record_employee_device_credential_state(
  p_employee_id uuid,p_device_id uuid,p_credential_type text,p_status text,
  p_command_id uuid default null,p_trace_id uuid default null,p_last_error text default null,
  p_verified_count integer default null,p_metadata jsonb default '{}'::jsonb
) returns public.employee_device_credentials
language plpgsql security definer set search_path=public as $$
declare saved public.employee_device_credentials; safe_metadata jsonb;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;
  if p_credential_type not in ('person','card','fingerprint','face','pin') then raise exception 'INVALID_CREDENTIAL_TYPE'; end if;
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
  insert into public.employee_device_credentials(employee_id,device_id,credential_type,status,verified_count,last_error,last_verified_at)
  values
    (new.employee_id,new.device_id,'person',case when new.sync_status='success' then 'synced' when new.sync_status='failed' then 'failed' else 'pending' end,case when new.sync_status='success' then 1 else 0 end,new.last_error,case when new.sync_status='success' then new.last_synced_at else null end),
    (new.employee_id,new.device_id,'card',case when employee.card_number is null then 'none' else 'pending' end,0,null,null),
    (new.employee_id,new.device_id,'fingerprint',case when employee.fingerprint_count>0 then 'pending' else 'none' end,0,null,null)
  on conflict(employee_id,device_id,credential_type) do nothing;
  return new;
end $$;

drop trigger if exists initialize_employee_device_credentials on public.employee_devices;
create trigger initialize_employee_device_credentials after insert on public.employee_devices
for each row execute function public.initialize_employee_device_credential_state();

create or replace function public.materialize_verified_enrollment_state()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.employee_id is not null and new.status='success' and coalesce(new.verified_count,0)>0
    and (old.employee_id is distinct from new.employee_id or old.status is distinct from new.status or old.verified_count is distinct from new.verified_count) then
    perform public.record_employee_device_credential_state(new.employee_id,new.device_id,'fingerprint','captured',
      new.device_command_id,new.trace_id,null,new.verified_count,jsonb_build_object('finger_no',new.finger_no));
  end if;
  return new;
end $$;

drop trigger if exists materialize_verified_enrollment_state on public.biometric_enrollment_sessions;
create trigger materialize_verified_enrollment_state after update on public.biometric_enrollment_sessions
for each row execute function public.materialize_verified_enrollment_state();

-- Conservative backfill: device synchronization proves person presence only. Historical
-- fingerprint successes require a fresh DeviceGateway snapshot before becoming active.
insert into public.employee_device_credentials(employee_id,device_id,credential_type,status,verified_count,last_error,last_verified_at)
select employee_id,device_id,'person',case when sync_status='success' then 'synced' when sync_status='failed' then 'failed' else 'pending' end,
  case when sync_status='success' then 1 else 0 end,last_error,case when sync_status='success' then last_synced_at else null end
from public.employee_devices on conflict(employee_id,device_id,credential_type) do nothing;

insert into public.employee_device_credentials(employee_id,device_id,credential_type,status,verified_count)
select link.employee_id,link.device_id,'card',case when employee.card_number is null then 'none' else 'pending' end,0
from public.employee_devices link join public.employees employee on employee.id=link.employee_id
on conflict(employee_id,device_id,credential_type) do nothing;

insert into public.employee_device_credentials(employee_id,device_id,credential_type,status,verified_count,metadata)
select link.employee_id,link.device_id,'fingerprint',
  case when exists(select 1 from public.device_commands command where command.employee_id=link.employee_id
    and command.device_id=link.device_id and command.command_type='enroll_fingerprint' and command.status='success')
    then 'pending' else 'none' end,0,
  case when exists(select 1 from public.device_commands command where command.employee_id=link.employee_id
    and command.device_id=link.device_id and command.command_type='enroll_fingerprint' and command.status='success')
    then jsonb_build_object('reason','device_verification_required') else '{}'::jsonb end
from public.employee_devices link
on conflict(employee_id,device_id,credential_type) do nothing;

insert into public.credential_audit_events(employee_id,creation_session_id,device_id,command_id,action,status,trace_id,sanitized_error,metadata,created_at)
select command.employee_id,nullif(command.payload->>'creation_session_id','')::uuid,command.device_id,command.id,
  case command.command_type
    when 'enroll_fingerprint' then case when coalesce(command.error_message,'') like '%FingerPrintDownload%' then 'FingerPrintDownload' else 'CaptureFingerPrint' end
    when 'update_person' then 'sync_person'
    else command.command_type::text end,
  command.status::text,case when coalesce(command.payload->>'trace_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (command.payload->>'trace_id')::uuid else command.id end,
  left(command.error_message,700),jsonb_strip_nulls(jsonb_build_object(
    'credential_type',case when command.command_type in ('sync_person','update_person','delete_person') then 'person'
      when command.command_type in ('sync_card','delete_card') then 'card'
      when command.command_type in ('enroll_fingerprint','delete_fingerprint') then 'fingerprint'
      when command.command_type in ('sync_face','delete_face') then 'face' end,
    'finger_no',command.payload->'finger_no','historical_backfill',true)),command.created_at
from public.device_commands command
where command.command_type in ('sync_person','update_person','delete_person','sync_card','delete_card','enroll_fingerprint','delete_fingerprint','sync_face','delete_face');

do $$ declare employee record; begin
  for employee in select id from public.employees loop
    perform public.recompute_employee_credential_summary(employee.id);
  end loop;
end $$;

do $$ begin alter publication supabase_realtime add table public.employee_device_credentials;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.credential_audit_events;
exception when duplicate_object then null; end $$;

comment on table public.employee_device_credentials is 'Template-free, DeviceGateway-verified credential state per employee and physical device.';
comment on table public.credential_audit_events is 'Sanitized audit trail for person and credential provisioning. Biometric templates are forbidden.';
