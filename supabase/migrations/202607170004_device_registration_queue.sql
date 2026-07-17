create table if not exists public.device_registration_requests (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null unique references public.devices(id) on delete cascade,
  encrypted_key text not null,
  iv text not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.device_registration_requests enable row level security;
revoke all on table public.device_registration_requests from public, anon, authenticated;
grant all on table public.device_registration_requests to service_role;

