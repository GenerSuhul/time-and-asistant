alter table public.device_registration_requests
  alter column encrypted_key drop not null,
  alter column iv drop not null,
  add column if not exists status text not null default 'pending',
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz;

alter table public.device_registration_requests
  drop constraint if exists device_registration_requests_status_check;

alter table public.device_registration_requests
  add constraint device_registration_requests_status_check
  check (status in ('pending', 'processing', 'success', 'failed'));

create index if not exists device_registration_requests_pending_idx
  on public.device_registration_requests (next_attempt_at, created_at)
  where status in ('pending', 'failed');

