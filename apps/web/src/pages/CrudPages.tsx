import { CrudPage, type CrudColumn, type CrudField } from "../components/CrudPage";

const companyFields: CrudField[] = [
  { name: "name", label: "Nombre", required: true },
  { name: "legal_name", label: "Razon social" },
  { name: "tax_id", label: "NIT" },
  { name: "timezone", label: "Zona horaria", required: true, defaultValue: "America/Guatemala" }
];

const branchFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", required: true, relation: { table: "companies", labelColumn: "name" } },
  { name: "name", label: "Nombre", required: true },
  { name: "code", label: "Codigo" },
  { name: "address", label: "Direccion", fullWidth: true },
  { name: "timezone", label: "Zona horaria", required: true, defaultValue: "America/Guatemala" },
  { name: "is_active", label: "Activa", type: "boolean", defaultValue: true }
];

const departmentFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", required: true, relation: { table: "companies", labelColumn: "name" } },
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" } },
  { name: "name", label: "Nombre", required: true },
  { name: "code", label: "Codigo" },
  { name: "is_active", label: "Activo", type: "boolean", defaultValue: true }
];

const groupFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", required: true, relation: { table: "companies", labelColumn: "name" } },
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" } },
  { name: "name", label: "Nombre", required: true },
  { name: "description", label: "Descripcion", type: "textarea", fullWidth: true },
  { name: "tolerance_minutes", label: "Tolerancia minutos", type: "number", defaultValue: 5 },
  { name: "is_active", label: "Activo", type: "boolean", defaultValue: true }
];

const scheduleFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", required: true, relation: { table: "companies", labelColumn: "name" } },
  { name: "attendance_group_id", label: "Grupo de asistencia", type: "relation", relation: { table: "attendance_groups", labelColumn: "name" } },
  { name: "name", label: "Nombre", required: true },
  { name: "timezone", label: "Zona horaria", required: true, defaultValue: "America/Guatemala" },
  { name: "default_check_in", label: "Entrada", type: "time" },
  { name: "default_lunch_out", label: "Salida almuerzo", type: "time" },
  { name: "default_lunch_in", label: "Entrada almuerzo", type: "time" },
  { name: "default_check_out", label: "Salida", type: "time" },
  { name: "tolerance_minutes", label: "Tolerancia", type: "number", defaultValue: 5 },
  { name: "is_active", label: "Activo", type: "boolean", defaultValue: true }
];

const employeeFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", required: true, relation: { table: "companies", labelColumn: "name" } },
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" } },
  { name: "department_id", label: "Departamento", type: "relation", relation: { table: "departments", labelColumn: "name" } },
  { name: "attendance_group_id", label: "Grupo de asistencia", type: "relation", relation: { table: "attendance_groups", labelColumn: "name" } },
  { name: "employee_code", label: "Codigo empleado", required: true },
  { name: "external_employee_id", label: "ID externo" },
  { name: "full_name", label: "Nombre completo", required: true },
  { name: "email", label: "Correo" },
  { name: "phone", label: "Telefono" },
  { name: "document_number", label: "Documento" },
  { name: "status", label: "Estado", type: "select", options: ["active", "inactive", "suspended"], defaultValue: "active" },
  { name: "card_number", label: "Tarjeta" },
  { name: "pin_enabled", label: "PIN habilitado", type: "boolean", defaultValue: false },
  { name: "face_status", label: "Rostro", type: "select", options: ["none", "pending", "enrolled", "failed", "error"], defaultValue: "none" },
  { name: "fingerprint_status", label: "Huella", type: "select", options: ["none", "pending", "enrolled", "failed", "error"], defaultValue: "none" },
  { name: "fingerprint_count", label: "Cantidad huellas", type: "number", defaultValue: 0 },
  { name: "hired_at", label: "Fecha contratacion", type: "date" },
  { name: "terminated_at", label: "Fecha baja", type: "date" }
];

