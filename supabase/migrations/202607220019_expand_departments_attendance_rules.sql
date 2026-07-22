-- Expand phase: additive, production-safe model for department scope and real attendance rules.
-- Legacy attendance_groups/work_schedules remain until all consumers have been deployed.

create table if not exists public.migration_snapshots (
  id bigint generated always as identity primary key,
  migration_key text not null,
  table_name text not null,
  row_count integer not null,
  rows jsonb not null,
  created_at timestamptz not null default now(),
  unique (migration_key, table_name)
);

alter table public.migration_snapshots enable row level security;
drop policy if exists "migration_snapshot_admin_select" on public.migration_snapshots;
create policy "migration_snapshot_admin_select" on public.migration_snapshots for select to authenticated
using (public.has_any_role(array['super_admin','it_admin']));
revoke all on public.migration_snapshots from anon, authenticated;
grant select on public.migration_snapshots to authenticated;
grant all on public.migration_snapshots to service_role;

insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220019','attendance_groups',count(*)::integer,coalesce(jsonb_agg(to_jsonb(source)),'[]'::jsonb)
from public.attendance_groups source on conflict do nothing;
insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220019','work_schedules',count(*)::integer,coalesce(jsonb_agg(to_jsonb(source)),'[]'::jsonb)
from public.work_schedules source on conflict do nothing;
insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220019','schedule_rules',count(*)::integer,coalesce(jsonb_agg(to_jsonb(source)),'[]'::jsonb)
from public.schedule_rules source on conflict do nothing;
insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220019','employee_attendance_groups',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object('employee_id',id,'attendance_group_id',attendance_group_id)),'[]'::jsonb)
from public.employees where attendance_group_id is not null on conflict do nothing;
insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220019','daily_attendance_schedules',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object('daily_attendance_id',id,'schedule_id',schedule_id)),'[]'::jsonb)
from public.daily_attendance where schedule_id is not null on conflict do nothing;
insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220019','department_legacy_branches',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object('department_id',id,'branch_id',branch_id)),'[]'::jsonb)
from public.departments on conflict do nothing;

alter table public.departments add column if not exists scope text;
update public.departments set scope=case when branch_id is null then 'global' else 'branch' end where scope is null;
alter table public.departments alter column scope set default 'branch';
alter table public.departments alter column scope set not null;
alter table public.departments drop constraint if exists departments_scope_check;
alter table public.departments add constraint departments_scope_check check (scope in ('global','branch'));

create table if not exists public.department_branches (
  department_id uuid not null references public.departments(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (department_id,branch_id)
);

insert into public.department_branches(department_id,branch_id)
select id,branch_id from public.departments where branch_id is not null
on conflict do nothing;

-- A legacy NULL branch meant company-wide. Materialize every current company branch;
-- future scope changes are explicit through department_branches.
insert into public.department_branches(department_id,branch_id)
select department.id,branch.id
from public.departments department
join public.branches branch on branch.company_id=department.company_id
where department.branch_id is null
on conflict do nothing;

alter table public.departments drop constraint if exists departments_company_id_branch_id_name_key;
create unique index if not exists departments_company_scope_name_uidx
  on public.departments(company_id,scope,lower(name));
create index if not exists department_branches_branch_idx on public.department_branches(branch_id,department_id);

alter table public.department_branches enable row level security;
drop policy if exists "department_branches_role_select" on public.department_branches;
create policy "department_branches_role_select" on public.department_branches for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));
-- Writes are coordinated by admin-departments with the service role.
revoke insert,update,delete on public.department_branches from anon,authenticated;
grant select on public.department_branches to authenticated;
grant all on public.department_branches to service_role;

alter table public.branches add column if not exists unit_type text;
update public.branches set unit_type=case
  when upper(coalesce(code,'')) in ('ADMON','ADMIN','ADMINISTRACION')
    or lower(name) in ('administración','administracion') then 'administration'
  else 'store'
