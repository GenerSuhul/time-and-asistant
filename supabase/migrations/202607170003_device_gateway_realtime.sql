-- Device connectivity is backend-owned. This migration is additive and production-safe.
alter type public.device_protocol add value if not exists 'hik_devicegateway';
alter type public.device_command_type add value if not exists 'delete_card';
alter type public.device_command_type add value if not exists 'delete_face';
alter type public.device_command_type add value if not exists 'delete_fingerprint';
alter type public.device_command_type add value if not exists 'remote_door';
alter type public.device_command_type add value if not exists 'sync_permission_schedule';

alter table public.devices
  add column if not exists dev_index text,
  add column if not exists gateway_url text,
  add column if not exists connection_mode text not null default 'devicegateway',
  add column if not exists status_reason text not null default 'no_events',
  add column if not exists offline_timeout_seconds integer not null default 300;

alter table public.devices
  drop constraint if exists devices_offline_timeout_seconds_check;
alter table public.devices
  add constraint devices_offline_timeout_seconds_check
  check (offline_timeout_seconds between 30 and 86400);

create unique index if not exists devices_dev_index_uidx
  on public.devices (dev_index) where dev_index is not null;
create index if not exists devices_last_seen_at_idx on public.devices (last_seen_at);

-- Browser writes are routed through admin-devices so connectivity fields cannot be forged.
drop policy if exists "admin_insert" on public.devices;
drop policy if exists "admin_update" on public.devices;
drop policy if exists "admin_delete" on public.devices;

create or replace function public.mark_stale_devices_offline()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  with stale as (
    update public.devices
       set status = 'offline', status_reason = 'timeout', updated_at = now()
     where status = 'online'
       and (last_seen_at is null or last_seen_at < now() - make_interval(secs => offline_timeout_seconds))
     returning id
  ), logged as (
    insert into public.device_status_logs(device_id, status, message, metadata)
    select id, 'offline', 'Automatic connectivity timeout', jsonb_build_object('reason', 'timeout')
    from stale
    returning 1
  )
  select count(*) into changed from logged;
  return changed;
end;
$$;
revoke all on function public.mark_stale_devices_offline() from public, anon, authenticated;
grant execute on function public.mark_stale_devices_offline() to service_role;

do $$
begin
  alter publication supabase_realtime add table public.devices;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.device_status_logs;
exception when duplicate_object then null;
end $$;
