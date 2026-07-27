-- One global delivery schedule for every attendance report configuration.
-- Monday reports Saturday; Tuesday-Saturday report the previous calendar day.

alter table public.attendance_report_configs
  add column if not exists delivery_weekdays smallint[] not null
  default array[1,2,3,4,5,6]::smallint[];

alter table public.attendance_report_configs
  alter column send_time set default time '07:30';

update public.attendance_report_configs
set send_time = time '07:30',
    delivery_weekdays = array[1,2,3,4,5,6]::smallint[];

alter table public.attendance_report_configs
  drop constraint if exists attendance_report_configs_global_delivery_schedule_check;

alter table public.attendance_report_configs
  add constraint attendance_report_configs_global_delivery_schedule_check
  check (
    send_time = time '07:30'
    and delivery_weekdays = array[1,2,3,4,5,6]::smallint[]
  );

create index if not exists attendance_report_configs_delivery_weekdays_idx
  on public.attendance_report_configs using gin(delivery_weekdays)
  where is_active = true and archived_at is null;

comment on column public.attendance_report_configs.delivery_weekdays is
  'ISO-like delivery weekdays using PostgreSQL/JavaScript numbering: 1 Monday through 6 Saturday. Sunday is excluded globally.';

