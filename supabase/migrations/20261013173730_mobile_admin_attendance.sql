-- A clearly-labelled, virtual source for the one authorised administrator's
-- mobile attendance marks.  This is deliberately not a physical Hikvision
-- device and it must never be presented as a hardware access event.
insert into public.devices (
  name,
  protocol,
  device_identifier,
  status,
  timezone,
  metadata
)
values (
  'Marcacion movil administrativa',
  'manual',
  'mobile-admin-web',
  'online',
  'America/Guatemala',
  jsonb_build_object(
    'virtual', true,
    'source', 'mobile_web',
    'physical_hikvision_device', false,
    'purpose', 'auditable_admin_mobile_attendance'
  )
)
on conflict (device_identifier) do nothing;

create table if not exists public.mobile_attendance_marks (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_email text not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  attendance_event_id uuid not null references public.attendance_events(id) on delete restrict,
  event_type public.attendance_event_type not null,
  occurred_at timestamptz not null,
  idempotency_key uuid not null,
  user_agent text,
  created_at timestamptz not null default now(),
  unique (actor_user_id, idempotency_key),
  unique (attendance_event_id)
);

alter table public.mobile_attendance_marks enable row level security;
revoke all on table public.mobile_attendance_marks from public, anon, authenticated;
grant select, insert on table public.mobile_attendance_marks to service_role;

