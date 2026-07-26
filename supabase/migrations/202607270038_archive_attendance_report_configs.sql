-- Allow operators to remove report configurations without destroying report history.

alter table public.attendance_report_configs
  add column if not exists archived_at timestamptz;

create index if not exists attendance_report_configs_active_schedule_idx
  on public.attendance_report_configs(is_active, send_time)
  where archived_at is null;

create or replace function public.remove_attendance_report_config(p_config_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_config_id uuid;
begin
  if not public.has_any_role(array['super_admin','it_admin']) then
    raise exception using
      errcode = '42501',
      message = 'Solo un superadministrador o administrador de TI puede eliminar configuraciones de reportes';
  end if;

  select id
  into v_config_id
  from public.attendance_report_configs
  where id = p_config_id
    and archived_at is null
  for update;

  if v_config_id is null then
    raise exception using
      errcode = 'P0002',
      message = 'La configuración no existe o ya fue eliminada';
  end if;

  if exists (
    select 1
    from public.attendance_report_runs
    where config_id = p_config_id
  ) then
    update public.attendance_report_configs
    set is_active = false,
        archived_at = now()
    where id = p_config_id;
    return 'archived';
  end if;

  delete from public.attendance_report_configs
  where id = p_config_id;
  return 'deleted';
end;
$$;

revoke all on function public.remove_attendance_report_config(uuid) from public, anon;
grant execute on function public.remove_attendance_report_config(uuid) to authenticated, service_role;

comment on column public.attendance_report_configs.archived_at is
  'Soft-deletion timestamp used when historical report runs must retain their configuration reference.';
comment on function public.remove_attendance_report_config(uuid) is
  'Deletes unused report configurations and archives configurations referenced by historical runs.';
