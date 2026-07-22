-- Successful legacy enrollment commands executed CaptureFingerPrint followed by
-- FingerPrintDownload (the AddFingerPrint materialization). Backfill those two
-- template-free audit stages without modifying any physical credential.

insert into public.credential_audit_events(
  employee_id,creation_session_id,device_id,command_id,action,status,trace_id,metadata,created_at
)
select command.employee_id,nullif(command.payload->>'creation_session_id','')::uuid,command.device_id,command.id,
  action.name,'success',case when coalesce(command.payload->>'trace_id','')~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (command.payload->>'trace_id')::uuid else command.id end,
  jsonb_strip_nulls(jsonb_build_object('credential_type','fingerprint','finger_no',command.payload->'finger_no',
    'historical_backfill',true,'contains_biometric_template',false)),command.created_at
from public.device_commands command
cross join (values('FingerPrintDownload'),('AddFingerPrint')) action(name)
where command.command_type='enroll_fingerprint' and command.status='success'
  and not exists(select 1 from public.credential_audit_events event
    where event.command_id=command.id and event.action=action.name and event.status='success');
