-- Additive regional read access. branches.region_id ALREADY references the
-- global attendance_report_regions catalog. Keep that FK and all report data
-- intact; regions normalizes that catalog per company via source_region_id.
insert into public.roles(key,name,description) values
('regional_lateness_viewer','Supervisor regional de tardanzas',
 'Solo puede consultar dashboard propio e histórico de tardanzas de sus tiendas asignadas por región o sucursal.')
on conflict(key) do update set name=excluded.name,description=excluded.description,updated_at=now();

create table public.regions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 code text not null,
 name text not null,
 source_region_id uuid references public.attendance_report_regions(id) on delete restrict,
 is_active boolean not null default true,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(company_id,code), unique(company_id,source_region_id)
);
insert into public.regions(company_id,code,name,source_region_id,is_active)
select c.id,r.id::text,r.name,r.id,r.is_active
from public.companies c cross join public.attendance_report_regions r;

create table public.user_lateness_scopes (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade,
 region_id uuid references public.regions(id) on delete cascade,
 branch_id uuid references public.branches(id) on delete cascade,
 is_active boolean not null default true,
 created_by uuid references auth.users(id) on delete set null,
 metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check(num_nonnulls(region_id,branch_id)=1)
);
create unique index user_lateness_scopes_region_uidx on public.user_lateness_scopes(user_id,company_id,region_id) where region_id is not null;
create unique index user_lateness_scopes_branch_uidx on public.user_lateness_scopes(user_id,company_id,branch_id) where branch_id is not null;
create index user_lateness_scopes_region_idx on public.user_lateness_scopes(region_id);
create index user_lateness_scopes_branch_idx on public.user_lateness_scopes(branch_id);
alter table public.regions enable row level security;
alter table public.user_lateness_scopes enable row level security;
revoke all on public.regions,public.user_lateness_scopes from anon,authenticated;
grant select,insert,update,delete on public.regions,public.user_lateness_scopes to authenticated;
grant all on public.regions,public.user_lateness_scopes to service_role;

-- This helper must bypass branches RLS to avoid recursive policies. It accepts
-- only the caller's UUID, unless the caller is a platform administrator.
create function public.allowed_lateness_branch_ids(p_user_id uuid default auth.uid())
returns setof uuid language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or (p_user_id is distinct from auth.uid() and not
   public.has_any_role(array['super_admin','it_admin','hr_admin'])) then
   raise exception 'Forbidden scope lookup' using errcode='42501';
 end if;
 return query
 select distinct b.id
 from public.user_lateness_scopes s
 join public.branches b on b.company_id=s.company_id
 left join public.regions r on r.id=s.region_id and r.company_id=s.company_id and r.is_active
 where s.user_id=p_user_id and s.is_active and b.is_active
   and (s.branch_id=b.id or r.source_region_id=b.region_id)
   and exists(select 1 from public.user_roles ur join public.roles role on role.id=ur.role_id
     where ur.user_id=p_user_id and role.key='regional_lateness_viewer'
       and (ur.company_id is null or ur.company_id=s.company_id));
end $$;
revoke all on function public.allowed_lateness_branch_ids(uuid) from public,anon;
grant execute on function public.allowed_lateness_branch_ids(uuid) to authenticated;

-- Validate company consistency even for privileged inserts; invalid scopes
-- must not silently acquire access when a branch is subsequently moved.
create function public.validate_lateness_scope() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.region_id is not null and not exists(select 1 from public.regions r where r.id=new.region_id and r.company_id=new.company_id) then
   raise exception 'Region does not belong to company';
 end if;
 if new.branch_id is not null and not exists(select 1 from public.branches b where b.id=new.branch_id and b.company_id=new.company_id) then
   raise exception 'Branch does not belong to company';
 end if;
 new.updated_at=now();
 return new;