const deviceFields: CrudField[] = [
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" } },
  { name: "name", label: "Nombre", required: true },
  { name: "model", label: "Modelo" },
  { name: "serial_number", label: "Serie" },
  { name: "firmware_version", label: "Firmware" },
  { name: "protocol", label: "Protocolo", type: "select", options: ["isup", "isapi", "hik_devicegateway"], defaultValue: "hik_devicegateway" },
  { name: "device_identifier", label: "Device ID / EHome ID", required: true, helperText: "Debe coincidir con el ID configurado en Platform Access / ISUP." },
  { name: "dev_index", label: "devIndex", helperText: "Identificador asignado por Hikvision DeviceGateway; no es el número de serie." },
  { name: "gateway_url", label: "Gateway asignado", defaultValue: "https://185.182.187.75" },
  { name: "connection_mode", label: "Modo de conexión", type: "select", options: ["devicegateway", "direct_isup", "direct_isapi"], defaultValue: "devicegateway" },
  { name: "offline_timeout_seconds", label: "Timeout offline (segundos)", type: "number", defaultValue: 300 },
  { name: "timezone", label: "Zona horaria", defaultValue: "America/Guatemala", required: true }
];

const assignmentFields: CrudField[] = [
  { name: "employee_id", label: "Empleado", type: "relation", required: true, relation: { table: "employees", labelColumn: "full_name" } },
  { name: "device_id", label: "Dispositivo", type: "relation", required: true, relation: { table: "devices", labelColumn: "name" } },
  { name: "external_person_id", label: "ID persona externo" },
  { name: "sync_status", label: "Estado sync", type: "select", options: ["pending", "processing", "success", "failed", "cancelled"], defaultValue: "pending" }
];

const baseColumns = (items: CrudColumn[]) => items;

export function CompaniesPage() {
  return <CrudPage title="Empresas" table="companies" fields={companyFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "timezone", label: "Zona" }])} />;
}

export function BranchesPage() {
  return <CrudPage title="Sucursales" table="branches" select="*, companies:company_id(name)" fields={branchFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "companies.name", label: "Empresa" }, { name: "code", label: "Codigo" }, { name: "is_active", label: "Activa" }])} />;
}

export function DepartmentsPage() {
  return <CrudPage title="Departamentos" table="departments" select="*, companies:company_id(name), branches:branch_id(name)" fields={departmentFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "companies.name", label: "Empresa" }, { name: "branches.name", label: "Sucursal" }, { name: "is_active", label: "Activo" }])} />;
}

export function AttendanceGroupsPage() {
  return <CrudPage title="Grupos de asistencia" table="attendance_groups" select="*, companies:company_id(name), branches:branch_id(name)" fields={groupFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "companies.name", label: "Empresa" }, { name: "branches.name", label: "Sucursal" }, { name: "tolerance_minutes", label: "Tolerancia" }, { name: "is_active", label: "Activo" }])} />;
}

export function WorkSchedulesPage() {
  return <CrudPage title="Horarios" table="work_schedules" select="*, companies:company_id(name), attendance_groups:attendance_group_id(name)" fields={scheduleFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "companies.name", label: "Empresa" }, { name: "attendance_groups.name", label: "Grupo" }, { name: "default_check_in", label: "Entrada" }, { name: "default_check_out", label: "Salida" }, { name: "is_active", label: "Activo" }])} />;
}

export function EmployeesPage() {
  return <CrudPage title="Empleados" table="employees" select="*, companies:company_id(name), branches:branch_id(name), departments:department_id(name), attendance_groups:attendance_group_id(name)" fields={employeeFields} columns={baseColumns([{ name: "employee_code", label: "Codigo" }, { name: "full_name", label: "Nombre" }, { name: "branches.name", label: "Sucursal" }, { name: "departments.name", label: "Departamento" }, { name: "status", label: "Estado", status: true }, { name: "fingerprint_status", label: "Huella", status: true }, { name: "face_status", label: "Rostro", status: true }])} />;
}

export function DevicesPage() {
  return <CrudPage title="Dispositivos" table="devices" select="*, branches:branch_id(name)" fields={deviceFields} mutationFunction="admin-devices" realtimeTables={["devices", "device_status_logs"]} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "branches.name", label: "Sucursal" }, { name: "device_identifier", label: "EHome ID" }, { name: "protocol", label: "Protocolo" }, { name: "status", label: "Estado", status: true }, { name: "status_reason", label: "Razón" }, { name: "last_seen_at", label: "Última conexión" }, { name: "gateway_url", label: "Gateway" }])} />;
}

export function EmployeeDevicesPage() {
  return <CrudPage title="Asignacion empleados-dispositivos" table="employee_devices" select="*, employees:employee_id(full_name,employee_code), devices:device_id(name)" fields={assignmentFields} columns={baseColumns([{ name: "employees.full_name", label: "Empleado" }, { name: "devices.name", label: "Dispositivo" }, { name: "sync_status", label: "Sync", status: true }])} />;
}
