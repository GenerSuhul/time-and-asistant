-- Verify batch fingerprint replication payloads and close legacy incidents that
-- have since been superseded by a successful physical reconciliation.

create or replace function public.validate_fingerprint_replication_batch()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.command_type='enroll_fingerprint' and new.payload->>'mode'='replicate' then
    if jsonb_typeof(new.payload->'finger_nos') is distinct from 'array'
      or jsonb_array_length(new.payload->'finger_nos')<1
    then raise exception 'HIKVISION_FINGER_NOS_REQUIRED'; end if;
    if exists(
      select 1 from jsonb_array_elements_text(new.payload->'finger_nos') value
      where value!~'^[0-9]+$' or value::integer<1 or value::integer>10
    ) then raise exception 'HIKVISION_FINGER_NO_INVALID'; end if;
  end if;
  return new;
end $$;

drop trigger if exists validate_fingerprint_replication_batch on public.device_commands;
create trigger validate_fingerprint_replication_batch
before insert or update of command_type,payload on public.device_commands
for each row execute function public.validate_fingerprint_replication_batch();

update public.device_commands failed
set resolution_status='superseded',resolved_at=now(),
  resolution_reason='later_device_sync_succeeded',
  superseded_by=(select succeeded.id from public.device_commands succeeded
    where succeeded.device_id=failed.device_id
      and succeeded.command_type='sync_device_people'
      and succeeded.status='success'
      and succeeded.created_at>failed.created_at
    order by succeeded.created_at desc limit 1)
where failed.status='failed' and failed.resolution_status='active'
  and failed.command_type='sync_device_people'
  and exists(select 1 from public.device_commands succeeded
    where succeeded.device_id=failed.device_id
      and succeeded.command_type='sync_device_people'
      and succeeded.status='success'
      and succeeded.created_at>failed.created_at);

update public.device_commands command
set resolution_status='resolved',resolved_at=now(),
  resolution_reason='orphaned_legacy_staging_attempt_closed'
where command.status='failed' and command.resolution_status='active'
  and command.employee_id is null
  and command.created_at<now()-interval '1 hour'
  and not exists(
    select 1 from public.biometric_enrollment_sessions session
    where session.id=case
      when coalesce(command.payload->>'session_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (command.payload->>'session_id')::uuid else null end
      and session.status in ('pending','processing')
  );
