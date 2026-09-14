-- Run ONLY on an isolated schema clone, after the new migration.
-- Never seed the production database. Everything here rolls back.
begin;
do $$ begin
 if current_database() not like 'lateness_validation_%' then raise exception 'Isolated validation database required'; end if;
end $$;
create function pg_temp.assert_true(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',message; end if; end $$;

insert into public.companies(id,name) values
('20000000-0000-0000-0000-000000000001','Test A'),('20000000-0000-0000-0000-000000000002','Test B');
insert into public.roles(key,name) values('it_admin','IT'),('hr_admin','RRHH') on conflict(key) do nothing;
insert into auth.users(id,email,raw_user_meta_data) values
('10000000-0000-0000-0000-000000000001','supervisor@example.invalid','{}'),
('10000000-0000-0000-0000-000000000002','admin@example.invalid','{}'),
('10000000-0000-0000-0000-000000000003','other@example.invalid','{}');
insert into public.profiles(id,email) select id,email from auth.users on conflict(id) do nothing;
insert into public.user_roles(user_id,company_id,role_id)
select '10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',id from public.roles where key='regional_lateness_viewer';
insert into public.user_roles(user_id,role_id) select '10000000-0000-0000-0000-000000000002',id from public.roles where key='it_admin';
insert into public.attendance_report_regions(id,name) values
('40000000-0000-0000-0000-000000000001','North'),('40000000-0000-0000-0000-000000000002','South');
insert into public.regions(id,company_id,code,name,source_region_id) values
('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','N','North','40000000-0000-0000-0000-000000000001'),
('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','S','South','40000000-0000-0000-0000-000000000002'),
('50000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000002','N','North','40000000-0000-0000-0000-000000000001');
insert into public.branches(id,company_id,name,region_id) values
('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Allowed regional','40000000-0000-0000-0000-000000000001'),
('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','Denied','40000000-0000-0000-0000-000000000002'),
('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','Allowed direct','40000000-0000-0000-0000-000000000002'),
('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000002','Other company same region','40000000-0000-0000-0000-000000000001');
insert into public.departments(id,company_id,name)
select b.id,b.company_id,b.name from public.branches b;
insert into public.department_branches(department_id,branch_id) select id,id from public.branches;
insert into public.employees(id,company_id,branch_id,department_id,employee_code,hikvision_employee_no,full_name)
select b.id,b.company_id,b.id,b.id,row_number() over(order by b.id)::text,row_number() over(order by b.id)::text,b.name from public.branches b;
insert into public.daily_attendance(employee_id,branch_id,attendance_date,status,late_minutes,expected_check_in,actual_check_in)
select b.id,b.id,(now() at time zone 'America/Guatemala')::date,'late',10,'08:00',now() from public.branches b;
insert into public.daily_attendance(employee_id,branch_id,attendance_date,status,late_minutes)
values('30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',(now() at time zone 'America/Guatemala')::date-1,'complete',0);
insert into public.attendance_events(employee_id,branch_id,occurred_at,event_time_utc,event_time_local,event_date_local,unique_key)
select b.id,b.id,now(),now(),now() at time zone 'America/Guatemala',(now() at time zone 'America/Guatemala')::date,b.id::text from public.branches b;
insert into public.user_lateness_scopes(user_id,company_id,region_id) values
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001');
insert into public.user_lateness_scopes(user_id,company_id,branch_id) values
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select pg_temp.assert_true((select count(*)=2 from public.allowed_lateness_branch_ids()),'regional plus direct, excludes other company');
select pg_temp.assert_true((select count(*)=2 from public.branches),'branches RLS');
select pg_temp.assert_true((select count(*)=2 from public.regions),'region options includes directly assigned branch region');
select pg_temp.assert_true((select count(*)=2 from public.employees),'employees RLS');
select pg_temp.assert_true((select count(*)=2 from public.departments),'departments RLS');
select pg_temp.assert_true((select count(*)=3 from public.daily_attendance),'daily RLS');
select pg_temp.assert_true((select count(*)=0 from public.daily_attendance where branch_id='30000000-0000-0000-0000-000000000002'),'direct denied branch query');
select pg_temp.assert_true((select count(*)=2 from public.attendance_events),'events RLS');
select pg_temp.assert_true((select count(*)=2 from public.lateness_history_rows),'history excludes non-late and unassigned');
select pg_temp.assert_true((public.lateness_dashboard()->>'today')::int=2,'dashboard total');
select pg_temp.assert_true((select count(*)=1 from public.profiles),'own profile');
select pg_temp.assert_true((select count(*)=1 from public.user_roles),'own role assignments');
select pg_temp.assert_true((select count(*)=1 from public.roles),'assigned roles only');
select pg_temp.assert_true((select count(*)=0 from public.companies),'no companies');
select pg_temp.assert_true((select count(*)=0 from public.devices),'no devices');
select pg_temp.assert_true((select count(*)=0 from public.device_commands),'no commands');
select pg_temp.assert_true((select count(*)=0 from public.attendance_report_configs),'no automatic reports');
update public.profiles set full_name='Own profile edited' where id=auth.uid();
select pg_temp.assert_true((select full_name='Own profile edited' from public.profiles where id=auth.uid()),'own profile update');
do $$ begin
 begin perform public.allowed_lateness_branch_ids('10000000-0000-0000-0000-000000000003'); raise exception 'FAIL: foreign lookup allowed'; exception when insufficient_privilege then null; end;
 begin insert into public.user_lateness_scopes(user_id,company_id,branch_id) values(auth.uid(),'20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001'); raise exception 'FAIL: scope self-grant'; exception when insufficient_privilege then null; end;
 begin perform public.set_regional_lateness_scope(auth.uid(),'20000000-0000-0000-0000-000000000001','{}','{}'); raise exception 'FAIL: assignment RPC allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
update public.user_lateness_scopes set is_active=false where branch_id is not null;
set local role authenticated;
select pg_temp.assert_true((select count(*)=1 from public.allowed_lateness_branch_ids()),'scope revocation effective');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select pg_temp.assert_true((select count(*)=0 from public.allowed_lateness_branch_ids()),'unassigned user has no branches');
select pg_temp.assert_true((select count(*)=0 from public.lateness_history_rows),'unassigned user has no history');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select pg_temp.assert_true((select count(*)=4 from public.branches),'IT unchanged');
select pg_temp.assert_true((select count(*)=1 from public.allowed_lateness_branch_ids('10000000-0000-0000-0000-000000000001')),'admin foreign lookup allowed');
select public.set_regional_lateness_scope('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',array['50000000-0000-0000-0000-000000000002']::uuid[],'{}');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select pg_temp.assert_true((select count(*)=2 from public.allowed_lateness_branch_ids()),'atomic admin scope replacement');
reset role;
select pg_temp.assert_true((select 'security_invoker=true'=any(reloptions) from pg_class where oid='public.lateness_history_rows'::regclass),'history security_invoker');
select pg_temp.assert_true((select 'security_invoker=true'=any(reloptions) from pg_class where oid='public.attendance_report_rows'::regclass),'existing view still invoker');
rollback;
