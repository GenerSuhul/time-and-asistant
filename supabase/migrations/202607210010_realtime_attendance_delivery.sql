-- Realtime delivery and provenance reconciliation for normalized attendance events.
alter table public.attendance_events
  add column if not exists source_seen text[] not null default '{}'::text[],
  add column if not exists callback_received_at timestamptz,
  add column if not exists ingested_at timestamptz not null default now();

update public.attendance_events
set source_seen = array[source]
where cardinality(source_seen) = 0;

create index if not exists attendance_events_ingested_at_idx
  on public.attendance_events(ingested_at desc);

comment on column public.attendance_events.source_seen is
  'Transport paths that observed the same unique event; realtime and offline reconcile into one row.';
comment on column public.attendance_events.callback_received_at is
  'Timestamp when the private DeviceGateway callback received the event.';
comment on column public.attendance_events.ingested_at is
  'Timestamp when the normalized event was first persisted in Supabase.';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'attendance_events'
  ) then
    alter publication supabase_realtime add table public.attendance_events;
  end if;
end $$;