end $$;
revoke all on function public.validate_lateness_scope() from public,anon,authenticated;
create trigger validate_lateness_scope before insert or update on public.user_lateness_scopes for each row execute function public.validate_lateness_scope();

create policy lateness_regions_admin on public.regions for all to authenticated
using(public.has_any_role(array['super_admin','it_admin','hr_admin']))
with check(public.has_any_role(array['super_admin','it_admin','hr_admin']));
create policy lateness_scopes_admin on public.user_lateness_scopes for all to authenticated
using(public.has_any_role(array['super_admin','it_admin','hr_admin']))
with check(public.has_any_role(array['super_admin','it_admin','hr_admin']));
create policy lateness_scopes_own on public.user_lateness_scopes for select to authenticated
using(user_id=auth.uid() and public.has_any_role(array['regional_lateness_viewer']));
create policy lateness_regions_read on public.regions for select to authenticated using (
 public.has_any_role(array['regional_lateness_viewer']) and (
 exists(select 1 from public.user_lateness_scopes s where s.user_id=auth.uid() and s.is_active and s.region_id=regions.id and s.company_id=regions.company_id)
 or exists(select 1 from public.branches b where b.id in(select public.allowed_lateness_branch_ids())
   and b.company_id=regions.company_id and b.region_id=regions.source_region_id)));
create policy lateness_branches_read on public.branches for select to authenticated
using(public.has_any_role(array['regional_lateness_viewer']) and id in(select public.allowed_lateness_branch_ids()));
create policy lateness_employees_read on public.employees for select to authenticated
using(public.has_any_role(array['regional_lateness_viewer']) and branch_id in(select public.allowed_lateness_branch_ids()));
create policy lateness_department_links_read on public.department_branches for select to authenticated
using(public.has_any_role(array['regional_lateness_viewer']) and branch_id in(select public.allowed_lateness_branch_ids()));
create policy lateness_departments_read on public.departments for select to authenticated
using(public.has_any_role(array['regional_lateness_viewer']) and (
 exists(select 1 from public.department_branches db where db.department_id=departments.id and db.branch_id in(select public.allowed_lateness_branch_ids()))
 or exists(select 1 from public.employees e where e.department_id=departments.id and e.branch_id in(select public.allowed_lateness_branch_ids()))));
create policy lateness_daily_read on public.daily_attendance for select to authenticated
using(public.has_any_role(array['regional_lateness_viewer']) and branch_id in(select public.allowed_lateness_branch_ids()));
create policy lateness_events_read on public.attendance_events for select to authenticated
using(public.has_any_role(array['regional_lateness_viewer']) and branch_id in(select public.allowed_lateness_branch_ids()));
-- Existing own-profile, own-user_roles and assigned-roles policies already
-- supply identity reads and own-profile updates. No generic role_select change.

create view public.lateness_history_rows with(security_invoker=true) as
select d.id,b.company_id,d.branch_id,r.id region_id,r.name region_name,b.name branch_name,
 e.department_id,dep.name department_name,d.employee_id,e.employee_code,e.full_name employee_name,
 d.attendance_date,d.expected_check_in,d.actual_check_in,d.late_minutes,d.status,d.warnings,d.calculated_at
from public.daily_attendance d
join public.branches b on b.id=d.branch_id
join public.employees e on e.id=d.employee_id
left join public.departments dep on dep.id=e.department_id
left join public.regions r on r.company_id=b.company_id and r.source_region_id=b.region_id
where d.status='late' or d.late_minutes>0;
revoke all on public.lateness_history_rows from anon,authenticated;
grant select on public.lateness_history_rows to authenticated,service_role;
create index daily_attendance_lateness_scope_idx on public.daily_attendance(branch_id,attendance_date desc,id)
where status='late' or late_minutes>0;

