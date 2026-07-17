-- Employee/device synchronization and biometric enrollment lifecycle.
alter type public.device_command_type add value if not exists 'sync_device_people';

create table if not exists public.employee_credentials (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  credential_type text not null check (credential_type in ('card','fingerprint','face','pin')),
  external_reference text,
  masked_value text,
  status public.command_status not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, credential_type, external_reference)
);

create table if not exists public.biometric_enrollment_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  biometric_type text not null default 'fingerprint' check (biometric_type = 'fingerprint'),
  finger_no smallint not null default 1 check (finger_no between 1 and 10),
  status text not null default 'pending' check (status in ('pending','processing','success','failed','timeout')),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_devices
  add column if not exists last_error text,
  add column if not exists last_attempt_at timestamptz;

alter table public.device_commands
  add column if not exists employee_id uuid references public.employees(id) on delete cascade;

alter table public.daily_attendance
  add column if not exists break_records jsonb not null default '[]'::jsonb,
  add column if not exists device_ids uuid[] not null default '{}'::uuid[];

create index if not exists employee_credentials_employee_id_idx on public.employee_credentials(employee_id);
create index if not exists device_commands_employee_id_idx on public.device_commands(employee_id);
create index if not exists biometric_enrollment_sessions_status_idx on public.biometric_enrollment_sessions(status, created_at);

drop trigger if exists set_employee_credentials_updated_at on public.employee_credentials;
create trigger set_employee_credentials_updated_at before update on public.employee_credentials
for each row execute function public.set_updated_at();
drop trigger if exists set_biometric_enrollment_sessions_updated_at on public.biometric_enrollment_sessions;
create trigger set_biometric_enrollment_sessions_updated_at before update on public.biometric_enrollment_sessions
for each row execute function public.set_updated_at();

alter table public.employee_credentials enable row level security;
alter table public.biometric_enrollment_sessions enable row level security;

drop policy if exists "role_select" on public.employee_credentials;
create policy "role_select" on public.employee_credentials for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));
drop policy if exists "role_select" on public.biometric_enrollment_sessions;
create policy "role_select" on public.biometric_enrollment_sessions for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));

-- Mutations are service-role only through admin-employees. No browser write policy is granted.

do $$
begin
  alter publication supabase_realtime add table public.employee_devices;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.biometric_enrollment_sessions;
exception when duplicate_object then null;
end $$;
