-- Replace broad report configurations with one inactive configuration per
-- explicitly responsible branch manager or department head. Activation is a
-- separate production step so recipient coverage can be validated first.

update public.attendance_report_configs
set is_active = false,
    archived_at = coalesce(archived_at, now())
where is_active = true
  and archived_at is null;

with manager_targets as (
  select distinct
    contact.company_id,
    contact.branch_id,
    branch.unit_type
  from public.attendance_report_contacts contact
  join public.branches branch
    on branch.id = contact.branch_id
   and branch.company_id = contact.company_id
   and branch.is_active = true
  where contact.is_active = true
    and contact.role = 'branch_manager'
    and contact.scope_type = 'branch'
    and contact.branch_id is not null
),
inserted as (
  insert into public.attendance_report_configs (
    company_id,
    branch_id,
    department_id,
    region_id,
    region,
    unit_type,
    is_active,
    send_time,
    timezone,
    rule_id,
    include_excel,
    include_html,
    copy_hr_manager_only_on_violation,
    warnings_trigger_hr_copy,
    copy_commercial_manager,
    scope_type,
    output_mode,
    html_columns,
    column_order
  )
  select
    target.company_id,
    target.branch_id,
    null,
    null,
    null,
    target.unit_type,
    false,
    time '06:00',
    'America/Guatemala',
    rule.id,
    true,
    true,
    true,
    false,
    true,
    'branch',
    'consolidated',
    '{
      "name":true,
      "department":true,
      "schedule":true,
      "actual_check_in":true,
      "actual_check_out":true,
      "attendance_log":true,
      "break_duration":true,
      "break_records":true,
      "worked_period":true,
      "status":true,
      "events":true
    }'::jsonb,
    array[
      'name','department','schedule','actual_check_in','actual_check_out',
      'attendance_log','break_duration','break_records','worked_period','status','events'
    ]::text[]
  from manager_targets target
  cross join lateral (
    select attendance_rule.id
    from public.attendance_report_rules attendance_rule
    where attendance_rule.is_active = true
      and attendance_rule.applicable_unit_type = target.unit_type
      and (attendance_rule.company_id = target.company_id or attendance_rule.company_id is null)
    order by (attendance_rule.company_id = target.company_id) desc, attendance_rule.created_at
    limit 1
  ) rule
  where not exists (
    select 1
    from public.attendance_report_configs existing
    where existing.archived_at is null
      and existing.scope_type = 'branch'
      and existing.branch_id = target.branch_id
  )
  returning id, branch_id
)
insert into public.attendance_report_config_branches(config_id, branch_id)
select id, branch_id
from inserted
on conflict do nothing;

with department_targets as (
  select distinct
    contact.company_id,
    contact.department_id
  from public.attendance_report_contacts contact
  join public.departments department
    on department.id = contact.department_id
   and department.company_id = contact.company_id
   and department.is_active = true
  where contact.is_active = true
    and contact.role = 'department_head'
    and contact.scope_type = 'department'
    and contact.department_id is not null
)
insert into public.attendance_report_configs (
  company_id,
  branch_id,
  department_id,
  region_id,
  region,
  unit_type,
  is_active,
  send_time,
  timezone,
  rule_id,
  include_excel,
  include_html,
  copy_hr_manager_only_on_violation,
  warnings_trigger_hr_copy,
  copy_commercial_manager,
  scope_type,
  output_mode,
  html_columns,
  column_order
)
select
  target.company_id,
  null,
  target.department_id,
  null,
  null,
  'department',
  false,
  time '06:00',
  'America/Guatemala',
  rule.id,
  true,
  true,
  true,
  false,
  false,
  'department',
  'consolidated',
  '{
    "name":true,
    "department":true,
    "schedule":true,
    "actual_check_in":true,
    "actual_check_out":true,
    "attendance_log":true,
    "break_duration":true,
    "break_records":true,
    "worked_period":true,
    "status":true,
    "events":true
  }'::jsonb,
  array[
    'name','department','schedule','actual_check_in','actual_check_out',
    'attendance_log','break_duration','break_records','worked_period','status','events'
  ]::text[]
from department_targets target
cross join lateral (
  select attendance_rule.id
  from public.attendance_report_rules attendance_rule
  where attendance_rule.is_active = true
    and attendance_rule.applicable_unit_type in ('department', 'administration')
    and (attendance_rule.company_id = target.company_id or attendance_rule.company_id is null)
  order by
    (attendance_rule.company_id = target.company_id) desc,
    (attendance_rule.applicable_unit_type = 'department') desc,
    attendance_rule.created_at
  limit 1
) rule
where not exists (
  select 1
  from public.attendance_report_configs existing
  where existing.archived_at is null
    and existing.scope_type = 'department'
    and existing.company_id = target.company_id
    and existing.department_id = target.department_id
);

insert into public.attendance_report_config_branches(config_id, branch_id)
select distinct
  config.id,
  contact_branch.branch_id
from public.attendance_report_configs config
join public.attendance_report_contacts contact
  on contact.company_id = config.company_id
 and contact.department_id = config.department_id
 and contact.is_active = true
 and contact.role = 'department_head'
 and contact.scope_type = 'department'
join public.attendance_report_contact_branches contact_branch
  on contact_branch.contact_id = contact.id
join public.branches branch
  on branch.id = contact_branch.branch_id
 and branch.company_id = config.company_id
 and branch.is_active = true
where config.archived_at is null
  and config.scope_type = 'department'
on conflict do nothing;
