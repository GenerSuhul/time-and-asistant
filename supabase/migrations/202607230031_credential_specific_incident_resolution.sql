-- A partial fingerprint is real state: keep its verified count but do not present
-- it as fully synchronized, and never let a person/role success hide its incident.

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
      and excluded.status in ('pending','processing')
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

-- Materialize already-active deterministic partials correctly without losing the
-- count that the destination hardware did verify.
update public.employee_device_credentials credential
set status='failed',
  command_id=failed.id,
  trace_id=coalesce((failed.payload->>'trace_id')::uuid,failed.id),
  last_error=failed.error_message,
  updated_at=now()
from public.device_commands failed
where credential.credential_type='fingerprint'
  and failed.id=(
    select command.id
    from public.device_commands command
    where command.employee_id=credential.employee_id
      and command.device_id=credential.device_id
      and command.command_type='enroll_fingerprint'
      and command.status='failed'
      and command.resolution_status='active'
      and command.error_code in (
        'HIKVISION_FINGERPRINT_REPLICATION_PARTIAL',
        'HIKVISION_FINGERPRINT_REPLICATION_UNSUPPORTED',
        'HIKVISION_FINGERPRINT_POST_VERIFY_UNSUPPORTED'
      )
    order by command.created_at desc
    limit 1
  );