-- Aggregate server-side: no API row cap can truncate the monthly dashboard.
create function public.lateness_dashboard() returns jsonb language sql stable security invoker set search_path='' as $$
 with dates as(select (now() at time zone 'America/Guatemala')::date today),
 rows as(select h.* from public.lateness_history_rows h,dates
   where h.branch_id in(select public.allowed_lateness_branch_ids())
     and h.attendance_date between least(date_trunc('month',today)::date,today-6) and today),
 top_employees as(select employee_id,employee_name,count(*) tardanzas,sum(late_minutes) minutos
   from rows,dates where attendance_date>=date_trunc('month',today)::date
   group by employee_id,employee_name order by count(*) desc,employee_name,employee_id limit 10)
 select jsonb_build_object(
 'today',(select count(*) from rows where attendance_date=(select today from dates)),
 'week',(select count(*) from rows where attendance_date>=(select today-6 from dates)),
 'month',(select count(*) from rows where attendance_date>=(select date_trunc('month',today)::date from dates)),
 'branches',(select count(*) from public.allowed_lateness_branch_ids()),
 'top',coalesce((select jsonb_agg(t) from top_employees t),'[]'::jsonb));
$$;
revoke all on function public.lateness_dashboard() from public,anon;
grant execute on function public.lateness_dashboard() to authenticated;

-- Atomic assignment entrypoint used by the dedicated admin Edge Function.
-- Never modifies another role, and rejects editing existing administrators.
create function public.set_regional_lateness_scope(p_user_id uuid,p_company_id uuid,p_region_ids uuid[],p_branch_ids uuid[])
returns void language plpgsql security definer set search_path='' as $$
declare regional_role uuid;
begin
 if auth.uid() is null or not public.has_any_role(array['super_admin','it_admin','hr_admin']) then
   raise exception 'Forbidden' using errcode='42501';
 end if;
 if p_company_id is null or coalesce(cardinality(p_region_ids),0)+coalesce(cardinality(p_branch_ids),0)=0 then
   raise exception 'Select company and at least one region or branch';
 end if;
 perform 1 from auth.users where id=p_user_id for update;
 if not found then raise exception 'User not found'; end if;
 if exists(select 1 from public.user_roles u join public.roles r on r.id=u.role_id where u.user_id=p_user_id and r.key<>'regional_lateness_viewer') then
   raise exception 'Use platform administration for users with other roles';
 end if;
 if exists(select 1 from unnest(p_region_ids) x where not exists(select 1 from public.regions r where r.id=x and r.company_id=p_company_id and r.is_active))
 or exists(select 1 from unnest(p_branch_ids) x where not exists(select 1 from public.branches b where b.id=x and b.company_id=p_company_id and b.is_active)) then
   raise exception 'Invalid company scope';
 end if;
 select id into regional_role from public.roles where key='regional_lateness_viewer';
 delete from public.user_roles where user_id=p_user_id and role_id=regional_role;
 insert into public.user_roles(user_id,company_id,role_id) values(p_user_id,p_company_id,regional_role);
 -- Preserve assignment history instead of deleting scopes.
 update public.user_lateness_scopes set is_active=false,updated_at=now() where user_id=p_user_id;
 insert into public.user_lateness_scopes(user_id,company_id,region_id,created_by)
 select p_user_id,p_company_id,x,auth.uid() from (select distinct unnest(p_region_ids) x) q
 on conflict(user_id,company_id,region_id) where region_id is not null
 do update set is_active=true,updated_at=now();
 insert into public.user_lateness_scopes(user_id,company_id,branch_id,created_by)
 select p_user_id,p_company_id,x,auth.uid() from (select distinct unnest(p_branch_ids) x) q
 on conflict(user_id,company_id,branch_id) where branch_id is not null
 do update set is_active=true,updated_at=now();
end $$;
revoke all on function public.set_regional_lateness_scope(uuid,uuid,uuid[],uuid[]) from public,anon;
grant execute on function public.set_regional_lateness_scope(uuid,uuid,uuid[],uuid[]) to authenticated;
notify pgrst,'reload schema';
