-- Additive, backwards-compatible scope model for automatic attendance reports.
-- Existing contacts/configs/runs are preserved and backfilled before constraints.

create table if not exists public.attendance_report_regions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text generated always as (lower(trim(name))) stored,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_name),
  check (length(trim(name)) > 0)
);

insert into public.attendance_report_regions(name)
values ('Norte'),('Sur'),('Oriente'),('Occidente'),('Centro'),('Administración')
on conflict (normalized_name) do nothing;

insert into public.attendance_report_regions(name)
select min(source.region)
from (
  select trim(region) region from public.attendance_report_contacts where nullif(trim(region),'') is not null
  union all
  select trim(region) region from public.attendance_report_configs where nullif(trim(region),'') is not null
) source
group by lower(source.region)
on conflict (normalized_name) do nothing;

alter table public.branches
  add column if not exists region_id uuid references public.attendance_report_regions(id) on delete set null;
create index if not exists branches_region_id_idx on public.branches(region_id) where region_id is not null;

alter table public.attendance_report_contacts
  add column if not exists scope_type text,
  add column if not exists region_id uuid references public.attendance_report_regions(id) on delete restrict;

update public.attendance_report_contacts contact
set region_id=region.id
from public.attendance_report_regions region
where contact.region_id is null
  and nullif(trim(contact.region),'') is not null
  and region.normalized_name=lower(trim(contact.region));

update public.attendance_report_contacts
set scope_type=case
  when department_id is not null then 'department'
  when branch_id is not null then 'branch'
  when region_id is not null then 'region'
  else 'company'
end
where scope_type is null;

alter table public.attendance_report_contacts
  alter column company_id drop not null,
  alter column scope_type set default 'company',
  alter column scope_type set not null;

alter table public.attendance_report_contacts
  drop constraint if exists attendance_report_contacts_scope_type_check;
alter table public.attendance_report_contacts
  add constraint attendance_report_contacts_scope_type_check
  check (scope_type in ('global','company','region','branches','branch','department'));

alter table public.attendance_report_contacts
  drop constraint if exists attendance_report_contacts_scope_shape_check;
alter table public.attendance_report_contacts
  add constraint attendance_report_contacts_scope_shape_check check (
    (scope_type='global' and company_id is null and branch_id is null and department_id is null and region_id is null)
    or (scope_type='company' and company_id is not null and branch_id is null and department_id is null and region_id is null)
    or (scope_type='region' and company_id is not null and branch_id is null and department_id is null and region_id is not null)
    or (scope_type='branches' and company_id is not null and branch_id is null and department_id is null and region_id is null)
    or (scope_type='branch' and company_id is not null and branch_id is not null and department_id is null and region_id is null)
    or (scope_type='department' and company_id is not null and department_id is not null and region_id is null)
  );

create table if not exists public.attendance_report_contact_branches (
  contact_id uuid not null references public.attendance_report_contacts(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(contact_id,branch_id)
);

insert into public.attendance_report_contact_branches(contact_id,branch_id)
select id,branch_id from public.attendance_report_contacts where branch_id is not null
on conflict do nothing;

drop index if exists public.attendance_report_contacts_scope_email_role_uidx;
create unique index attendance_report_contacts_scope_email_role_uidx
  on public.attendance_report_contacts(
    coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid),
    scope_type,
    coalesce(region_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(department_id,'00000000-0000-0000-0000-000000000000'::uuid),
    lower(email),role
  );

alter table public.attendance_report_configs
  add column if not exists scope_type text,
  add column if not exists region_id uuid references public.attendance_report_regions(id) on delete restrict,
  add column if not exists output_mode text not null default 'consolidated',
  add column if not exists html_columns jsonb not null default '{
    "name":true,
    "department":true,
    "schedule":true,
    "actual_check_in":true,
    "actual_check_out":true,
    "attendance_log":true,
    "break_duration":true,
    "break_records":true,
    "status":true,
    "events":true
  }'::jsonb,
  add column if not exists column_order text[] not null default array[
    'name','department','schedule','actual_check_in','actual_check_out',
    'attendance_log','break_duration','break_records','status','events'
  ]::text[];

update public.attendance_report_configs config
set region_id=region.id
from public.attendance_report_regions region
where config.region_id is null
  and nullif(trim(config.region),'') is not null
  and region.normalized_name=lower(trim(config.region));

update public.attendance_report_configs
set scope_type=case
  when department_id is not null then 'department'
  when branch_id is not null then 'branch'
  when region_id is not null then 'region'
  else 'company'
end
where scope_type is null;

alter table public.attendance_report_configs
  alter column company_id drop not null,
  alter column branch_id drop not null,
  alter column scope_type set default 'branch',
  alter column scope_type set not null;

alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_scope_type_check;
alter table public.attendance_report_configs
  add constraint attendance_report_configs_scope_type_check
  check (scope_type in ('global','company','region','branches','branch','department'));

alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_output_mode_check;
alter table public.attendance_report_configs
  add constraint attendance_report_configs_output_mode_check
  check (output_mode in ('consolidated','separate_by_branch'));

alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_unit_type_check;
alter table public.attendance_report_configs
  add constraint attendance_report_configs_unit_type_check
  check (unit_type in ('store','administration','department','mixed'));

alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_check;
alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_scope_shape_check;
alter table public.attendance_report_configs
  add constraint attendance_report_configs_scope_shape_check check (
    (scope_type='global' and company_id is null and branch_id is null and department_id is null and region_id is null)
    or (scope_type='company' and company_id is not null and branch_id is null and department_id is null and region_id is null)
    or (scope_type='region' and company_id is not null and branch_id is null and department_id is null and region_id is not null)
    or (scope_type='branches' and company_id is not null and branch_id is null and department_id is null and region_id is null)
    or (scope_type='branch' and company_id is not null and branch_id is not null and department_id is null and region_id is null)
    or (scope_type='department' and company_id is not null and department_id is not null and region_id is null)
  );

alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_html_columns_object_check;
alter table public.attendance_report_configs
  add constraint attendance_report_configs_html_columns_object_check
  check (jsonb_typeof(html_columns)='object');

create table if not exists public.attendance_report_config_branches (
  config_id uuid not null references public.attendance_report_configs(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(config_id,branch_id)
);

insert into public.attendance_report_config_branches(config_id,branch_id)
select id,branch_id from public.attendance_report_configs where branch_id is not null
on conflict do nothing;

drop index if exists public.attendance_report_configs_scope_uidx;
create index if not exists attendance_report_configs_scope_idx
  on public.attendance_report_configs(scope_type,company_id,region_id,is_active,send_time);

alter table public.attendance_report_runs
  add column if not exists branch_ids uuid[] not null default '{}'::uuid[],
  add column if not exists output_key text,
  add column if not exists scope_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists columns_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists status_detail text,
  add column if not exists skipped_reason text,
  add column if not exists audit_log jsonb not null default '[]'::jsonb;

update public.attendance_report_runs
set branch_ids=case when branch_id is null then '{}'::uuid[] else array[branch_id] end
where cardinality(branch_ids)=0;

update public.attendance_report_runs run
set output_key=case
  when config.output_mode='separate_by_branch' then coalesce(run.branch_id::text,'consolidated')
  else 'consolidated'
end
from public.attendance_report_configs config
where run.config_id=config.id and run.output_key is null;

alter table public.attendance_report_runs
  alter column company_id drop not null,
  alter column branch_id drop not null,
  alter column output_key set not null;

alter table public.attendance_report_runs
  drop constraint if exists attendance_report_runs_config_id_report_date_key;
alter table public.attendance_report_runs
  drop constraint if exists attendance_report_runs_config_date_output_key;
alter table public.attendance_report_runs
  add constraint attendance_report_runs_config_date_output_key unique(config_id,report_date,output_key);

create index if not exists attendance_report_contact_branches_branch_idx
  on public.attendance_report_contact_branches(branch_id,contact_id);
create index if not exists attendance_report_config_branches_branch_idx
  on public.attendance_report_config_branches(branch_id,config_id);
create index if not exists attendance_report_runs_config_output_idx
  on public.attendance_report_runs(config_id,report_date,output_key);

alter table public.attendance_report_regions enable row level security;
alter table public.attendance_report_contact_branches enable row level security;
alter table public.attendance_report_config_branches enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'attendance_report_regions','attendance_report_contact_branches',
    'attendance_report_config_branches'
  ] loop
    execute format('drop policy if exists "attendance_report_scope_admin_select" on public.%I',table_name);
    execute format(
      'create policy "attendance_report_scope_admin_select" on public.%I for select to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
    execute format('drop policy if exists "attendance_report_scope_admin_insert" on public.%I',table_name);
    execute format(
      'create policy "attendance_report_scope_admin_insert" on public.%I for insert to authenticated with check (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
    execute format('drop policy if exists "attendance_report_scope_admin_update" on public.%I',table_name);
    execute format(
      'create policy "attendance_report_scope_admin_update" on public.%I for update to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin''])) with check (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
    execute format('drop policy if exists "attendance_report_scope_admin_delete" on public.%I',table_name);
    execute format(
      'create policy "attendance_report_scope_admin_delete" on public.%I for delete to authenticated using (public.has_any_role(array[''super_admin'',''it_admin'',''hr_admin'']))',
      table_name
    );
  end loop;
end $$;

grant select,insert,update,delete on public.attendance_report_regions,
  public.attendance_report_contact_branches,public.attendance_report_config_branches to authenticated;
grant all on public.attendance_report_regions,
  public.attendance_report_contact_branches,public.attendance_report_config_branches to service_role;

drop trigger if exists set_attendance_report_regions_updated_at on public.attendance_report_regions;
create trigger set_attendance_report_regions_updated_at
before update on public.attendance_report_regions
for each row execute function public.set_updated_at();

drop trigger if exists audit_attendance_report_regions_changes on public.attendance_report_regions;
create trigger audit_attendance_report_regions_changes
after insert or update or delete on public.attendance_report_regions
for each row execute function public.write_audit_log();

comment on table public.attendance_report_regions is
  'Controlled region catalogue used by branches, contacts and automatic report configurations.';
comment on column public.attendance_report_configs.output_mode is
  'consolidated creates one output; separate_by_branch creates one idempotent output per resolved branch.';
comment on column public.attendance_report_configs.html_columns is
  'Enabled HTML email columns. Excel intentionally remains complete for operational compatibility.';
comment on column public.attendance_report_runs.audit_log is
  'Append-only logical state history maintained by report Edge Functions.';
