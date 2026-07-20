-- Normalized, idempotent realtime/offline attendance event storage.
alter table public.attendance_events
  add column if not exists company_id uuid references public.companies(id) on delete set null,
  add column if not exists device_identifier text,
  add column if not exists dev_index text,
  add column if not exists employee_no text,
  add column if not exists employee_code text,
  add column if not exists person_name text,
  add column if not exists event_time_utc timestamptz,
  add column if not exists event_time_local timestamp without time zone,
  add column if not exists event_date_local date,
  add column if not exists raw_event_type text,
  add column if not exists major integer,
  add column if not exists minor integer,
  add column if not exists attendance_status text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists synced_at timestamptz not null default now(),
  add column if not exists unique_key text;

-- The original enum described business provenance (device/manual/import), not
-- transport provenance. A text constraint lets the event retain realtime vs.
-- offline without losing the existing manual/import values.
alter table public.attendance_events alter column source drop default;
alter table public.attendance_events alter column source type text using source::text;
update public.attendance_events set source = 'realtime' where source = 'device';
alter table public.attendance_events alter column source set default 'realtime';
alter table public.attendance_events drop constraint if exists attendance_events_source_check;
alter table public.attendance_events add constraint attendance_events_source_check
  check (source in ('realtime', 'offline', 'manual', 'import'));

update public.attendance_events ae
set company_id = coalesce(ae.company_id, e.company_id, b.company_id),
    device_identifier = coalesce(ae.device_identifier, d.device_identifier, d.serial_number),
    dev_index = coalesce(ae.dev_index, d.dev_index),
    employee_no = coalesce(ae.employee_no, rae.employee_external_id, e.external_employee_id, e.employee_code),
    employee_code = coalesce(ae.employee_code, e.employee_code),
    person_name = coalesce(ae.person_name, e.full_name),
    event_time_utc = coalesce(ae.event_time_utc, ae.occurred_at),
    event_time_local = coalesce(ae.event_time_local, ae.occurred_at at time zone 'America/Guatemala'),
    event_date_local = coalesce(ae.event_date_local, (ae.occurred_at at time zone 'America/Guatemala')::date),
    raw_event_type = coalesce(ae.raw_event_type, rae.raw_event_type),
    major = coalesce(ae.major, case when rae.raw_payload ->> 'major' ~ '^-?[0-9]+$' then (rae.raw_payload ->> 'major')::integer end),
    minor = coalesce(ae.minor, case when rae.raw_payload ->> 'minor' ~ '^-?[0-9]+$' then (rae.raw_payload ->> 'minor')::integer end),
    attendance_status = coalesce(ae.attendance_status, rae.raw_payload ->> 'attendanceStatus', rae.raw_payload ->> 'attendance_status'),
    raw_payload = case when ae.raw_payload = '{}'::jsonb then coalesce(rae.raw_payload, '{}'::jsonb) else ae.raw_payload end,
    unique_key = coalesce(ae.unique_key, rae.event_hash)
from public.raw_access_events rae
left join public.devices d on d.id = rae.device_id
left join public.branches b on b.id = coalesce(rae.branch_id, d.branch_id)
left join public.employees e on e.id = rae.employee_id
where ae.raw_event_id = rae.id;

update public.attendance_events ae
set company_id = coalesce(ae.company_id, e.company_id, b.company_id),
    employee_code = coalesce(ae.employee_code, e.employee_code),
    person_name = coalesce(ae.person_name, e.full_name),
    event_time_utc = coalesce(ae.event_time_utc, ae.occurred_at),
    event_time_local = coalesce(ae.event_time_local, ae.occurred_at at time zone 'America/Guatemala'),
    event_date_local = coalesce(ae.event_date_local, (ae.occurred_at at time zone 'America/Guatemala')::date),
    unique_key = coalesce(ae.unique_key, encode(extensions.digest(ae.id::text, 'sha256'), 'hex'))
from public.employees e
left join public.branches b on b.id = e.branch_id
where ae.employee_id = e.id;

update public.attendance_events
set event_time_utc = coalesce(event_time_utc, occurred_at),
    event_time_local = coalesce(event_time_local, occurred_at at time zone 'America/Guatemala'),
    event_date_local = coalesce(event_date_local, (occurred_at at time zone 'America/Guatemala')::date),
    unique_key = coalesce(unique_key, encode(extensions.digest(id::text, 'sha256'), 'hex'));

alter table public.attendance_events
  alter column event_time_utc set not null,
  alter column event_time_local set not null,
  alter column event_date_local set not null,
  alter column unique_key set not null;

create unique index if not exists attendance_events_unique_key_uidx
  on public.attendance_events(unique_key);
create index if not exists attendance_events_company_date_idx
  on public.attendance_events(company_id, event_date_local);
create index if not exists attendance_events_device_date_idx
  on public.attendance_events(device_id, event_date_local);
create index if not exists attendance_events_employee_no_date_idx
  on public.attendance_events(employee_no, event_date_local);

comment on column public.attendance_events.event_time_local is
  'Wall-clock timestamp in America/Guatemala; event_time_utc is authoritative.';
comment on column public.attendance_events.unique_key is
  'Hikvision event/log ID when available, otherwise a SHA-256 device/employee/time/type fingerprint.';
