-- Configurable, audited and retryable daily attendance email reports.

alter table public.attendance_sync_jobs
  alter column requested_by drop not null;

alter table public.attendance_sync_jobs
  drop constraint if exists attendance_sync_jobs_requested_by_fkey;

alter table public.attendance_sync_jobs
  add constraint attendance_sync_jobs_requested_by_fkey
  foreign key (requested_by) references auth.users(id) on delete set null;

create table if not exists public.attendance_report_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  code text not null unique,
  name text not null,
  applicable_unit_type text not null check (applicable_unit_type in ('store','administration','department')),
  expected_check_in time not null,
  expected_check_out time not null,
  max_break_minutes integer not null check (max_break_minutes >= 0),
  timezone text not null default 'America/Guatemala' check (timezone = 'America/Guatemala'),
  warnings_trigger_hr_copy boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.attendance_report_rules
  (code, name, applicable_unit_type, expected_check_in, expected_check_out, max_break_minutes)
values
  ('stores_default', 'Horario predeterminado de tiendas', 'store', '06:50', '17:00', 60),
  ('administration_default', 'Horario predeterminado de administración', 'administration', '07:00', '17:00', 90)
on conflict (code) do update set
  name = excluded.name,
  applicable_unit_type = excluded.applicable_unit_type,
  expected_check_in = excluded.expected_check_in,
  expected_check_out = excluded.expected_check_out,
  max_break_minutes = excluded.max_break_minutes,
  updated_at = now();

create table if not exists public.attendance_report_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  department_id uuid references public.departments(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null check (role in (
    'custom_to','custom_cc','branch_manager','regional_supervisor','hr_assistant',
    'hr_manager','commercial_manager','department_head'
  )),
  region text,
  is_active boolean not null default true,
  receives_store_reports boolean not null default true,
  receives_administration_reports boolean not null default false,
  only_on_violation boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (email = lower(email)),
  check (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')
);

create unique index if not exists attendance_report_contacts_scope_email_role_uidx
  on public.attendance_report_contacts (
    company_id,
    coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(email), role
  );

create table if not exists public.attendance_report_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  department_id uuid references public.departments(id) on delete cascade,
  region text,
  unit_type text not null check (unit_type in ('store','administration','department')),
  is_active boolean not null default false,
  send_time time not null default '06:00',
  timezone text not null default 'America/Guatemala' check (timezone = 'America/Guatemala'),
  rule_id uuid not null references public.attendance_report_rules(id) on delete restrict,
  include_excel boolean not null default true,
  include_html boolean not null default true,
  copy_hr_manager_only_on_violation boolean not null default true,
  warnings_trigger_hr_copy boolean not null default false,
  copy_commercial_manager boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (unit_type = 'store' and department_id is null)
    or (unit_type in ('administration','department') and department_id is not null)
  )
);

create unique index if not exists attendance_report_configs_scope_uidx
  on public.attendance_report_configs (
    branch_id,
    coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create table if not exists public.attendance_report_runs (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.attendance_report_configs(id) on delete restrict,
  report_date date not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  sync_job_id uuid references public.attendance_sync_jobs(id) on delete set null,
  status text not null default 'pending' check (status in (
    'pending','syncing','generating','queued','sending','sent','partial','failed','skipped'
  )),
  sync_status text,
  has_violations boolean not null default false,
  total_employees integer not null default 0,
  ok_count integer not null default 0,
  warning_count integer not null default 0,
  violation_count integer not null default 0,
  recipients_snapshot jsonb not null default '{"to":[],"cc":[]}'::jsonb,
  subject text,
  summary jsonb not null default '{}'::jsonb,
  excel_path text,
  error_message text,
  generated_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (config_id, report_date)
);

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  report_run_id uuid not null unique references public.attendance_report_runs(id) on delete cascade,
  provider text not null default 'resend' check (provider = 'resend'),
  from_email text not null,
  from_name text not null,
  to_emails text[] not null,
  cc_emails text[] not null default '{}'::text[],
  subject text not null,
  html_body text not null,
  attachment_path text,
  attachment_name text,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 4 check (max_retries between 1 and 10),
  next_retry_at timestamptz not null default now(),
  locked_at timestamptz,
  provider_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(to_emails) > 0)
);

