-- Preserve the applied migration and correct its PL/pgSQL enum inference.
do $migration$
declare
  original_body text;
  corrected_body text;
begin
  select procedure.prosrc into original_body
  from pg_proc procedure
  where procedure.oid = 'public.admin_save_employee(jsonb,uuid[],uuid,uuid)'::regprocedure;

  corrected_body := replace(
    original_body,
    'case when not existing_target or person_changed or card_changed then ''pending'' else ''success'' end',
    'case when not existing_target or person_changed or card_changed then ''pending''::public.command_status else ''success''::public.command_status end'
  );

  if corrected_body is null or corrected_body = original_body then
    raise exception 'admin_save_employee sync_status expression was not found';
  end if;

  execute format(
    'create or replace function public.admin_save_employee(p_employee jsonb, p_device_ids uuid[], p_requested_by uuid, p_employee_id uuid default null) returns public.employees language plpgsql security definer set search_path=public as %L',
    corrected_body
  );
end $migration$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;
