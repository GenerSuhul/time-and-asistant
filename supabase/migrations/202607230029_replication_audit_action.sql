-- Canonical audit event for fingerprint replication commands. Existing stage
-- events remain as immutable history; this adds the unambiguous operation name.

insert into public.credential_audit_events(
  employee_id,device_id,command_id,action,status,trace_id,sanitized_error,metadata,created_at
)
select command.employee_id,command.device_id,command.id,'replicate_fingerprint',
  command.status::text,
  case when coalesce(command.payload->>'trace_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (command.payload->>'trace_id')::uuid else command.id end,
  left(command.error_message,700),
  jsonb_strip_nulls(jsonb_build_object(
    'credential_type','fingerprint',
    'source_device_id',command.payload->>'source_device_id',
    'destination_device_id',command.device_id,
    'finger_no',command.payload->'finger_no',
    'finger_nos',command.payload->'finger_nos',
    'contains_biometric_template',false
  )),
  coalesce(command.processed_at,command.created_at)
from public.device_commands command
where command.command_type='enroll_fingerprint'
  and command.payload->>'mode'='replicate'
  and command.status in ('success','failed','cancelled')
  and not exists(
    select 1 from public.credential_audit_events event
    where event.command_id=command.id and event.action='replicate_fingerprint'
  );
