-- Low-latency, observable attendance history synchronization.
create table if not exists public.attendance_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  company_ids uuid[] not null default '{}'::uuid[],
  device_ids uuid[] not null default '{}'::uuid[],
  requested_by uuid not null references auth.users(id) on delete cascade,
  force boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending','processing','calculating','complete','partial','failed')),
  stage text not null default 'queued',
  progress integer not null default 0 check (progress between 0 and 100),
  devices_total integer not null default 0 check (devices_total >= 0),
  devices_done integer not null default 0 check (devices_done >= 0),
  events_found integer not null default 0 check (events_found >= 0),
  events_inserted integer not null default 0 check (events_inserted >= 0),
  events_skipped integer not null default 0 check (events_skipped >= 0),
  error_message text,
  trace_id uuid not null default gen_random_uuid(),
  client_clicked_at timestamptz,
  edge_received_at timestamptz not null default now(),
  queued_at timestamptz not null default now(),
  worker_detected_at timestamptz,
  first_gateway_request_at timestamptz,
  first_gateway_page_at timestamptz,
  last_gateway_page_at timestamptz,
  events_upserted_at timestamptz,
  calculation_started_at timestamptz,
  calculation_finished_at timestamptz,
  realtime_published_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  timing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists attendance_sync_jobs_pending_idx
  on public.attendance_sync_jobs(status, created_at)
  where status = 'pending';
create index if not exists attendance_sync_jobs_date_finished_idx
  on public.attendance_sync_jobs(date, finished_at desc)
  where status in ('complete','partial');
create index if not exists attendance_sync_jobs_requested_by_idx
  on public.attendance_sync_jobs(requested_by, created_at desc);

drop trigger if exists set_attendance_sync_jobs_updated_at on public.attendance_sync_jobs;
create trigger set_attendance_sync_jobs_updated_at
before update on public.attendance_sync_jobs
for each row execute function public.set_updated_at();

alter table public.attendance_sync_jobs enable row level security;
drop policy if exists "attendance_sync_jobs_select_own" on public.attendance_sync_jobs;
create policy "attendance_sync_jobs_select_own"
on public.attendance_sync_jobs for select to authenticated
using (
  requested_by = auth.uid()
  or public.has_any_role(array['super_admin','it_admin'])
);

grant select on public.attendance_sync_jobs to authenticated;
grant all on public.attendance_sync_jobs to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'attendance_sync_jobs'
  ) then
    alter publication supabase_realtime add table public.attendance_sync_jobs;
  end if;
end $$;

-- Exact access patterns used by historical ingestion and the daily report.
create index if not exists attendance_events_event_date_local_idx
  on public.attendance_events(event_date_local);
create index if not exists attendance_events_employee_date_idx
  on public.attendance_events(employee_id, event_date_local, occurred_at);
create index if not exists attendance_events_device_time_idx
  on public.attendance_events(device_id, event_time_utc);
create index if not exists daily_attendance_date_branch_idx
  on public.daily_attendance(attendance_date, branch_id);
create index if not exists employees_company_id_idx
  on public.employees(company_id);

comment on table public.attendance_sync_jobs is
  'Parent jobs for asynchronous DeviceGateway history sync, live progress and latency telemetry.';
