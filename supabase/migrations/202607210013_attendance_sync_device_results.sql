-- Per-device outcome shown by the daily report sync detail dialog.
alter table public.attendance_sync_jobs
  add column if not exists device_results jsonb not null default '[]'::jsonb;

comment on column public.attendance_sync_jobs.device_results is
  'Sanitized per-device sync outcome: name, id, status, counters and exact operational error.';