create table if not exists public.email_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.email_outbox(id) on delete cascade,
  report_run_id uuid not null references public.attendance_report_runs(id) on delete cascade,
  attempt integer not null,
  status text not null check (status in ('processing','sent','retry_scheduled','failed')),
  provider text not null default 'resend',
  provider_message_id text,
  http_status integer,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance_report_schedule_logs (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,
  local_time text not null,
  status text not null check (status in ('started','complete','partial','failed')),
  configs_due integer not null default 0,
  runs_created integer not null default 0,
  runs_advanced integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists attendance_report_runs_status_date_idx
  on public.attendance_report_runs(status, report_date, created_at);
create index if not exists email_outbox_pending_idx
  on public.email_outbox(status, next_retry_at)
  where status in ('pending','processing');
create index if not exists attendance_report_contacts_resolution_idx
  on public.attendance_report_contacts(company_id, branch_id, department_id, role)
  where is_active;

create or replace function public.claim_attendance_email_outbox(p_limit integer default 10)
returns setof public.email_outbox
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select id
    from public.email_outbox
    where (
      (status = 'pending' and next_retry_at <= now())
      or (status = 'processing' and locked_at < now() - interval '10 minutes')
    )
    order by next_retry_at, created_at
    for update skip locked
    limit greatest(1, least(p_limit, 50))
  )
  update public.email_outbox o
  set status = 'processing', locked_at = now(), updated_at = now()
  from candidates c
  where o.id = c.id
  returning o.*;
end;
$$;

revoke all on function public.claim_attendance_email_outbox(integer) from public, anon, authenticated;
grant execute on function public.claim_attendance_email_outbox(integer) to service_role;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'attendance_report_rules','attendance_report_contacts','attendance_report_configs',
    'attendance_report_runs','email_outbox'
  ] loop
    execute format('drop trigger if exists set_%s_updated_at on public.%I', table_name, table_name);
    execute format('create trigger set_%s_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
  end loop;

  foreach table_name in array array[
    'attendance_report_rules','attendance_report_contacts','attendance_report_configs'
  ] loop
    execute format('drop trigger if exists audit_%s_changes on public.%I', table_name, table_name);
    execute format('create trigger audit_%s_changes after insert or update or delete on public.%I for each row execute function public.write_audit_log()', table_name, table_name);
  end loop;
end $$;

alter table public.attendance_report_rules enable row level security;
alter table public.attendance_report_contacts enable row level security;
alter table public.attendance_report_configs enable row level security;
alter table public.attendance_report_runs enable row level security;
alter table public.email_outbox enable row level security;
alter table public.email_delivery_logs enable row level security;
alter table public.attendance_report_schedule_logs enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'attendance_report_rules','attendance_report_contacts','attendance_report_configs',
    'attendance_report_runs','email_outbox','email_delivery_logs','attendance_report_schedule_logs'
  ] loop
    execute format('drop policy if exists "attendance_report_admin_select" on public.%I', table_name);
    execute format(
      'create policy "attendance_report_admin_select" on public.%I for select to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
  end loop;

  foreach table_name in array array[
    'attendance_report_rules','attendance_report_contacts','attendance_report_configs'
  ] loop
    execute format('drop policy if exists "attendance_report_admin_insert" on public.%I', table_name);
    execute format('drop policy if exists "attendance_report_admin_update" on public.%I', table_name);
    execute format('drop policy if exists "attendance_report_admin_delete" on public.%I', table_name);
    execute format('create policy "attendance_report_admin_insert" on public.%I for insert to authenticated with check (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))', table_name);
    execute format('create policy "attendance_report_admin_update" on public.%I for update to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin''])) with check (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))', table_name);
    execute format('create policy "attendance_report_admin_delete" on public.%I for delete to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'']))', table_name);
  end loop;
end $$;

grant select, insert, update, delete on public.attendance_report_rules to authenticated;
grant select, insert, update, delete on public.attendance_report_contacts to authenticated;
grant select, insert, update, delete on public.attendance_report_configs to authenticated;
grant select on public.attendance_report_runs, public.email_outbox,
  public.email_delivery_logs, public.attendance_report_schedule_logs to authenticated;
grant all on public.attendance_report_rules, public.attendance_report_contacts,
  public.attendance_report_configs, public.attendance_report_runs, public.email_outbox,
  public.email_delivery_logs, public.attendance_report_schedule_logs to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance_report_runs'
  ) then
    alter publication supabase_realtime add table public.attendance_report_runs;
  end if;
end $$;

comment on table public.attendance_report_configs is 'Per-branch or per-department automatic attendance report configuration.';
comment on table public.email_outbox is 'Retryable Resend delivery queue. Provider credentials never persist in database rows.';
