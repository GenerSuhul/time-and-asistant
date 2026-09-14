-- Regional lateness supervisors use the normal dashboard UI. Let that
-- dashboard count device health only for devices attached to their assigned
-- branches, without granting access to device administration screens.

drop policy if exists lateness_devices_read on public.devices;
create policy lateness_devices_read on public.devices
for select to authenticated
using (
  public.has_any_role(array['regional_lateness_viewer'])
  and branch_id in (select public.allowed_lateness_branch_ids())
);

notify pgrst,'reload schema';