-- This mapping is deliberately private and seed-only. It connects the existing
-- administrator account to the production employee already verified in the
-- credential reconciliation; no browser request can choose or alter it.
create table if not exists public.mobile_attendance_authorizations (
  actor_email text primary key,
  employee_id uuid not null references public.employees(id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (actor_email = lower(actor_email))
);

alter table public.mobile_attendance_authorizations enable row level security;
revoke all on table public.mobile_attendance_authorizations from public, anon, authenticated;
grant select on table public.mobile_attendance_authorizations to service_role;

insert into public.mobile_attendance_authorizations (actor_email, employee_id, is_active)
select 'it.agrisystem@gmail.com', employee.id, true
from public.employees employee
where employee.id = '00f3f4cd-322e-44c6-9d5a-4b8c4c4fa13d'
on conflict (actor_email) do update
set employee_id = excluded.employee_id,
    is_active = excluded.is_active,
    updated_at = now();

create or replace function public.create_mobile_admin_attendance_mark(
  p_actor_user_id uuid,
  p_actor_email text,
  p_employee_id uuid,
  p_event_type public.attendance_event_type,
  p_occurred_at timestamptz,
  p_idempotency_key uuid,
  p_user_agent text default null
)
returns table (
  mark_id uuid,
  attendance_event_id uuid,
  event_type public.attendance_event_type,
  occurred_at timestamptz,
  duplicated boolean
)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_existing public.mobile_attendance_marks;
  v_employee public.employees;
  v_device_id uuid;
  v_raw_event_id uuid;
  v_attendance_event_id uuid;
  v_event_hash text;
  v_raw_payload jsonb;
begin
  -- Serialize repeated taps/retries for the same user click before examining
  -- the idempotency record.  The Edge Function is the only role granted EXECUTE.
  perform pg_advisory_xact_lock(hashtextextended(p_actor_user_id::text || ':' || p_idempotency_key::text, 0));

  select * into v_existing
  from public.mobile_attendance_marks
  where actor_user_id = p_actor_user_id
    and idempotency_key = p_idempotency_key;

  if found then
    return query
    select v_existing.id, v_existing.attendance_event_id, v_existing.event_type, v_existing.occurred_at, true;
    return;
  end if;

  if p_event_type not in ('check_in', 'check_out', 'lunch_out', 'lunch_in', 'break_out', 'break_in') then
    raise exception 'MOBILE_ATTENDANCE_EVENT_TYPE_INVALID';
  end if;

  select e.* into v_employee
  from public.employees e
  join public.mobile_attendance_authorizations authorization
    on authorization.employee_id = e.id
  where e.id = p_employee_id
    and e.status = 'active'
    and authorization.is_active = true
    and authorization.actor_email = lower(p_actor_email);

  if not found then
    raise exception 'MOBILE_ATTENDANCE_EMPLOYEE_NOT_CONFIGURED';
  end if;

  select id into v_device_id
  from public.devices
  where device_identifier = 'mobile-admin-web'
    and protocol = 'manual'
    and (metadata ->> 'virtual') = 'true';

  if v_device_id is null then
    raise exception 'MOBILE_ATTENDANCE_VIRTUAL_DEVICE_MISSING';
  end if;

  v_event_hash := encode(
    extensions.digest(
      'mobile_web:' || p_actor_user_id::text || ':' || p_idempotency_key::text,
      'sha256'
    ),
    'hex'
  );
  v_raw_payload := jsonb_build_object(
    'source', 'mobile_web',
    'virtual_device', true,
    'physical_hikvision_event', false,
    'actor_user_id', p_actor_user_id,
    'actor_email', lower(p_actor_email),
    'event_type', p_event_type,
    'idempotency_key', p_idempotency_key
  );

  insert into public.raw_access_events (
    device_id,
    branch_id,
    employee_external_id,
    employee_id,
    occurred_at,
    raw_event_type,
    raw_payload,
    auth_method,
    access_result,
    event_hash
  )
  values (
    v_device_id,
    v_employee.branch_id,
    coalesce(v_employee.hikvision_employee_no, v_employee.external_employee_id, v_employee.employee_code),
    v_employee.id,
    p_occurred_at,
    'mobile_web:' || p_event_type::text,
    v_raw_payload,
    'unknown',
    'unknown',
    v_event_hash
  )
  returning id into v_raw_event_id;

  insert into public.attendance_events (
    raw_event_id,
    employee_id,
    company_id,
    branch_id,
    device_id,
    device_identifier,
    employee_no,
    employee_code,
    person_name,
    event_type,
    occurred_at,
    event_time_utc,
    event_time_local,
    event_date_local,
    source,
    raw_event_type,
    raw_payload,
    synced_at,
    ingested_at,
    source_seen,
    unique_key,
    confidence
  )
  values (
    v_raw_event_id,
    v_employee.id,
    v_employee.company_id,
    v_employee.branch_id,
    v_device_id,
    'mobile-admin-web',
    coalesce(v_employee.hikvision_employee_no, v_employee.external_employee_id, v_employee.employee_code),
    v_employee.employee_code,
    v_employee.full_name,
    p_event_type,
    p_occurred_at,
    p_occurred_at,
    p_occurred_at at time zone 'America/Guatemala',
    (p_occurred_at at time zone 'America/Guatemala')::date,
    'manual',
    'mobile_web:' || p_event_type::text,
    v_raw_payload,
    now(),
    now(),
    array['manual'],
    v_event_hash,
    1.0
  )
  returning id into v_attendance_event_id;

  insert into public.mobile_attendance_marks (
    actor_user_id,
    actor_email,
    employee_id,
    attendance_event_id,
    event_type,
    occurred_at,
    idempotency_key,
    user_agent
  )
  values (
    p_actor_user_id,
    lower(p_actor_email),
    v_employee.id,
    v_attendance_event_id,
    p_event_type,
    p_occurred_at,
    p_idempotency_key,
    nullif(left(coalesce(p_user_agent, ''), 500), '')
  )
  returning id into mark_id;

  insert into public.audit_logs (
    actor_user_id,
    action,
    table_name,
    record_id,
    new_values
  )
  values (
    p_actor_user_id,
    'MOBILE_ATTENDANCE_MARK',
    'attendance_events',
    v_attendance_event_id,
    jsonb_build_object(
      'source', 'mobile_web',
      'physical_hikvision_event', false,
      'employee_id', v_employee.id,
      'event_type', p_event_type,
      'occurred_at', p_occurred_at,
      'idempotency_key', p_idempotency_key
    )
  );

  attendance_event_id := v_attendance_event_id;
  event_type := p_event_type;
  occurred_at := p_occurred_at;
  duplicated := false;
  return next;
end;
$$;

revoke all on function public.create_mobile_admin_attendance_mark(uuid, text, uuid, public.attendance_event_type, timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_mobile_admin_attendance_mark(uuid, text, uuid, public.attendance_event_type, timestamptz, uuid, text)
  to service_role;

comment on table public.mobile_attendance_marks is
  'Audit trail for the single authorised administrator mobile attendance endpoint. These are virtual/manual marks, never physical Hikvision events.';

comment on table public.mobile_attendance_authorizations is
  'Private allow-list connecting an authorised mobile-marking account to exactly one active employee.';
