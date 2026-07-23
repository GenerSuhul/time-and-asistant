-- The installed DS-K1T321MFWX V3.9.3 / DeviceGateway combination was tested
-- repeatedly with fingerprint IDs 1 and 2. Each second download replaces the
-- first, while one template remains usable. Model this observed API limit
-- explicitly instead of leaving an unactionable active incident.

update public.devices
set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
  'credential_capabilities',
  coalesce(metadata->'credential_capabilities','{}'::jsonb)||jsonb_build_object(
    'max_fingerprints_per_person',1,
    'basis','production_api_observation',
    'model','DS-K1T321MFWX',
    'firmware','V3.9.3 build 240701',
    'verified_at','2026-07-23T16:30:00Z'
  )
)
where id='0d4a7f32-ecce-4290-9fa9-269c68d9aec8'
  and name='AC_RNV_IXCAN';

insert into public.credential_audit_events(
  employee_id,device_id,command_id,action,status,trace_id,sanitized_error,metadata
)
select command.employee_id,command.device_id,command.id,
  'acknowledge_device_fingerprint_capacity','success',
  coalesce((command.payload->>'trace_id')::uuid,command.id),null,
  jsonb_build_object(
    'credential_type','fingerprint',
    'canonical_count',2,
    'device_target_count',1,
    'verified_count',1,
    'basis','production_api_observation',
    'contains_biometric_template',false
  )
from public.device_commands command
where command.id='f9da8323-b7f1-4394-b1d0-9e781e26846b'
  and not exists(
    select 1 from public.credential_audit_events event
    where event.command_id=command.id
      and event.action='acknowledge_device_fingerprint_capacity'
  );

update public.employee_device_credentials
set status='synced',last_error=null,last_verified_at=now(),
  metadata=metadata||jsonb_build_object(
    'canonical_count',2,
    'device_target_count',1,
    'device_limited',true,
    'limitation','Este equipo conserva una huella por persona mediante la API instalada.'
  ),
  updated_at=now()
where employee_id='00f3f4cd-322e-44c6-9d5a-4b8c4c4fa13d'
  and device_id='0d4a7f32-ecce-4290-9fa9-269c68d9aec8'
  and credential_type='fingerprint'
  and verified_count=1;

update public.device_commands
set resolution_status='resolved',resolved_at=now(),
  resolution_reason='device_api_capacity_verified_single_fingerprint'
where id='f9da8323-b7f1-4394-b1d0-9e781e26846b'
  and status='failed'
  and resolution_status='active'
  and error_code='HIKVISION_FINGERPRINT_REPLICATION_PARTIAL';
