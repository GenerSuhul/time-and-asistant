create extension if not exists "pgcrypto";

do $$
begin
  create type public.device_protocol as enum ('isup', 'isapi', 'manual', 'mock');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.device_status as enum ('online', 'offline', 'error');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.employee_status as enum ('active', 'inactive', 'suspended');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.enrollment_status as enum ('none', 'pending', 'enrolled', 'failed', 'error');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.auth_method as enum ('fingerprint', 'face', 'card', 'pin', 'unknown');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.access_result as enum ('granted', 'denied', 'unknown');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.attendance_event_type as enum ('check_in', 'lunch_out', 'lunch_in', 'check_out', 'break_out', 'break_in', 'unknown');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.attendance_source as enum ('device', 'manual', 'import');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.daily_attendance_status as enum ('complete', 'late', 'incomplete', 'absent', 'early_leave', 'day_off', 'holiday', 'leave', 'error');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.device_command_type as enum ('sync_person', 'update_person', 'delete_person', 'sync_card', 'sync_face', 'enroll_fingerprint', 'fetch_events', 'reboot', 'sync_time');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.command_status as enum ('pending', 'processing', 'success', 'failed', 'cancelled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.sync_status as enum ('idle', 'syncing', 'failed', 'disabled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.history_sync_status as enum ('success', 'failed', 'partial');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.queue_status as enum ('pending', 'processing', 'success', 'failed');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.biometric_job_type as enum ('enroll_face', 'upload_face', 'enroll_fingerprint', 'upload_fingerprint', 'assign_card', 'assign_pin', 'delete_biometric');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.log_level as enum ('info', 'warning', 'error');
exception when duplicate_object then null;
end $$;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  tax_id text,
  timezone text not null default 'America/Guatemala',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.roles (key, name, description)
values
  ('super_admin', 'Super Admin', 'Full platform administration.'),
  ('it_admin', 'IT Admin', 'Technical administration and device operations.'),
  ('hr_admin', 'HR Admin', 'Human resources and attendance administration.'),
  ('branch_manager', 'Branch Manager', 'Branch level attendance visibility.'),
  ('viewer', 'Viewer', 'Read-only access.')
on conflict (key) do update
set name = excluded.name,
    description = excluded.description,
    updated_at = now();

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  full_name text,
  email text,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, company_id, role_id)
);

create unique index if not exists user_roles_user_company_role_uidx
  on public.user_roles (user_id, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), role_id);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  code text,
  address text,
  timezone text not null default 'America/Guatemala',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, code)
);

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  name text not null,
  code text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, branch_id, name)
);

create table if not exists public.attendance_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  name text not null,
  description text,
  tolerance_minutes integer not null default 5,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.work_schedules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  attendance_group_id uuid references public.attendance_groups(id) on delete set null,
  name text not null,
  timezone text not null default 'America/Guatemala',
  default_check_in time,
  default_lunch_out time,
  default_lunch_in time,
  default_check_out time,
  tolerance_minutes integer not null default 5,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.schedule_rules (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.work_schedules(id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  is_workday boolean not null default true,
  expected_check_in time,
  lunch_out time,
  lunch_in time,
  expected_check_out time,
  tolerance_minutes integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id, day_of_week)
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  department_id uuid references public.departments(id) on delete set null,
  attendance_group_id uuid references public.attendance_groups(id) on delete set null,
  employee_code text not null,
  external_employee_id text,
  full_name text not null,
  email text,
  phone text,
  document_number text,
  status public.employee_status not null default 'active',
  card_number text,
  pin_enabled boolean not null default false,
  face_status public.enrollment_status not null default 'none',
  fingerprint_status public.enrollment_status not null default 'none',
  fingerprint_count integer not null default 0,
  photo_path text,
  metadata jsonb not null default '{}'::jsonb,
  hired_at date,
  terminated_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, employee_code),
  unique (company_id, external_employee_id)
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id) on delete set null,
  name text not null,
  model text,
  serial_number text unique,
  firmware_version text,
  protocol public.device_protocol not null default 'isup',
  device_identifier text unique,
  isup_key_hash text,
  status public.device_status not null default 'offline',
  last_seen_at timestamptz,
  last_ip inet,
  timezone text not null default 'America/Guatemala',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.employee_devices (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  external_person_id text,
  sync_status public.command_status not null default 'pending',
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, device_id)
);

