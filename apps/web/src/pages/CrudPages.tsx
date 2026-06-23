import { CrudPage, type CrudColumn, type CrudField } from "../components/CrudPage";

const companyFields: CrudField[] = [
  { name: "name", label: "Nombre", required: true },
  { name: "legal_name", label: "Razon social" },
  { name: "tax_id", label: "NIT" },
  { name: "timezone", label: "Zona horaria", required: true }
];

const branchFields: CrudField[] = [
  { name: "company_id", label: "Company ID", required: true },
  { name: "name", label: "Nombre", required: true },
  { name: "code", label: "Codigo" },
  { name: "address", label: "Direccion" },
  { name: "timezone", label: "Zona horaria", required: true },
  { name: "is_active", label: "Activa", type: "boolean" }
];

const departmentFields: CrudField[] = [
  { name: "company_id", label: "Company ID", required: true },
  { name: "branch_id", label: "Branch ID" },
  { name: "name", label: "Nombre", required: true },
  { name: "code", label: "Codigo" },
  { name: "is_active", label: "Activo", type: "boolean" }
];

const groupFields: CrudField[] = [
  { name: "company_id", label: "Company ID", required: true },
  { name: "branch_id", label: "Branch ID" },
  { name: "name", label: "Nombre", required: true },
  { name: "description", label: "Descripcion", type: "textarea" },
  { name: "tolerance_minutes", label: "Tolerancia minutos", type: "number" },
  { name: "is_active", label: "Activo", type: "boolean" }
];

const scheduleFields: CrudField[] = [
  { name: "company_id", label: "Company ID", required: true },
  { name: "attendance_group_id", label: "Attendance Group ID" },
  { name: "name", label: "Nombre", required: true },
  { name: "timezone", label: "Zona horaria", required: true },
  { name: "default_check_in", label: "Entrada", type: "time" },
  { name: "default_lunch_out", label: "Salida almuerzo", type: "time" },
  { name: "default_lunch_in", label: "Entrada almuerzo", type: "time" },
  { name: "default_check_out", label: "Salida", type: "time" },
  { name: "tolerance_minutes", label: "Tolerancia", type: "number" },
  { name: "is_active", label: "Activo", type: "boolean" }
];

const employeeFields: CrudField[] = [
  { name: "company_id", label: "Company ID", required: true },
  { name: "branch_id", label: "Branch ID" },
  { name: "department_id", label: "Department ID" },
  { name: "attendance_group_id", label: "Attendance Group ID" },
  { name: "employee_code", label: "Codigo empleado", required: true },
  { name: "external_employee_id", label: "ID externo" },
  { name: "full_name", label: "Nombre completo", required: true },
  { name: "email", label: "Correo" },
  { name: "phone", label: "Telefono" },
  { name: "document_number", label: "Documento" },
  { name: "status", label: "Estado", type: "select", options: ["active", "inactive", "suspended"] },
  { name: "card_number", label: "Tarjeta" },
  { name: "pin_enabled", label: "PIN habilitado", type: "boolean" },
  { name: "face_status", label: "Rostro", type: "select", options: ["none", "pending", "enrolled", "failed", "error"] },
  { name: "fingerprint_status", label: "Huella", type: "select", options: ["none", "pending", "enrolled", "failed", "error"] },
  { name: "fingerprint_count", label: "Cantidad huellas", type: "number" },
  { name: "hired_at", label: "Fecha contratacion", type: "date" },
  { name: "terminated_at", label: "Fecha baja", type: "date" }
];

const deviceFields: CrudField[] = [
  { name: "branch_id", label: "Branch ID" },
  { name: "name", label: "Nombre", required: true },
  { name: "model", label: "Modelo" },
  { name: "serial_number", label: "Serie" },
  { name: "firmware_version", label: "Firmware" },
  { name: "protocol", label: "Protocolo", type: "select", options: ["isup", "isapi", "manual", "mock"] },
  { name: "device_identifier", label: "Device ID" },
  { name: "isup_key_hash", label: "Hash ISUP Key" },
  { name: "status", label: "Estado", type: "select", options: ["online", "offline", "error"] },
  { name: "timezone", label: "Zona horaria" }
];

const assignmentFields: CrudField[] = [
  { name: "employee_id", label: "Employee ID", required: true },
  { name: "device_id", label: "Device ID", required: true },
  { name: "external_person_id", label: "ID persona externo" },
  { name: "sync_status", label: "Estado sync", type: "select", options: ["pending", "processing", "success", "failed", "cancelled"] }
];

const baseColumns = (items: CrudColumn[]) => items;

export function CompaniesPage() {
  return <CrudPage title="Empresas" table="companies" fields={companyFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "timezone", label: "Zona" }])} />;
}

export function BranchesPage() {
  return <CrudPage title="Sucursales" table="branches" fields={branchFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "code", label: "Codigo" }, { name: "is_active", label: "Activa" }])} />;
}

export function DepartmentsPage() {
  return <CrudPage title="Departamentos" table="departments" fields={departmentFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "code", label: "Codigo" }, { name: "is_active", label: "Activo" }])} />;
}

export function AttendanceGroupsPage() {
  return <CrudPage title="Grupos de asistencia" table="attendance_groups" fields={groupFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "tolerance_minutes", label: "Tolerancia" }, { name: "is_active", label: "Activo" }])} />;
}

export function WorkSchedulesPage() {
  return <CrudPage title="Horarios" table="work_schedules" fields={scheduleFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "default_check_in", label: "Entrada" }, { name: "default_check_out", label: "Salida" }, { name: "is_active", label: "Activo" }])} />;
}

export function EmployeesPage() {
  return <CrudPage title="Empleados" table="employees" fields={employeeFields} columns={baseColumns([{ name: "employee_code", label: "Codigo" }, { name: "full_name", label: "Nombre" }, { name: "status", label: "Estado", status: true }, { name: "fingerprint_status", label: "Huella", status: true }, { name: "face_status", label: "Rostro", status: true }])} />;
}

export function DevicesPage() {
  return <CrudPage title="Dispositivos" table="devices" fields={deviceFields} columns={baseColumns([{ name: "name", label: "Nombre" }, { name: "model", label: "Modelo" }, { name: "protocol", label: "Protocolo" }, { name: "status", label: "Estado", status: true }, { name: "last_seen_at", label: "Ultima conexion" }])} />;
}

export function EmployeeDevicesPage() {
  return <CrudPage title="Asignacion empleados-dispositivos" table="employee_devices" fields={assignmentFields} columns={baseColumns([{ name: "employee_id", label: "Empleado" }, { name: "device_id", label: "Dispositivo" }, { name: "sync_status", label: "Sync", status: true }])} />;
}
