-- Saturday attendance and complete pre-delivery report refresh.

alter table public.attendance_report_rules
  add column if not exists saturday_expected_check_out time not null default '13:00';

alter table public.attendance_report_rules
  drop constraint if exists attendance_report_rules_saturday_check_out_check;

alter table public.attendance_report_rules
  add constraint attendance_report_rules_saturday_check_out_check
  check (saturday_expected_check_out >= time '13:00');

comment on column public.attendance_report_rules.saturday_expected_check_out is
  'Minimum Saturday check-out. Saturday keeps the regular expected check-in.';

update public.attendance_report_rules
set saturday_expected_check_out = time '13:00'
where code in ('stores_default', 'administration_default')
  and saturday_expected_check_out is distinct from time '13:00';

update public.attendance_report_configs
set
  html_columns = coalesce(html_columns, '{}'::jsonb) || '{"worked_period":true}'::jsonb,
  column_order = array[
    'name','department','schedule','actual_check_in','actual_check_out',
    'attendance_log','break_duration','break_records','worked_period','status','events'
  ]::text[],
  updated_at = now();
