-- Additive many-to-many device assignment. devices.branch_id remains the primary
-- branch for backwards compatibility and for events without a resolved employee.

insert into public.migration_snapshots(migration_key,table_name,row_count,rows)
select '202607220024','device_primary_branches',count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object('device_id',id,'branch_id',branch_id) order by id),'[]'::jsonb)
from public.devices on conflict do nothing;

create table if not exists public.device_branches (
  device_id uuid not null references public.devices(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(device_id,branch_id)
);

insert into public.device_branches(device_id,branch_id)
select id,branch_id from public.devices where branch_id is not null
on conflict do nothing;

create index if not exists device_branches_branch_idx
  on public.device_branches(branch_id,device_id);

alter table public.device_branches enable row level security;
drop policy if exists "device_branches_role_select" on public.device_branches;
create policy "device_branches_role_select" on public.device_branches for select to authenticated
using (public.has_any_role(array['super_admin','it_admin','hr_admin','branch_manager','viewer']));
revoke insert,update,delete on public.device_branches from anon,authenticated;
grant select on public.device_branches to authenticated;
grant all on public.device_branches to service_role;

create or replace function public.admin_set_device_branches(
  p_device_id uuid,
  p_branch_ids uuid[],
  p_primary_branch_id uuid default null
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  normalized uuid[];
  primary_branch uuid;
  expected_company uuid;
  matched_count integer;
  company_count integer;
begin
  if auth.role()<>'service_role' then raise exception 'service role required'; end if;

  select coalesce(array_agg(distinct branch_id order by branch_id),'{}'::uuid[])
  into normalized from unnest(coalesce(p_branch_ids,'{}'::uuid[])) branch_id;
  if cardinality(normalized)=0 then raise exception 'DEVICE_BRANCH_REQUIRED'; end if;

  primary_branch:=coalesce(p_primary_branch_id,normalized[1]);
  if not primary_branch=any(normalized) then raise exception 'DEVICE_PRIMARY_BRANCH_NOT_ASSIGNED'; end if;

  select count(*),count(distinct company_id),(array_agg(company_id))[1]
  into matched_count,company_count,expected_company
  from public.branches where id=any(normalized);
  if matched_count<>cardinality(normalized) then raise exception 'DEVICE_BRANCH_NOT_FOUND'; end if;
  if company_count<>1 then raise exception 'DEVICE_BRANCH_COMPANY_MISMATCH'; end if;
  if not exists(select 1 from public.devices where id=p_device_id for update) then raise exception 'DEVICE_NOT_FOUND'; end if;

  update public.devices set branch_id=primary_branch where id=p_device_id;
  delete from public.device_branches where device_id=p_device_id and not branch_id=any(normalized);
  insert into public.device_branches(device_id,branch_id)
  select p_device_id,branch_id from unnest(normalized) branch_id
  on conflict do nothing;

  return jsonb_build_object(
    'device_id',p_device_id,
    'primary_branch_id',primary_branch,
    'branch_ids',to_jsonb(normalized),
    'company_id',expected_company
  );
end $$;

revoke all on function public.admin_set_device_branches(uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.admin_set_device_branches(uuid,uuid[],uuid) to service_role;

comment on table public.device_branches is 'Branches served by a physical device; all rows for one device belong to one company.';
comment on column public.devices.branch_id is 'Primary branch used as fallback for unresolved events and backwards-compatible consumers.';

do $$ begin
  alter publication supabase_realtime add table public.device_branches;
exception when duplicate_object then null;
end $$;
