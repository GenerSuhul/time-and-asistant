-- SOLO DESARROLLO LOCAL.
-- No ejecutar contra staging ni produccion.
-- Para bloqueo adicional en sesiones psql:
--   set app.env = 'production';

do $$
begin
  if current_setting('app.env', true) = 'production' then
    raise exception 'seed-demo.sql is blocked when app.env=production';
  end if;
end $$;

with company as (
  insert into public.companies (name, legal_name, timezone)
  values ('AGRISYSTEMS', 'AGRISYSTEMS', 'America/Guatemala')
  returning id
),
branches as (
  insert into public.branches (company_id, name, code, timezone)
  select id, 'Renova Poptun 1', 'RNV-POPTUN1', 'America/Guatemala' from company
  union all
  select id, 'Renova San Benito', 'RNV-SANBENITO', 'America/Guatemala' from company
  returning id, company_id, name
),
departments as (
  insert into public.departments (company_id, name, code)
  select id, 'Administracion', 'ADMIN' from company
  union all
  select id, 'Ventas', 'VENTAS' from company
  returning id, company_id, name
),
groups as (
  insert into public.attendance_groups (company_id, name, tolerance_minutes)
  select id, 'Horario 1', 5 from company
  union all
  select id, 'Horario 2 Fin de Semana', 5 from company
  returning id, company_id, name
),
schedules as (
  insert into public.work_schedules (
    company_id,
    attendance_group_id,
    name,
    default_check_in,
    default_lunch_out,
    default_lunch_in,
    default_check_out,
    tolerance_minutes
  )
  select company_id, id, name, '08:00', '12:00', '13:00', '17:00', 5 from groups
  returning id
),
employees as (
  insert into public.employees (
    company_id,
    branch_id,
    department_id,
    attendance_group_id,
    employee_code,
    external_employee_id,
    full_name,
    status
  )
  select
    c.id,
    (select id from branches where name = 'Renova Poptun 1' limit 1),
    (select id from departments where name = 'Administracion' limit 1),
    (select id from groups where name = 'Horario 1' limit 1),
    code,
    code,
    name,
    'active'::public.employee_status
  from company c
  cross join (values
    ('E001', 'Enrique Maquin'),
    ('E002', 'Oldin Mendez'),
    ('E003', 'Ashlyn Aquino'),
    ('E004', 'Katherine Ruiz'),
    ('E005', 'Gener Suhul'),
    ('E006', 'Maria Medina')
  ) as demo(code, name)
  returning id
)
insert into public.devices (
  branch_id,
  name,
  model,
  serial_number,
  protocol,
  device_identifier,
  status,
  timezone
)
select
  (select id from branches where name = 'Renova Poptun 1' limit 1),
  'RNV-POPTUN1-AC01',
  'DS-K1T321MFWX',
  'RNV-POPTUN1-AC01',
  'mock'::public.device_protocol,
  'RNV-POPTUN1-AC01',
  'offline'::public.device_status,
  'America/Guatemala';