create table if not exists public.device_status_logs (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  status public.device_status not null,
  ip inet,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.device_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  command_type public.device_command_type not null,
  status public.command_status not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  error_message text,
  requested_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.device_command_logs (
  id uuid primary key default gen_random_uuid(),
  device_command_id uuid not null references public.device_commands(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  status public.command_status,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.raw_access_events (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete restrict,
  branch_id uuid references public.branches(id) on delete set null,
  external_event_id text,
  employee_external_id text,
  employee_id uuid references public.employees(id) on delete set null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  raw_event_type text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  auth_method public.auth_method not null default 'unknown',
  access_result public.access_result not null default 'unknown',
  event_hash text not null unique,
  created_at timestamptz not null default now()
);

create unique index if not exists raw_access_events_device_external_event_uidx
  on public.raw_access_events (device_id, external_event_id)
  where external_event_id is not null;

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  raw_event_id uuid references public.raw_access_events(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  branch_id uuid references public.branches(id) on delete set null,
  device_id uuid references public.devices(id) on delete set null,
  event_type public.attendance_event_type not null default 'unknown',
  occurred_at timestamptz not null,
  source public.attendance_source not null default 'device',
  confidence numeric(5,2) not null default 1.0,
  notes text,
  created_at timestamptz not null default now(),
  unique (raw_event_id)
);

create table if not exists public.daily_attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  attendance_date date not null,
  schedule_id uuid references public.work_schedules(id) on delete set null,
  expected_check_in time,
  actual_check_in timestamptz,
  lunch_out timestamptz,
  lunch_in timestamptz,
  expected_check_out time,
  actual_check_out timestamptz,
  worked_minutes integer not null default 0,
  lunch_minutes integer not null default 0,
  late_minutes integer not null default 0,
  early_leave_minutes integer not null default 0,
  overtime_minutes integer not null default 0,
  status public.daily_attendance_status not null default 'absent',
  warnings jsonb not null default '[]'::jsonb,
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, attendance_date)
);

create table if not exists public.attendance_exceptions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  attendance_date date not null,
  exception_type text not null,
  notes text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.holidays (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  holiday_date date not null,
  name text not null,
  is_paid boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, branch_id, holiday_date, name)
);

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  leave_type text not null,
  status text not null default 'pending',
  requested_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table if not exists public.manual_adjustments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,
  attendance_date date not null,
  event_type public.attendance_event_type not null,
  occurred_at timestamptz not null,
  reason text not null,
  status text not null default 'pending',
  requested_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_event_id uuid references public.attendance_events(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  action text not null,
  table_name text not null,
  record_id uuid,
  old_values jsonb,
  new_values jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.device_sync_state (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade unique,
  last_realtime_event_at timestamptz,
  last_history_sync_at timestamptz,
  last_successful_event_at timestamptz,
  last_successful_external_event_id text,
  last_seen_at timestamptz,
  is_online boolean not null default false,
  sync_status public.sync_status not null default 'idle',
  sync_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.device_event_cursors (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade unique,
  cursor_type text not null default 'timestamp',
  cursor_value text,
  last_event_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.device_history_sync_runs (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  from_datetime timestamptz,
  to_datetime timestamptz,
  events_found integer not null default 0,
  events_inserted integer not null default 0,
  events_duplicated integer not null default 0,
  status public.history_sync_status,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.event_ingestion_queue (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references public.devices(id) on delete set null,
  payload jsonb not null,
  status public.queue_status not null default 'pending',
  retry_count integer not null default 0,
  next_retry_at timestamptz not null default now(),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.failed_event_ingestions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid references public.devices(id) on delete set null,
  payload jsonb not null,
  error_message text not null,
  retry_count integer not null default 0,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.biometric_jobs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  job_type public.biometric_job_type not null,
  status public.command_status not null default 'pending',
  payload_metadata jsonb not null default '{}'::jsonb,
  secure_payload_path text,
  error_message text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.biometric_job_logs (
  id uuid primary key default gen_random_uuid(),
  biometric_job_id uuid not null references public.biometric_jobs(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  message text not null,
  level public.log_level not null default 'info',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists branches_company_id_idx on public.branches (company_id);
create index if not exists departments_company_id_idx on public.departments (company_id);
create index if not exists departments_branch_id_idx on public.departments (branch_id);
create index if not exists employees_company_id_idx on public.employees (company_id);
create index if not exists employees_branch_id_idx on public.employees (branch_id);
create index if not exists employees_department_id_idx on public.employees (department_id);
create index if not exists employees_attendance_group_id_idx on public.employees (attendance_group_id);
create index if not exists employees_external_employee_id_idx on public.employees (external_employee_id);
create index if not exists devices_branch_id_idx on public.devices (branch_id);
create index if not exists devices_device_identifier_idx on public.devices (device_identifier);
create index if not exists employee_devices_employee_id_idx on public.employee_devices (employee_id);
create index if not exists employee_devices_device_id_idx on public.employee_devices (device_id);
create index if not exists device_commands_device_id_status_idx on public.device_commands (device_id, status, next_run_at);
create index if not exists raw_access_events_device_id_idx on public.raw_access_events (device_id);
create index if not exists raw_access_events_branch_id_idx on public.raw_access_events (branch_id);
create index if not exists raw_access_events_employee_id_idx on public.raw_access_events (employee_id);
create index if not exists raw_access_events_occurred_at_idx on public.raw_access_events (occurred_at);
create index if not exists attendance_events_employee_id_idx on public.attendance_events (employee_id);
create index if not exists attendance_events_branch_id_idx on public.attendance_events (branch_id);
create index if not exists attendance_events_device_id_idx on public.attendance_events (device_id);
create index if not exists attendance_events_occurred_at_idx on public.attendance_events (occurred_at);
create index if not exists daily_attendance_employee_id_idx on public.daily_attendance (employee_id);
create index if not exists daily_attendance_branch_id_idx on public.daily_attendance (branch_id);
create index if not exists daily_attendance_attendance_date_idx on public.daily_attendance (attendance_date);
create index if not exists device_history_sync_runs_device_id_idx on public.device_history_sync_runs (device_id, started_at desc);
create index if not exists event_ingestion_queue_status_idx on public.event_ingestion_queue (status, next_retry_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'companies','roles','profiles','user_roles','branches','departments','attendance_groups',
    'work_schedules','schedule_rules','employees','devices','employee_devices','device_commands',
    'daily_attendance','attendance_exceptions','holidays','leave_requests','manual_adjustments',
    'device_sync_state','device_event_cursors','event_ingestion_queue','failed_event_ingestions',
    'biometric_jobs'
  ]
  loop
    execute format('drop trigger if exists set_%s_updated_at on public.%I', table_name, table_name);
    execute format('create trigger set_%s_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
  end loop;
end $$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do update
  set email = excluded.email,
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.has_role(role_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.key = role_key
  );
$$;

create or replace function public.has_any_role(role_keys text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid()
      and r.key = any(role_keys)
  );
$$;

create or replace function public.prevent_raw_access_event_mutation()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'raw_access_events is immutable for normal application users';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_raw_access_events_update on public.raw_access_events;
create trigger prevent_raw_access_events_update
before update on public.raw_access_events
for each row execute function public.prevent_raw_access_event_mutation();

drop trigger if exists prevent_raw_access_events_delete on public.raw_access_events;
create trigger prevent_raw_access_events_delete
before delete on public.raw_access_events
for each row execute function public.prevent_raw_access_event_mutation();

create or replace function public.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  record_id uuid;
begin
  record_id := coalesce((to_jsonb(new) ->> 'id')::uuid, (to_jsonb(old) ->> 'id')::uuid);
  insert into public.audit_logs (actor_user_id, action, table_name, record_id, old_values, new_values)
  values (auth.uid(), tg_op, tg_table_name, record_id, to_jsonb(old), to_jsonb(new));
  return coalesce(new, old);
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['employees','devices','work_schedules','manual_adjustments','device_commands','biometric_jobs']
  loop
    execute format('drop trigger if exists audit_%s_changes on public.%I', table_name, table_name);
    execute format('create trigger audit_%s_changes after insert or update or delete on public.%I for each row execute function public.write_audit_log()', table_name, table_name);
  end loop;
end $$;

alter table public.companies enable row level security;
alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.branches enable row level security;
alter table public.departments enable row level security;
alter table public.attendance_groups enable row level security;
alter table public.work_schedules enable row level security;
alter table public.schedule_rules enable row level security;
alter table public.employees enable row level security;
alter table public.employee_devices enable row level security;
alter table public.devices enable row level security;
alter table public.device_status_logs enable row level security;
alter table public.device_commands enable row level security;
alter table public.device_command_logs enable row level security;
alter table public.raw_access_events enable row level security;
alter table public.attendance_events enable row level security;
alter table public.daily_attendance enable row level security;
alter table public.attendance_exceptions enable row level security;
alter table public.holidays enable row level security;
alter table public.leave_requests enable row level security;
alter table public.manual_adjustments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.device_sync_state enable row level security;
alter table public.device_event_cursors enable row level security;
alter table public.device_history_sync_runs enable row level security;
alter table public.event_ingestion_queue enable row level security;
alter table public.failed_event_ingestions enable row level security;
alter table public.biometric_jobs enable row level security;
alter table public.biometric_job_logs enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'companies','roles','branches','departments','attendance_groups','work_schedules','schedule_rules',
    'employees','employee_devices','devices','device_status_logs','device_commands','device_command_logs',
    'raw_access_events','attendance_events','daily_attendance','attendance_exceptions','holidays',
    'leave_requests','manual_adjustments','audit_logs','device_sync_state','device_event_cursors',
    'device_history_sync_runs','event_ingestion_queue','failed_event_ingestions','biometric_jobs',
    'biometric_job_logs'
  ]
  loop
    execute format('drop policy if exists "role_select" on public.%I', table_name);
    execute format(
      'create policy "role_select" on public.%I for select to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'',''branch_manager'',''viewer'']))',
      table_name
    );
  end loop;
end $$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'companies','branches','departments','attendance_groups','work_schedules','schedule_rules',
    'employees','employee_devices','devices','device_commands','attendance_exceptions','holidays',
    'leave_requests','manual_adjustments','biometric_jobs'
  ]
  loop
    execute format('drop policy if exists "admin_insert" on public.%I', table_name);
    execute format('drop policy if exists "admin_update" on public.%I', table_name);
    execute format('drop policy if exists "admin_delete" on public.%I', table_name);
    execute format(
      'create policy "admin_insert" on public.%I for insert to authenticated with check (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
    execute format(
      'create policy "admin_update" on public.%I for update to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin''])) with check (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
    execute format(
      'create policy "admin_delete" on public.%I for delete to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'']))',
      table_name
    );
  end loop;
end $$;

drop policy if exists "users_select_own_profile" on public.profiles;
create policy "users_select_own_profile"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.has_any_role(array['super_admin','it_admin','hr_admin']));

drop policy if exists "users_update_own_profile" on public.profiles;
create policy "users_update_own_profile"
on public.profiles for update
to authenticated
using (id = auth.uid() or public.has_any_role(array['super_admin','it_admin','hr_admin']))
with check (id = auth.uid() or public.has_any_role(array['super_admin','it_admin','hr_admin']));

drop policy if exists "admins_manage_user_roles" on public.user_roles;
create policy "admins_manage_user_roles"
on public.user_roles for all
to authenticated
using (public.has_any_role(array['super_admin','it_admin']))
with check (public.has_any_role(array['super_admin','it_admin']));

drop policy if exists "admins_insert_audit_logs" on public.audit_logs;
create policy "admins_insert_audit_logs"
on public.audit_logs for insert
to authenticated
with check (public.has_any_role(array['super_admin','it_admin','hr_admin']));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('employee-photos', 'employee-photos', false, 5242880, array['image/jpeg','image/png','image/webp']),
  ('event-snapshots', 'event-snapshots', false, 10485760, array['image/jpeg','image/png','image/webp']),
  ('exports', 'exports', false, 52428800, array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated_read_attendance_storage" on storage.objects;
create policy "authenticated_read_attendance_storage"
on storage.objects for select
to authenticated
using (
  bucket_id in ('employee-photos', 'event-snapshots', 'exports')
  and public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer'])
);

drop policy if exists "admins_manage_attendance_storage" on storage.objects;
create policy "admins_manage_attendance_storage"
on storage.objects for all
to authenticated
using (
  bucket_id in ('employee-photos', 'event-snapshots', 'exports')
  and public.has_any_role(array['super_admin','it_admin','hr_admin'])
)
with check (
  bucket_id in ('employee-photos', 'event-snapshots', 'exports')
  and public.has_any_role(array['super_admin','it_admin','hr_admin'])
);
