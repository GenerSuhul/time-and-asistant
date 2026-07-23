import { CrudPage, type CrudColumn, type CrudField } from "../components/CrudPage";
import { useCurrentUserProfile } from "../hooks/useCurrentUserProfile";
import { canAccess } from "../lib/accessControl";
import { EmployeeManagementPage } from "./EmployeeManagementPage";

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
  { name: "unit_type", label: "Tipo de unidad", type: "select", options: ["store", "administration"], defaultValue: "store" },
  { name: "is_active", label: "Activa", type: "boolean", defaultValue: true }
];

const scheduleFields: CrudField[] = [
  { name: "company_id", label: "Empresa (opcional)", type: "relation", relation: { table: "companies", labelColumn: "name" } },
  { name: "code", label: "Código", required: true },
  { name: "name", label: "Nombre", required: true },
  { name: "applicable_unit_type", label: "Aplica a", type: "select", options: ["store", "administration", "department"], required: true, defaultValue: "store" },
  { name: "timezone", label: "Zona horaria", required: true, defaultValue: "America/Guatemala" },
  { name: "expected_check_in", label: "Entrada esperada", type: "time", required: true },
  { name: "expected_check_out", label: "Salida esperada", type: "time", required: true },
  { name: "max_break_minutes", label: "Pausa máxima (min)", type: "number", required: true, defaultValue: 60 },
  { name: "check_in_tolerance_minutes", label: "Tolerancia entrada (min)", type: "number", defaultValue: 0 },
  { name: "check_out_tolerance_minutes", label: "Tolerancia salida (min)", type: "number", defaultValue: 0 },
  { name: "warnings_trigger_hr_copy", label: "Alertas copian a RRHH", type: "boolean", defaultValue: false },
  { name: "is_active", label: "Activo", type: "boolean", defaultValue: true }
];

const employeeFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", required: true, relation: { table: "companies", labelColumn: "name" } },
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" } },
  { name: "department_id", label: "Departamento", type: "relation", relation: { table: "departments", labelColumn: "name" } },
  { name: "employee_code", label: "Codigo empleado", required: true },
  { name: "external_employee_id", label: "ID externo" },
  { name: "full_name", label: "Nombre completo", required: true },
  { name: "email", label: "Correo" },
  { name: "phone", label: "Telefono" },
  { name: "document_number", label: "Documento" },
  { name: "status", label: "Estado", type: "select", options: ["active", "inactive", "suspended"], defaultValue: "active" },
  { name: "card_number", label: "Tarjeta" },
  { name: "device_ids", label: "Dispositivos destino", type: "relations", relation: { table: "devices", labelColumn: "name" }, helperText: "Se crearán comandos de persona y tarjeta para cada dispositivo." },
  { name: "pin_enabled", label: "PIN habilitado", type: "boolean", defaultValue: false },
  { name: "face_status", label: "Rostro", defaultValue: "none", hidden: true },
  { name: "fingerprint_status", label: "Huella", defaultValue: "none", hidden: true },
  { name: "fingerprint_count", label: "Cantidad huellas", type: "number", defaultValue: 0, hidden: true },
  { name: "hired_at", label: "Fecha contratacion", type: "date" },
  { name: "terminated_at", label: "Fecha baja", type: "date" }
];

const deviceFields: CrudField[] = [
  { name: "branch_ids", label: "Sucursales asignadas", type: "relations", required: true, relation: { table: "branches", labelColumn: "name", loadFrom: { path: "device_branches", valueColumn: "branch_id" } }, helperText: "Puede seleccionar varias sucursales de la misma empresa." },
  { name: "branch_id", label: "Sucursal principal", type: "relation", relation: { table: "branches", labelColumn: "name" }, helperText: "Fallback para eventos sin una persona identificada; debe estar entre las sucursales asignadas." },
  { name: "name", label: "Device Name", required: true, helperText: "Nombre visible del biometrico en el sistema." },
  { name: "device_identifier", label: "Device ID", required: true, helperText: "Debe coincidir con el Device ID configurado en ISUP 5.0." },
  { name: "ehome_key", label: "EHome Key", type: "password", requiredOnCreate: true, helperText: "Obligatoria al crear. En edición, déjela vacía salvo que necesite reprovisionar; nunca se guarda en devices." },
  { name: "model", label: "Modelo", defaultValue: "Hikvision", hidden: true },
  { name: "serial_number", label: "Serie", hidden: true },
  { name: "firmware_version", label: "Firmware", hidden: true },
  { name: "protocol", label: "Protocolo", defaultValue: "hik_devicegateway", hidden: true },
  { name: "dev_index", label: "devIndex", hidden: true },
  { name: "gateway_url", label: "Gateway asignado", hidden: true },
  { name: "connection_mode", label: "Modo de conexion", defaultValue: "devicegateway", hidden: true },
  { name: "offline_timeout_seconds", label: "Timeout offline", type: "number", defaultValue: 300, hidden: true },
  { name: "timezone", label: "Zona horaria", defaultValue: "America/Guatemala", hidden: true }
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
  return <CrudPage title="Sucursales" table="branches" select="*, companies:company_id(name)" fields={branchFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "companies.name", label: "Empresa" }, { name: "code", label: "Codigo" }, { name: "unit_type", label: "Tipo" }, { name: "is_active", label: "Activa" }])} />;
}

export function WorkSchedulesPage() {
  return <CrudPage title="Horarios y reglas de asistencia" table="attendance_report_rules" select="*, companies:company_id(name)" fields={scheduleFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "companies.name", label: "Empresa" }, { name: "applicable_unit_type", label: "Aplica a" }, { name: "expected_check_in", label: "Entrada" }, { name: "expected_check_out", label: "Salida" }, { name: "max_break_minutes", label: "Pausa máxima" }, { name: "is_active", label: "Activo" }])} />;
}

export function EmployeesPage() {
  return <EmployeeManagementPage />;
}

export function DevicesPage() {
  const currentUser = useCurrentUserProfile();
  const canAdministerDevices = canAccess((currentUser.data?.roles ?? []).map((role) => role.key), "device_admin");
  return <CrudPage title="Dispositivos" table="devices" select="*, branches:branch_id(name), device_branches(branch_id,branches:branch_id(name))" fields={deviceFields} mutationFunction="admin-devices" realtimeTables={["devices", "device_branches", "device_status_logs"]} readOnly={!canAdministerDevices} readOnlyMessage="RRHH puede consultar equipos y asignarlos desde Personas. El alta técnica y la reprovisión del dispositivo corresponden a IT." columns={baseColumns([{ name: "name", label: "Device Name" }, { name: "branches.name", label: "Principal" }, { name: "device_branches.branches.name", label: "Sucursales asignadas" }, { name: "device_identifier", label: "Device ID" }, { name: "status", label: "Estado", status: true }, { name: "last_seen_at", label: "Última conexión (Guatemala)", dateTime: true }])} />;
}

export function EmployeeDevicesPage() {
  return <CrudPage title="Asignacion empleados-dispositivos" table="employee_devices" select="*, employees:employee_id(full_name,employee_code), devices:device_id(name)" fields={assignmentFields} columns={baseColumns([{ name: "employees.full_name", label: "Empleado" }, { name: "devices.name", label: "Dispositivo" }, { name: "sync_status", label: "Sync", status: true }])} />;
}
