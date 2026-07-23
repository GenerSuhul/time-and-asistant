-- Active incident lifecycle and queue invariants for physical credentials.
-- This migration does not delete commands, audit history, employees or biometrics.

alter table public.device_commands
  add column if not exists resolution_status text not null default 'active',
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_reason text,
  add column if not exists superseded_by uuid references public.device_commands(id) on delete set null,
  add column if not exists error_code text;

alter table public.device_commands
  drop constraint if exists device_commands_resolution_status_check;
alter table public.device_commands
  add constraint device_commands_resolution_status_check
  check (resolution_status in ('active','resolved','superseded'));

create index if not exists device_commands_active_failures_idx
  on public.device_commands(created_at desc)
  where status='failed' and resolution_status='active';

-- Cancelled commands and closed staging attempts remain auditable, but are not
-- current production incidents.
update public.device_commands
set resolution_status='resolved',resolved_at=coalesce(processed_at,now()),
  resolution_reason=coalesce(resolution_reason,'cancelled_command')
where status='cancelled' and resolution_status='active';

update public.device_commands failed
set resolution_status='superseded',
  resolved_at=(select succeeded.processed_at from public.device_commands succeeded
    where succeeded.device_id=failed.device_id and succeeded.command_type=failed.command_type
      and succeeded.status='success' and succeeded.created_at>failed.created_at
    order by succeeded.created_at desc limit 1),
  resolution_reason='later_device_sync_succeeded',
  superseded_by=(select succeeded.id from public.device_commands succeeded
    where succeeded.device_id=failed.device_id and succeeded.command_type=failed.command_type
      and succeeded.status='success' and succeeded.created_at>failed.created_at
    order by succeeded.created_at desc limit 1)
where failed.status='failed' and failed.resolution_status='active'
  and failed.command_type='sync_device_people'
  and exists(select 1 from public.device_commands succeeded
    where succeeded.device_id=failed.device_id and succeeded.command_type=failed.command_type
      and succeeded.status='success' and succeeded.created_at>failed.created_at);

update public.device_commands command
set resolution_status='resolved',resolved_at=now(),
  resolution_reason=case
    when command.command_type='sync_person' and nullif(trim(command.payload->>'employee_no'),'') is null
      then 'invalid_legacy_command_rejected_by_new_invariant'
    else 'closed_staging_attempt'
  end
where command.status='failed' and command.resolution_status='active'
  and command.employee_id is null
  and (
    (command.command_type='sync_person' and nullif(trim(command.payload->>'employee_no'),'') is null)
    or exists(
      select 1 from public.biometric_enrollment_sessions session
      where session.id=nullif(command.payload->>'session_id','')::uuid
        and session.status in ('failed','timeout','cancelled','success')
    )
  );

create or replace function public.validate_hikvision_device_command()
returns trigger language plpgsql set search_path=public as $$
declare
  employee_no text:=nullif(trim(new.payload->>'employee_no'),'');
  finger_no integer;
  source_device uuid;
begin
  if new.command_type in (
    'sync_person','update_person','delete_person','sync_card','delete_card',
    'sync_face','delete_face','enroll_fingerprint','delete_fingerprint'
  ) then
    if employee_no is null then
      raise exception 'HIKVISION_EMPLOYEE_NO_REQUIRED';
    end if;
    if employee_no!~'^[0-9]+$' then
      raise exception 'HIKVISION_EMPLOYEE_NO_INVALID';
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
before insert or update of command_type,payload on public.device_commands
for each row execute function public.validate_hikvision_device_command();

comment on column public.device_commands.resolution_status is
  'Incident lifecycle: active failures affect UX; resolved/superseded rows remain immutable audit history.';
comment on column public.device_commands.error_code is
  'Stable sanitized machine-readable failure classification.';