end where unit_type is null;
alter table public.branches alter column unit_type set default 'store';
alter table public.branches alter column unit_type set not null;
alter table public.branches drop constraint if exists branches_unit_type_check;
alter table public.branches add constraint branches_unit_type_check check (unit_type in ('store','administration'));

alter table public.attendance_report_rules
  add column if not exists check_in_tolerance_minutes integer not null default 0,
  add column if not exists check_out_tolerance_minutes integer not null default 0;
alter table public.attendance_report_rules drop constraint if exists attendance_report_rules_check_in_tolerance_check;
alter table public.attendance_report_rules add constraint attendance_report_rules_check_in_tolerance_check check (check_in_tolerance_minutes >= 0);
alter table public.attendance_report_rules drop constraint if exists attendance_report_rules_check_out_tolerance_check;
alter table public.attendance_report_rules add constraint attendance_report_rules_check_out_tolerance_check check (check_out_tolerance_minutes >= 0);

-- Preserve any meaningful legacy schedule not already represented by a real rule.
insert into public.attendance_report_rules(
  company_id,code,name,applicable_unit_type,expected_check_in,expected_check_out,max_break_minutes,
  check_in_tolerance_minutes,check_out_tolerance_minutes,is_active
)
select schedule.company_id,'legacy_schedule_'||replace(schedule.id::text,'-',''),schedule.name,'store',
  schedule.default_check_in,schedule.default_check_out,
  case when schedule.default_lunch_out is not null and schedule.default_lunch_in is not null
    then greatest(0,extract(epoch from (schedule.default_lunch_in-schedule.default_lunch_out))/60)::integer else 60 end,
  schedule.tolerance_minutes,schedule.tolerance_minutes,schedule.is_active
from public.work_schedules schedule
where schedule.default_check_in is not null and schedule.default_check_out is not null
  and not exists (
    select 1 from public.attendance_report_rules rule
    where (rule.company_id=schedule.company_id or rule.company_id is null)
      and rule.applicable_unit_type='store'
      and rule.expected_check_in=schedule.default_check_in
      and rule.expected_check_out=schedule.default_check_out
  )
on conflict (code) do nothing;

alter table public.daily_attendance
  add column if not exists rule_id uuid references public.attendance_report_rules(id) on delete set null;
create index if not exists daily_attendance_rule_id_idx on public.daily_attendance(rule_id);

-- Backfill provenance without changing historical calculated values.
update public.daily_attendance daily
set rule_id=resolved.rule_id
from public.employees employee
join public.branches branch on branch.id=employee.branch_id
cross join lateral (
  select rule.id as rule_id
  from public.attendance_report_rules rule
  left join public.attendance_report_configs config
    on config.rule_id=rule.id and config.branch_id=employee.branch_id
    and (config.department_id is null or config.department_id=employee.department_id)
    and config.is_active
  where rule.is_active
    and (rule.company_id=employee.company_id or rule.company_id is null)
    and rule.applicable_unit_type in (branch.unit_type,case when employee.department_id is not null then 'department' else branch.unit_type end)
  order by (config.department_id=employee.department_id) desc nulls last,
    (config.id is not null) desc,(rule.company_id=employee.company_id) desc,
    (rule.applicable_unit_type=branch.unit_type) desc,rule.created_at
  limit 1
) resolved
where daily.employee_id=employee.id and daily.rule_id is null;

comment on table public.migration_snapshots is 'Audited pre-contract snapshots for reversible production migrations.';
comment on table public.department_branches is 'Explicit branch applicability for global and branch-scoped departments.';
comment on column public.branches.unit_type is 'Controls default attendance rule resolution: store or administration.';

-- Device cleanup commands must survive employee deletion so the gateway can execute and audit them.
alter table public.device_commands drop constraint if exists device_commands_employee_id_fkey;
alter table public.device_commands add constraint device_commands_employee_id_fkey
  foreign key(employee_id) references public.employees(id) on delete set null;
