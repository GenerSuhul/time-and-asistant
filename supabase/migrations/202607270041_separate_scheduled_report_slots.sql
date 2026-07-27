-- A manual/test run for a report date must not consume the automatic delivery
-- slot. Scheduled runs are idempotent per delivery day and output.

alter table public.attendance_report_runs
  add column if not exists delivery_slot_date date,
  add column if not exists run_source text not null default 'manual';

alter table public.attendance_report_runs
  drop constraint if exists attendance_report_runs_run_source_check;

alter table public.attendance_report_runs
  add constraint attendance_report_runs_run_source_check
  check (run_source in ('manual', 'scheduled'));

alter table public.attendance_report_runs
  drop constraint if exists attendance_report_runs_config_date_output_key;

drop index if exists public.attendance_report_runs_config_date_output_key;
drop index if exists public.attendance_report_runs_manual_report_uidx;
drop index if exists public.attendance_report_runs_delivery_slot_uidx;

create unique index attendance_report_runs_manual_report_uidx
  on public.attendance_report_runs(config_id, report_date, output_key)
  where delivery_slot_date is null;

create unique index attendance_report_runs_delivery_slot_uidx
  on public.attendance_report_runs(config_id, delivery_slot_date, output_key)
  where delivery_slot_date is not null;

-- The 20 active outputs for Saturday 2026-07-25 were sent as a controlled test
-- on Sunday night. Reserve Monday's slot with those runs so this migration cannot
-- cause a duplicate delivery when the new scheduler version is deployed later
-- on Monday.
update public.attendance_report_runs run
set delivery_slot_date = date '2026-07-27'
from public.attendance_report_configs config
where run.config_id = config.id
  and config.is_active = true
  and config.archived_at is null
  and run.report_date = date '2026-07-25'
  and run.created_at >= timestamptz '2026-07-27 01:50:00+00'
  and run.created_at < timestamptz '2026-07-27 01:51:00+00';

comment on column public.attendance_report_runs.delivery_slot_date is
  'Guatemala delivery date consumed by a scheduled run; null for manual/test runs.';

comment on column public.attendance_report_runs.run_source is
  'Origin of the run: manual or scheduled.';
