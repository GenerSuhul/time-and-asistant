-- Pending sync commands older than a delete_person cannot represent a later reassignment.
do $migration$
declare
  original_body text;
  corrected_body text;
  old_person_fragment text := $old$and pending.command_type in ('sync_person','update_person') and pending.status='pending'
        order by pending.created_at asc limit 1$old$;
  new_person_fragment text := $new$and pending.command_type in ('sync_person','update_person') and pending.status='pending'
          and pending.created_at > coalesce((
            select max(deletion.created_at) from public.device_commands deletion
            where deletion.device_id=target_device and deletion.command_type='delete_person'
              and deletion.payload->>'employee_no'=external_id
          ), '-infinity'::timestamptz)
        order by pending.created_at asc limit 1$new$;
  old_card_fragment text := $old$and pending.command_type='sync_card' and pending.status='pending'
        order by pending.created_at asc limit 1$old$;
  new_card_fragment text := $new$and pending.command_type='sync_card' and pending.status='pending'
          and pending.created_at > coalesce((
            select max(deletion.created_at) from public.device_commands deletion
            where deletion.device_id=target_device and deletion.command_type='delete_person'
              and deletion.payload->>'employee_no'=external_id
          ), '-infinity'::timestamptz)
        order by pending.created_at asc limit 1$new$;
begin
  select procedure.prosrc into original_body
  from pg_proc procedure
  where procedure.oid = 'public.admin_save_employee(jsonb,uuid[],uuid,uuid)'::regprocedure;

  corrected_body := replace(original_body, old_person_fragment, new_person_fragment);
  if corrected_body is null or corrected_body = original_body then
    raise exception 'admin_save_employee pending person command expression was not found';
  end if;
  original_body := corrected_body;
  corrected_body := replace(original_body, old_card_fragment, new_card_fragment);
  if corrected_body = original_body then
    raise exception 'admin_save_employee pending card command expression was not found';
  end if;

  execute format(
    'create or replace function public.admin_save_employee(p_employee jsonb, p_device_ids uuid[], p_requested_by uuid, p_employee_id uuid default null) returns public.employees language plpgsql security definer set search_path=public as %L',
    corrected_body
  );
end $migration$;

revoke all on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_save_employee(jsonb,uuid[],uuid,uuid) to service_role;
