import { CrudPage, type CrudColumn, type CrudField } from "../components/CrudPage";
import { useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField } from "@mui/material";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import SyncIcon from "@mui/icons-material/Sync";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

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
  { name: "device_ids", label: "Dispositivos destino", type: "relations", relation: { table: "devices", labelColumn: "name" }, helperText: "Se crearán comandos de persona y tarjeta para cada dispositivo." },
  { name: "pin_enabled", label: "PIN habilitado", type: "boolean", defaultValue: false },
  { name: "face_status", label: "Rostro", defaultValue: "none", hidden: true },
  { name: "fingerprint_status", label: "Huella", defaultValue: "none", hidden: true },
  { name: "fingerprint_count", label: "Cantidad huellas", type: "number", defaultValue: 0, hidden: true },
  { name: "hired_at", label: "Fecha contratacion", type: "date" },
  { name: "terminated_at", label: "Fecha baja", type: "date" }
];

const deviceFields: CrudField[] = [
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" } },
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
  const [message, setMessage] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [enrollment, setEnrollment] = useState<{ employeeId: string; name: string } | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [fingerNo, setFingerNo] = useState(1);
  const devices = useQuery({ queryKey: ["employee-workflow-devices"], queryFn: async () => {
    const { data, error } = await supabase.from("devices").select("id,name,status,dev_index").not("dev_index", "is", null).order("name");
    if (error) throw error; return data ?? [];
  }});
  async function invoke(body: Record<string, unknown>, success: string) {
    setMessage("");
    const { error } = await supabase.functions.invoke("admin-employees", { body });
    setMessage(error ? error.message : success);
    return !error;
  }
  return <>
    <CrudPage title="Empleados" table="employees" select="*, companies:company_id(name), branches:branch_id(name), departments:department_id(name), attendance_groups:attendance_group_id(name)" fields={employeeFields} mutationFunction="admin-employees" mutationPayloadKey="employee" realtimeTables={["employees", "employee_devices", "biometric_enrollment_sessions"]} headerActions={<Stack direction="row" spacing={1}>
      <Button startIcon={<SyncIcon />} onClick={() => setImportOpen(true)}>Sincronizar dispositivo</Button>
      <Button startIcon={<SyncIcon />} onClick={() => void invoke({ action: "sync_all_device_people" }, "Sincronización de todos los dispositivos en cola.")}>Sincronizar todos</Button>
    </Stack>} renderRowActions={(row) => <Button size="small" startIcon={<FingerprintIcon />} onClick={() => { setEnrollment({ employeeId: row.id, name: String(row.full_name ?? "Empleado") }); setDeviceId(""); }}>Capturar huella</Button>} columns={baseColumns([{ name: "employee_code", label: "Codigo" }, { name: "full_name", label: "Nombre" }, { name: "branches.name", label: "Sucursal" }, { name: "departments.name", label: "Departamento" }, { name: "status", label: "Estado", status: true }, { name: "fingerprint_status", label: "Huella", status: true }, { name: "face_status", label: "Rostro", status: true }])} />
    {message && <Alert sx={{ mt: 2 }} severity={/cola|iniciada/i.test(message) ? "success" : "error"}>{message}</Alert>}
    <Dialog open={importOpen} onClose={() => setImportOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Sincronizar empleados desde dispositivo</DialogTitle><DialogContent><TextField sx={{ mt: 1 }} select fullWidth label="Dispositivo" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>{(devices.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name} ({d.status})</MenuItem>)}</TextField></DialogContent><DialogActions><Button onClick={() => setImportOpen(false)}>Cancelar</Button><Button variant="contained" disabled={!deviceId} onClick={async () => { if (await invoke({ action: "sync_device_people", device_id: deviceId }, "Sincronización del dispositivo en cola.")) setImportOpen(false); }}>Sincronizar</Button></DialogActions></Dialog>
    <Dialog open={Boolean(enrollment)} onClose={() => setEnrollment(null)} fullWidth maxWidth="sm"><DialogTitle>Capturar huella — {enrollment?.name}</DialogTitle><DialogContent><Stack spacing={2} sx={{ mt: 1 }}><Alert severity="info">Al iniciar, coloque el dedo en el biométrico seleccionado. La plantilla no se guarda en RenovaGT.</Alert><TextField select fullWidth label="Dispositivo" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>{(devices.data ?? []).map((d) => <MenuItem key={d.id} value={d.id}>{d.name} ({d.status})</MenuItem>)}</TextField><TextField select fullWidth label="Dedo" value={fingerNo} onChange={(e) => setFingerNo(Number(e.target.value))}>{Array.from({ length: 10 }, (_, index) => <MenuItem key={index + 1} value={index + 1}>Huella {index + 1}</MenuItem>)}</TextField></Stack></DialogContent><DialogActions><Button onClick={() => setEnrollment(null)}>Cancelar</Button><Button variant="contained" disabled={!deviceId} onClick={async () => { if (enrollment && await invoke({ action: "enroll_fingerprint", employee_id: enrollment.employeeId, device_id: deviceId, finger_no: fingerNo }, "Captura iniciada; coloque el dedo en el dispositivo.")) setEnrollment(null); }}>Iniciar captura</Button></DialogActions></Dialog>
  </>;
}

export function DevicesPage() {
  return <CrudPage title="Dispositivos" table="devices" select="*, branches:branch_id(name)" fields={deviceFields} mutationFunction="admin-devices" realtimeTables={["devices", "device_status_logs"]} columns={baseColumns([{ name: "name", label: "Device Name" }, { name: "branches.name", label: "Sucursal" }, { name: "device_identifier", label: "Device ID" }, { name: "status", label: "Estado", status: true }, { name: "last_seen_at", label: "Última conexión (Guatemala)", dateTime: true }])} />;
}

export function EmployeeDevicesPage() {
  return <CrudPage title="Asignacion empleados-dispositivos" table="employee_devices" select="*, employees:employee_id(full_name,employee_code), devices:device_id(name)" fields={assignmentFields} columns={baseColumns([{ name: "employees.full_name", label: "Empleado" }, { name: "devices.name", label: "Dispositivo" }, { name: "sync_status", label: "Sync", status: true }])} />;
}
