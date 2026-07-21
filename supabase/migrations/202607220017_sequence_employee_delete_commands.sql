-- A delete created before a later sync_person is not a duplicate of the final delete.
drop index if exists public.device_commands_one_active_delete_person_idx;

do $migration$
declare
  original_body text;
  corrected_body text;
  old_fragment text := $old$where command.device_id=removed_device and command.command_type='delete_person'
        and command.status in ('pending','processing') and command.payload->>'employee_no'=old_external_id$old$;
  new_fragment text := $new$where command.device_id=removed_device and command.command_type='delete_person'
        and command.status in ('pending','processing') and command.payload->>'employee_no'=old_external_id
        and command.created_at > coalesce((
          select max(person.created_at) from public.device_commands person
          where person.device_id=removed_device and person.employee_id=saved.id
            and person.command_type in ('sync_person','update_person')
        ), '-infinity'::timestamptz)$new$;
begin
  select procedure.prosrc into original_body
  from pg_proc procedure
  where procedure.oid = 'public.admin_save_employee(jsonb,uuid[],uuid,uuid)'::regprocedure;
  corrected_body := replace(original_body, old_fragment, new_fragment);
  if corrected_body is null or corrected_body = original_body then
    raise exception 'admin_save_employee delete ordering expression was not found';
  end if;
  execute format(
    'create or replace function public.admin_save_employee(p_employee jsonb, p_device_ids uuid[], p_requested_by uuid, p_employee_id uuid default null) returns public.employees language plpgsql security definer set search_path=public as %L',
    corrected_body
  );
end $migration$;

do $migration$
declare
  original_body text;
  corrected_body text;
  old_fragment text := $old$where command.device_id=link.device_id and command.command_type='delete_person'
        and command.status in ('pending','processing') and command.payload->>'employee_no'=external_id$old$;
  new_fragment text := $new$where command.device_id=link.device_id and command.command_type='delete_person'
        and command.status in ('pending','processing') and command.payload->>'employee_no'=external_id
        and command.created_at > coalesce((
          select max(person.created_at) from public.device_commands person
          where person.device_id=link.device_id and person.employee_id=e.id
            and person.command_type in ('sync_person','update_person')
        ), '-infinity'::timestamptz)$new$;
begin
  select procedure.prosrc into original_body
  from pg_proc procedure
  where procedure.oid = 'public.admin_delete_employee(uuid,uuid)'::regprocedure;
  corrected_body := replace(original_body, old_fragment, new_fragment);
  if corrected_body is null or corrected_body = original_body then
    raise exception 'admin_delete_employee delete ordering expression was not found';
  end if;
  execute format(
    'create or replace function public.admin_delete_employee(p_employee_id uuid, p_requested_by uuid) returns void language plpgsql security definer set search_path=public as %L',
    corrected_body
  );
end $migration$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_employee(uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;
grant execute on function public.admin_delete_employee(uuid,uuid) to service_role;
