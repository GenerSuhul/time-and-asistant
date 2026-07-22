import { useEffect, useMemo, useState } from "react";
import {
  Alert, Avatar, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, Drawer, FormControl, FormControlLabel, Grid2, IconButton, InputAdornment, LinearProgress,
  MenuItem, Paper, Select, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead,
  TablePagination, TableRow, Tabs, TextField, Typography, useMediaQuery
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import AddIcon from "@mui/icons-material/Add";
import BadgeIcon from "@mui/icons-material/Badge";
import CloseIcon from "@mui/icons-material/Close";
import CreditCardIcon from "@mui/icons-material/CreditCard";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import SyncIcon from "@mui/icons-material/Sync";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusChip } from "../components/StatusChip";
import { invokeEdge } from "../lib/edgeFunction";
import { supabase } from "../lib/supabase";

type Row = Record<string, any>;
type EmployeeForm = {
  id: string; company_id: string; branch_id: string; department_id: string; employee_code: string;
  external_employee_id: string; hikvision_employee_no: string; full_name: string; email: string; phone: string; document_number: string;
  status: "active" | "inactive" | "suspended"; card_number: string; pin_enabled: boolean;
  hired_at: string; terminated_at: string; access_valid_from: string; access_valid_to: string; target_device_ids: string[];
};
type CreationSession = { id: string; status: string; trace_id?: string; hikvision_employee_no?: string; error_code?: string; error_message?: string };

const today = new Date().toISOString().slice(0, 10);
const defaultValidTo = "2036-12-31";
const baseForm: EmployeeForm = { id: "", company_id: "", branch_id: "", department_id: "", employee_code: "", external_employee_id: "", hikvision_employee_no: "",
  full_name: "", email: "", phone: "", document_number: "", status: "active", card_number: "", pin_enabled: false,
  hired_at: today, terminated_at: "", access_valid_from: today, access_valid_to: defaultValidTo, target_device_ids: [] };
const freshForm = (companyId = ""): EmployeeForm => ({ ...baseForm, company_id: companyId, target_device_ids: [] });
const relation = (value: any) => Array.isArray(value) ? value[0] : value;
const relationLabel = (value: any, key = "name") => relation(value)?.[key] ?? "";

function formFromEmployee(row: Row, assignments: Row[]): EmployeeForm {
  return { ...baseForm, id: row.id, company_id: row.company_id ?? "", branch_id: row.branch_id ?? "", department_id: row.department_id ?? "",
    employee_code: row.employee_code ?? "", external_employee_id: row.external_employee_id ?? "", hikvision_employee_no: row.hikvision_employee_no ?? "", full_name: row.full_name ?? "",
    email: row.email ?? "", phone: row.phone ?? "", document_number: row.document_number ?? "", status: row.status ?? "active",
    card_number: row.card_number ?? "", pin_enabled: Boolean(row.pin_enabled), hired_at: row.hired_at ?? today,
    terminated_at: row.terminated_at ?? "", access_valid_from: row.access_valid_from ?? row.hired_at ?? today,
    access_valid_to: row.access_valid_to ?? defaultValidTo, target_device_ids: assignments.map((item) => item.device_id).filter(Boolean) };
}

export function EmployeeManagementPage() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [companyFilter, setCompanyFilter] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [open, setOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState<EmployeeForm>(() => freshForm());
  const [fingerDeviceId, setFingerDeviceId] = useState("");
  const [fingerNo, setFingerNo] = useState(1);
  const [syncDeviceId, setSyncDeviceId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const [notice, setNotice] = useState("");
  const [creationSession, setCreationSession] = useState<CreationSession | null>(null);
  const [enrollmentSessionId, setEnrollmentSessionId] = useState("");
  const [enrollmentState, setEnrollmentState] = useState<Row | null>(null);

  const catalog = useQuery({ queryKey: ["employee-catalog-v2"], queryFn: async () => {
    const [companies, branches, departments, devices] = await Promise.all([
      supabase.from("companies").select("id,name").order("name"),
      supabase.from("branches").select("id,name,company_id,unit_type").order("name"),
      supabase.from("departments").select("id,name,company_id,scope,is_active,department_branches(branch_id)").eq("is_active", true).order("name"),
      supabase.from("devices").select("id,name,status,dev_index,device_identifier,branch_id").order("name")
    ]);
    for (const result of [companies, branches, departments, devices]) if (result.error) throw result.error;
    return { companies: companies.data ?? [], branches: branches.data ?? [], departments: departments.data ?? [], devices: devices.data ?? [] };
  }});

  const employees = useQuery({
    queryKey: ["employees-management-v2", page, pageSize, search, statusFilter, companyFilter, branchFilter, departmentFilter],
    queryFn: async () => {
      let request = supabase.from("employees").select("*,companies:company_id(name),branches:branch_id(name),departments:department_id(name)", { count: "exact" })
        .order("full_name").range(page * pageSize, page * pageSize + pageSize - 1);
      if (statusFilter !== "all") request = request.eq("status", statusFilter);
      if (companyFilter) request = request.eq("company_id", companyFilter);
      if (branchFilter) request = request.eq("branch_id", branchFilter);
      if (departmentFilter) request = request.eq("department_id", departmentFilter);
      const safeSearch = search.trim().replace(/[%_,().]/g, " ");
      if (safeSearch) request = request.or(`employee_code.ilike.%${safeSearch}%,hikvision_employee_no.ilike.%${safeSearch}%,external_employee_id.ilike.%${safeSearch}%,full_name.ilike.%${safeSearch}%`);
      const peopleResult = await request;
      if (peopleResult.error) throw peopleResult.error;
      const ids = (peopleResult.data ?? []).map((item) => item.id);
      const [assignments, credentials, audits, commands] = await Promise.all([
        ids.length ? supabase.from("employee_devices").select("*,devices:device_id(id,name,status,dev_index)").in("employee_id", ids).order("created_at") : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from("employee_device_credentials").select("*").in("employee_id", ids).order("credential_type") : Promise.resolve({ data: [], error: null }),
        ids.length ? supabase.from("credential_audit_events").select("id,employee_id,device_id,command_id,action,status,trace_id,sanitized_error,created_at").in("employee_id", ids).order("created_at", { ascending: false }).limit(200) : Promise.resolve({ data: [], error: null }),
        supabase.from("device_commands").select("id,status,payload,command_type,device_id,employee_id,error_message,created_at,devices:device_id(name)").not("error_message", "is", null).order("created_at", { ascending: false }).limit(25)
      ]);
      for (const result of [assignments, credentials, audits, commands]) if (result.error) throw result.error;
      return { people: peopleResult.data ?? [], total: peopleResult.count ?? 0, assignments: assignments.data ?? [],
        credentials: credentials.data ?? [], audits: audits.data ?? [], commands: commands.data ?? [] };
    }, placeholderData: (previous) => previous
  });

  useEffect(() => { setPage(0); }, [search, statusFilter, companyFilter, branchFilter, departmentFilter, pageSize]);
  useEffect(() => {
    if (!creationSession?.id) return;
    const channel = supabase.channel(`employee-creation-${creationSession.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "employee_creation_sessions", filter: `id=eq.${creationSession.id}` }, (payload) => setCreationSession(payload.new as CreationSession))
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [creationSession?.id]);
  useEffect(() => {
    if (!enrollmentSessionId) return;
    const apply = (value: Row) => {
      setEnrollmentState(value);
      if (["success", "failed", "timeout"].includes(value.status)) void queryClient.invalidateQueries({ queryKey: ["employees-management-v2"] });
    };
    void supabase.from("biometric_enrollment_sessions").select("*").eq("id", enrollmentSessionId).single().then(({ data }) => { if (data) apply(data); });
    const channel = supabase.channel(`fingerprint-enrollment-${enrollmentSessionId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "biometric_enrollment_sessions", filter: `id=eq.${enrollmentSessionId}` }, (payload) => apply(payload.new))
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [enrollmentSessionId, queryClient]);

  const assignmentsByEmployee = useMemo(() => {
    const grouped: Record<string, Row[]> = {};
    for (const item of employees.data?.assignments ?? []) grouped[item.employee_id] = [...(grouped[item.employee_id] ?? []), item];
    return grouped;
  }, [employees.data?.assignments]);
  const credentialsByEmployeeDevice = useMemo(() => {
    const grouped: Record<string, Row[]> = {};
    for (const item of employees.data?.credentials ?? []) {
      const key = `${item.employee_id}:${item.device_id}`;
      grouped[key] = [...(grouped[key] ?? []), item];
    }
    return grouped;
  }, [employees.data?.credentials]);
  const latestAuditByEmployeeDevice = useMemo(() => {
    const grouped: Record<string, Row> = {};
    for (const item of employees.data?.audits ?? []) {
      const key = `${item.employee_id}:${item.device_id}`;
      if (!grouped[key]) grouped[key] = item;
    }
    return grouped;
  }, [employees.data?.audits]);
  const branchesForCompany = (catalog.data?.branches ?? []).filter((item) => !form.company_id || item.company_id === form.company_id);
  const departmentsForBranch = (catalog.data?.departments ?? []).filter((item) => !form.company_id || item.company_id === form.company_id)
    .filter((item) => !form.branch_id || (item.department_branches ?? []).some((link: Row) => link.branch_id === form.branch_id));
  const devices = catalog.data?.devices ?? [];
  const persistedIds = new Set((form.id ? assignmentsByEmployee[form.id] ?? [] : []).map((item) => item.device_id));
  const fingerprintDevices = devices.filter((item) => form.id ? persistedIds.has(item.id) : form.target_device_ids.includes(item.id));
  const visibleDepartments = (catalog.data?.departments ?? []).filter((item) => !branchFilter || (item.department_branches ?? []).some((link: Row) => link.branch_id === branchFilter));
  const commandFailures = (employees.data?.commands ?? []).filter((item) => !["success", "cancelled"].includes(item.status)).slice(0, 5);
  const selectedDeviceCredentials = form.id && fingerDeviceId ? credentialsByEmployeeDevice[`${form.id}:${fingerDeviceId}`] ?? [] : [];
  const selectedDeviceAudit = form.id && fingerDeviceId ? latestAuditByEmployeeDevice[`${form.id}:${fingerDeviceId}`] : null;

  function employeePayload() {
    return { company_id: form.company_id, branch_id: form.branch_id || null, department_id: form.department_id || null,
      employee_code: form.employee_code.trim(), external_employee_id: form.external_employee_id.trim() || null, hikvision_employee_no: form.hikvision_employee_no.trim() || null,
      full_name: form.full_name.trim(), email: form.email.trim() || null, phone: form.phone.trim() || null,
      document_number: form.document_number.trim() || null, status: form.status, card_number: form.card_number.trim() || null,
      pin_enabled: form.pin_enabled, hired_at: form.hired_at || null, terminated_at: form.terminated_at || null,
      access_valid_from: form.access_valid_from || null, access_valid_to: form.access_valid_to || null,
      metadata: {}, device_ids: form.target_device_ids };
  }
  function validateForm() {
    if (!form.company_id || !form.employee_code.trim() || !form.full_name.trim()) throw new Error("Empresa, ID y nombre son obligatorios.");
    if (form.hikvision_employee_no.trim() && !/^\d+$/.test(form.hikvision_employee_no.trim())) throw new Error("employeeNo Hikvision debe contener únicamente dígitos.");
    if (form.department_id && !form.branch_id) throw new Error("Selecciona una sucursal para asignar departamento.");
  }
  async function ensureCreationSession() {
    if (creationSession?.id) return creationSession.id;
    validateForm();
    const data = await invokeEdge<{ session: CreationSession }>("admin-employees", { action: "start_creation_session", employee: employeePayload() });
    setCreationSession(data.session);
    if (data.session.hikvision_employee_no) setForm((current) => ({ ...current, hikvision_employee_no: data.session.hikvision_employee_no ?? "" }));
    return data.session.id;
  }

  const saveEmployee = useMutation({ mutationFn: async ({ continueAdding }: { continueAdding: boolean }) => {
    validateForm();
    if (creationSession?.status === "enrolling") throw new Error("Espera a que la captura termine o cancélala antes de guardar.");
    if (creationSession?.status === "failed") throw new Error("La captura falló. Reinténtala o cancela esta creación.");
    const action = editing ? "update" : creationSession ? "commit_creation_session" : "create";
    const data = await invokeEdge<{ employee: Row }>("admin-employees", { action, id: editing?.id, session_id: creationSession?.id, employee: employeePayload() });
    if (!data.employee?.id) throw new Error("El backend no devolvió la persona guardada.");
    return { continueAdding };
  }, onSuccess: async ({ continueAdding }) => {
    await queryClient.invalidateQueries({ queryKey: ["employees-management-v2"] });
    const wasEditing = Boolean(editing);
    setCreationSession(null); setEnrollmentSessionId(""); setEnrollmentState(null); setCredentialOpen(false); setFingerDeviceId(""); setFingerNo(1); setEditing(null);
    if (continueAdding && !wasEditing) { setForm(freshForm(catalog.data?.companies[0]?.id ?? "")); setActiveTab("basic"); setNotice("Persona creada. El formulario está listo para continuar."); }
    else { setOpen(false); setForm(freshForm()); setActiveTab("basic"); setNotice(wasEditing ? "Persona actualizada correctamente." : "Persona creada y credenciales coordinadas correctamente."); }
  }});
  const enrollFingerprint = useMutation({ mutationFn: async () => {
    validateForm();
    if (!fingerDeviceId) throw new Error("Selecciona el dispositivo de enrolamiento.");
    if (form.id) {
      const data = await invokeEdge<{ enrollment_session_id: string; trace_id: string; job_id: string }>("admin-employees", { action: "enroll_fingerprint", employee_id: form.id, device_id: fingerDeviceId, finger_no: fingerNo });
      setEnrollmentSessionId(data.enrollment_session_id);
      return data;
    }
    if (!form.target_device_ids.includes(fingerDeviceId)) throw new Error("El dispositivo debe estar seleccionado como destino.");
    const sessionId = await ensureCreationSession();
    const data = await invokeEdge<{ enrollment_session_id: string; trace_id: string; job_id: string }>("admin-employees", {
      action: "stage_fingerprint", session_id: sessionId, employee: employeePayload(), device_id: fingerDeviceId, finger_no: fingerNo
    });
    setEnrollmentSessionId(data.enrollment_session_id);
    setCreationSession((current) => current ? { ...current, status: "enrolling", trace_id: data.trace_id } : current);
    return data;
  }, onSuccess: () => setNotice("Captura iniciada; el progreso se actualiza en tiempo real.") });
  const deleteEmployee = useMutation({ mutationFn: (row: Row) => invokeEdge("admin-employees", { action: "delete", id: row.id }), onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ["employees-management-v2"] }); setDeleteTarget(null); setNotice("Persona eliminada; las bajas quedaron encoladas por dispositivo.");
  }});
  const syncPeople = useMutation({ mutationFn: () => invokeEdge("admin-employees", { action: "sync_device_people", device_id: syncDeviceId }), onSuccess: () => { setSyncOpen(false); setSyncDeviceId(""); setNotice("Sincronización real encolada."); }});
  const syncAll = useMutation({ mutationFn: () => invokeEdge("admin-employees", { action: "sync_all_device_people" }), onSuccess: () => setNotice("Sincronización real encolada para todos los dispositivos.") });

  function resetEditor() { setCredentialOpen(false); setFingerDeviceId(""); setFingerNo(1); setCreationSession(null); setEnrollmentSessionId(""); setEnrollmentState(null); setEditing(null); setForm(freshForm()); setActiveTab("basic"); }
  function startCreate() { resetEditor(); setForm(freshForm(catalog.data?.companies[0]?.id ?? "")); setOpen(true); }
  function startEdit(row: Row) { resetEditor(); setEditing(row); setForm(formFromEmployee(row, assignmentsByEmployee[row.id] ?? [])); setOpen(true); }
  async function closeEditor() {
    if (saveEmployee.isPending) return;
    const sessionId = creationSession?.id;
    setOpen(false); resetEditor();
    if (sessionId) {
      try { await invokeEdge("admin-employees", { action: "cancel_creation_session", session_id: sessionId, reason: "editor_closed" }); }
      catch (error) { setNotice(error instanceof Error ? `La limpieza staged requiere revisión: ${error.message}` : "La limpieza staged falló."); }
    }
  }

  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", lg: "row" }} justifyContent="space-between" gap={1.5}>
      <Box><Typography variant="h4">Personas</Typography><Typography color="text.secondary">Vista operacional tipo HikCentral con filtros jerárquicos, paginación y credenciales.</Typography></Box>
      <Stack direction={{ xs: "column", sm: "row" }} gap={1}><IconButton onClick={() => employees.refetch()}><RefreshIcon /></IconButton><Button variant="outlined" startIcon={<SyncIcon />} onClick={() => setSyncOpen(true)}>Importar dispositivo</Button><Button variant="outlined" startIcon={<SyncIcon />} onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>Sincronizar todos</Button><Button variant="contained" startIcon={<AddIcon />} onClick={startCreate}>Añadir persona</Button></Stack>
    </Stack>
    <Grid2 container spacing={1.5}>
      <Grid2 size={{ xs: 12, md: 2.4 }}><Paper variant="outlined" sx={{ p: 1.25, maxHeight: 620, overflowY: "auto", minWidth: 0 }}><Typography fontWeight={700} sx={{ mb: 1, fontSize: 14 }}>Sucursales</Typography><Button fullWidth size="small" variant={!companyFilter && !branchFilter ? "contained" : "text"} onClick={() => { setCompanyFilter(""); setBranchFilter(""); setDepartmentFilter(""); }}>Todas</Button>{(catalog.data?.companies ?? []).map((company) => <Box key={company.id} sx={{ mt: 1 }}><Button fullWidth size="small" sx={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", lineHeight: 1.2, px: 1 }} variant={companyFilter === company.id && !branchFilter ? "contained" : "text"} onClick={() => { setCompanyFilter(company.id); setBranchFilter(""); setDepartmentFilter(""); }}>{company.name}</Button>{(catalog.data?.branches ?? []).filter((branch) => branch.company_id === company.id).map((branch) => <Box key={branch.id} sx={{ pl: 0.75 }}><Button fullWidth size="small" sx={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", lineHeight: 1.2, px: 1 }} variant={branchFilter === branch.id && !departmentFilter ? "outlined" : "text"} onClick={() => { setCompanyFilter(company.id); setBranchFilter(branch.id); setDepartmentFilter(""); }}>{branch.name}</Button>{branchFilter === branch.id && visibleDepartments.filter((dept) => dept.company_id === company.id).map((dept) => <Button key={dept.id} fullWidth size="small" sx={{ justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", lineHeight: 1.2, pl: 2.25, pr: 1 }} variant={departmentFilter === dept.id ? "contained" : "text"} onClick={() => setDepartmentFilter(dept.id)}>{dept.name}</Button>)}</Box>)}</Box>)}</Paper></Grid2>
      <Grid2 size={{ xs: 12, md: 9.6 }}><Stack spacing={1.5}>
        <Paper variant="outlined" sx={{ p: 1.5 }}><Stack direction={{ xs: "column", sm: "row" }} gap={1}><TextField size="small" fullWidth placeholder="Buscar ID o nombre (server-side)" value={search} onChange={(event) => setSearch(event.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} /><TextField size="small" select label="Estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} sx={{ minWidth: 160 }}><MenuItem value="active">Activos</MenuItem><MenuItem value="inactive">Inactivos</MenuItem><MenuItem value="suspended">Suspendidos</MenuItem><MenuItem value="all">Todos</MenuItem></TextField></Stack></Paper>
        {(employees.isLoading || catalog.isLoading) && <LinearProgress />}{(employees.error || catalog.error || saveEmployee.error || deleteEmployee.error || syncAll.error) && <Alert severity="error">{String(employees.error?.message ?? catalog.error?.message ?? saveEmployee.error?.message ?? deleteEmployee.error?.message ?? syncAll.error?.message)}</Alert>}{notice && <Alert severity={notice.includes("requiere revisión") ? "warning" : "success"} onClose={() => setNotice("")}>{notice}</Alert>}
        {commandFailures.length > 0 && <Alert severity="error"><Typography fontWeight={700}>Comandos con error/reintento:</Typography>{commandFailures.map((command) => <Typography key={command.id} variant="body2">{command.command_type} · {relationLabel(command.devices) || command.device_id} · {command.status}: {command.error_message} · Job: {command.id}{command.payload?.trace_id ? ` · Trace: ${command.payload.trace_id}` : ""}</Typography>)}</Alert>}
        <TableContainer component={Paper} variant="outlined"><Table size="small"><TableHead><TableRow><TableCell>Foto</TableCell><TableCell>ID / persona</TableCell><TableCell>Resumen</TableCell><TableCell>Estado real por dispositivo</TableCell><TableCell>Estado</TableCell><TableCell align="right">Acciones</TableCell></TableRow></TableHead><TableBody>{(employees.data?.people ?? []).map((row) => <TableRow key={row.id} hover><TableCell><Avatar><BadgeIcon /></Avatar></TableCell><TableCell><Typography fontWeight={700}>{row.full_name}</Typography><Typography variant="caption" display="block">Código: {row.employee_code} · Hikvision: {row.hikvision_employee_no}</Typography><Typography variant="caption">{relationLabel(row.branches) || "Sin sucursal"}</Typography></TableCell><TableCell><Stack direction="row" gap={0.5}><Chip size="small" icon={<CreditCardIcon />} label={row.card_number ? "Tarjeta" : "Sin tarjeta"} /><Chip size="small" icon={<FingerprintIcon />} color={(row.fingerprint_count ?? 0) > 0 ? "success" : "default"} label={`Huellas verificadas ${row.fingerprint_count ?? 0}`} /></Stack></TableCell><TableCell><Stack gap={0.75}>{(assignmentsByEmployee[row.id] ?? []).map((item) => <DeviceCredentialSummary key={item.id} assignment={item} credentials={credentialsByEmployeeDevice[`${row.id}:${item.device_id}`] ?? []} audit={latestAuditByEmployeeDevice[`${row.id}:${item.device_id}`]} expectedEmployeeNo={row.hikvision_employee_no} />)}</Stack></TableCell><TableCell><StatusChip value={row.status} /></TableCell><TableCell align="right"><IconButton onClick={() => startEdit(row)}><EditIcon fontSize="small" /></IconButton><IconButton color="error" onClick={() => setDeleteTarget(row)}><DeleteIcon fontSize="small" /></IconButton></TableCell></TableRow>)}</TableBody></Table><TablePagination component="div" count={employees.data?.total ?? 0} page={page} onPageChange={(_, value) => setPage(value)} rowsPerPage={pageSize} onRowsPerPageChange={(event) => setPageSize(Number(event.target.value))} rowsPerPageOptions={[20, 50, 100]} labelRowsPerPage="Filas" labelDisplayedRows={({ from, to, count }) => `${from}-${to} de ${count}`} /></TableContainer>
      </Stack></Grid2>
    </Grid2>

    <Dialog open={open} onClose={() => void closeEditor()} fullWidth fullScreen={fullScreen} maxWidth="lg" scroll="paper" PaperProps={{ sx: { maxHeight: { sm: "calc(100dvh - 32px)" } } }}><DialogTitle><Stack direction="row" justifyContent="space-between"><Box><Typography variant="h5">{editing ? "Editar persona" : "Añadir persona"}</Typography><Typography variant="body2" color="text.secondary">Datos, acceso y credenciales en una sola operación.</Typography></Box><IconButton onClick={() => void closeEditor()}><CloseIcon /></IconButton></Stack></DialogTitle><DialogContent dividers><Grid2 container spacing={2}><Grid2 size={{ xs: 12, md: 8 }}><Paper variant="outlined"><Tabs value={activeTab} onChange={(_, value) => setActiveTab(value)} variant="scrollable"><Tab value="basic" label="Información básica" /><Tab value="access" label="Dispositivos" /><Tab value="schedule" label="Vigencia" /></Tabs><Box sx={{ p: 2 }}>
      {activeTab === "basic" && <Grid2 container spacing={1.5}><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth select label="Empresa *" value={form.company_id} onChange={(event) => setForm((current) => ({ ...current, company_id: event.target.value, branch_id: "", department_id: "", hikvision_employee_no: "" }))}>{catalog.data?.companies.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth select label="Sucursal" value={form.branch_id} onChange={(event) => setForm((current) => ({ ...current, branch_id: event.target.value, department_id: "" }))}><MenuItem value="">Sin sucursal</MenuItem>{branchesForCompany.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth select label="Departamento" value={form.department_id} onChange={(event) => setForm((current) => ({ ...current, department_id: event.target.value }))}><MenuItem value="">Sin departamento</MenuItem>{departmentsForBranch.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Código interno / HR *" value={form.employee_code} disabled={Boolean(creationSession)} onChange={(event) => setForm((current) => ({ ...current, employee_code: event.target.value }))} helperText="Puede ser alfanumérico, por ejemplo PO001." /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth label="employeeNo Hikvision" value={form.hikvision_employee_no} disabled={Boolean(creationSession) || Boolean(editing && form.target_device_ids.length)} onChange={(event) => setForm((current) => ({ ...current, hikvision_employee_no: event.target.value.replace(/\D/g, "") }))} inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }} helperText={form.hikvision_employee_no ? "Identificador numérico usado únicamente en dispositivos." : "Se asignará automáticamente; si el código interno es numérico se reutilizará."} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Nombre completo *" value={form.full_name} onChange={(event) => setForm((current) => ({ ...current, full_name: event.target.value }))} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Documento" value={form.document_number} onChange={(event) => setForm((current) => ({ ...current, document_number: event.target.value }))} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Correo" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Teléfono" value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth select label="Estado" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as EmployeeForm["status"] }))}><MenuItem value="active">Activo</MenuItem><MenuItem value="inactive">Inactivo</MenuItem><MenuItem value="suspended">Suspendido</MenuItem></TextField></Grid2></Grid2>}
      {activeTab === "access" && <Stack spacing={1.5}><Typography fontWeight={700}>Dispositivos destino</Typography><FormControl fullWidth><Select multiple value={form.target_device_ids} onChange={(event) => setForm((current) => ({ ...current, target_device_ids: typeof event.target.value === "string" ? event.target.value.split(",") : event.target.value }))} renderValue={(selected) => <Stack direction="row" gap={0.5} flexWrap="wrap">{selected.map((id) => <Chip key={id} size="small" label={devices.find((item) => item.id === id)?.name ?? id} />)}</Stack>}>{devices.map((device) => <MenuItem key={device.id} value={device.id}><Checkbox checked={form.target_device_ids.includes(device.id)} />{device.name} ({device.status}{device.dev_index ? "" : ", sin devIndex"})</MenuItem>)}</Select></FormControl><Alert severity="info">Al confirmar se sincronizan persona y tarjeta. Las huellas no se copian entre equipos: cada dispositivo nuevo queda “pendiente de captura” hasta verificarla físicamente.</Alert></Stack>}
      {activeTab === "schedule" && <Grid2 container spacing={1.5}><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth type="date" label="Incorporación" value={form.hired_at} onChange={(event) => setForm((current) => ({ ...current, hired_at: event.target.value }))} InputLabelProps={{ shrink: true }} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth type="date" label="Válido desde" value={form.access_valid_from} onChange={(event) => setForm((current) => ({ ...current, access_valid_from: event.target.value }))} InputLabelProps={{ shrink: true }} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth type="date" label="Válido hasta" value={form.access_valid_to} onChange={(event) => setForm((current) => ({ ...current, access_valid_to: event.target.value }))} InputLabelProps={{ shrink: true }} /></Grid2><Grid2 size={{ xs: 12, sm: 6 }}><TextField fullWidth type="date" label="Fecha baja" value={form.terminated_at} onChange={(event) => setForm((current) => ({ ...current, terminated_at: event.target.value }))} InputLabelProps={{ shrink: true }} /></Grid2></Grid2>}
    </Box></Paper></Grid2><Grid2 size={{ xs: 12, md: 4 }}><Paper variant="outlined" sx={{ p: 2 }}><Stack spacing={1.5}><Stack direction="row" gap={1}><Avatar variant="rounded"><BadgeIcon /></Avatar><Box><Typography fontWeight={700}>Credenciales</Typography><Typography variant="body2" color="text.secondary">Tarjeta, PIN y huella staged.</Typography></Box></Stack><Divider /><Stack direction="row" gap={0.5}><Chip icon={<CreditCardIcon />} label={form.card_number ? "Tarjeta 1" : "Tarjeta 0"} /><Chip icon={<FingerprintIcon />} label={creationSession?.status === "captured" ? "Huella capturada" : `Huellas ${editing?.fingerprint_count ?? 0}`} /></Stack><Button variant="outlined" onClick={() => setCredentialOpen(true)}>Administración de credencial</Button><Alert severity="warning">Rostro e iris siguen bloqueados hasta aprobar almacenamiento cifrado y retención.</Alert></Stack></Paper></Grid2></Grid2></DialogContent><DialogActions sx={{ flexWrap: "wrap" }}><Button onClick={() => void closeEditor()}>Cancelar</Button><Button variant={editing ? "contained" : "outlined"} disabled={saveEmployee.isPending || creationSession?.status === "enrolling"} onClick={() => saveEmployee.mutate({ continueAdding: false })}>{editing ? "Guardar" : "Añadir"}</Button>{!editing && <Button variant="contained" disabled={saveEmployee.isPending || creationSession?.status === "enrolling"} onClick={() => saveEmployee.mutate({ continueAdding: true })}>Añadir y continuar</Button>}</DialogActions></Dialog>

    <Drawer anchor="right" open={open && credentialOpen} onClose={() => setCredentialOpen(false)} sx={{ zIndex: (value) => value.zIndex.modal + 1 }} PaperProps={{ sx: { width: { xs: "100%", sm: 480 }, p: 2, overflowY: "auto" } }}><Stack spacing={2}><Stack direction="row" justifyContent="space-between"><Typography variant="h6">Administración de credencial</Typography><IconButton onClick={() => setCredentialOpen(false)}><CloseIcon /></IconButton></Stack><Divider /><Typography fontWeight={700}>Tarjeta y PIN</Typography><TextField label="Número de tarjeta" value={form.card_number} onChange={(event) => setForm((current) => ({ ...current, card_number: event.target.value }))} /><FormControlLabel control={<Checkbox checked={form.pin_enabled} onChange={(event) => setForm((current) => ({ ...current, pin_enabled: event.target.checked }))} />} label="PIN habilitado" /><Divider /><Typography fontWeight={700}>Huella dactilar por dispositivo</Typography><Alert severity={form.hikvision_employee_no ? "success" : "info"}>employeeNo Hikvision: <strong>{form.hikvision_employee_no || "se asignará al preparar la captura"}</strong>. El código interno {form.employee_code || "del empleado"} no se envía al equipo.</Alert>{!form.target_device_ids.length && !form.id && <Alert severity="warning">Selecciona un dispositivo destino antes de capturar.</Alert>}<TextField select label="Dispositivo" value={fingerDeviceId} onChange={(event) => setFingerDeviceId(event.target.value)} disabled={!fingerprintDevices.length} SelectProps={{ MenuProps: { sx: { zIndex: (value) => value.zIndex.modal + 2 } } }}><MenuItem value="">Selecciona dispositivo</MenuItem>{fingerprintDevices.map((device) => <MenuItem key={device.id} value={device.id}>{device.name} ({device.status})</MenuItem>)}</TextField>{fingerDeviceId && form.id && <CredentialDevicePanel credentials={selectedDeviceCredentials} audit={selectedDeviceAudit} />}<TextField select label="Dedo" value={fingerNo} onChange={(event) => setFingerNo(Number(event.target.value))} SelectProps={{ MenuProps: { sx: { zIndex: (value) => value.zIndex.modal + 2 } } }}>{Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <MenuItem key={value} value={value}>Huella {value}</MenuItem>)}</TextField><Button variant="contained" startIcon={<FingerprintIcon />} disabled={enrollFingerprint.isPending || !fingerDeviceId || creationSession?.status === "enrolling"} onClick={() => enrollFingerprint.mutate()}>Capturar huella en este dispositivo</Button>{enrollFingerprint.error && <Alert severity="error">{enrollFingerprint.error.message}</Alert>}{(creationSession || enrollmentState) && <Alert severity={(enrollmentState?.status ?? creationSession?.status) === "failed" ? "error" : ["success", "captured"].includes(enrollmentState?.status ?? creationSession?.status ?? "") ? "success" : "info"}><Typography fontWeight={700}>{enrollmentState?.status_detail ?? statusLabel(creationSession?.status)}</Typography>{enrollmentState?.error_message && <Typography variant="body2">{enrollmentState.error_message}</Typography>}<Typography variant="caption">Trace: {creationSession?.trace_id || enrollmentState?.trace_id || "pendiente"}</Typography></Alert>}<Alert severity="info">La huella se captura y verifica únicamente en el dispositivo seleccionado. El template existe solo en memoria durante CaptureFingerPrint → FingerPrintDownload; nunca llega al navegador ni se persiste.</Alert></Stack></Drawer>

    <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} maxWidth="sm" fullWidth><DialogTitle>Eliminar persona</DialogTitle><DialogContent><Typography>¿Eliminar a <strong>{deleteTarget?.full_name}</strong> y encolar <code>delete_person</code> en cada dispositivo asignado?</Typography>{deleteEmployee.error && <Alert severity="error" sx={{ mt: 2 }}>{deleteEmployee.error.message}</Alert>}</DialogContent><DialogActions><Button onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button color="error" variant="contained" onClick={() => deleteTarget && deleteEmployee.mutate(deleteTarget)}>Eliminar</Button></DialogActions></Dialog>
    <Dialog open={syncOpen} onClose={() => setSyncOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Importar personas del dispositivo</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}><TextField select label="Dispositivo real" value={syncDeviceId} onChange={(event) => setSyncDeviceId(event.target.value)}><MenuItem value="">Selecciona</MenuItem>{devices.map((item) => <MenuItem key={item.id} value={item.id}>{item.name} ({item.status})</MenuItem>)}</TextField><Alert severity="info">Lee DeviceGateway y hace upsert real; no crea datos demo.</Alert>{syncPeople.error && <Alert severity="error">{syncPeople.error.message}</Alert>}</Stack></DialogContent><DialogActions><Button onClick={() => setSyncOpen(false)}>Cancelar</Button><Button variant="contained" startIcon={<PersonSearchIcon />} disabled={!syncDeviceId || syncPeople.isPending} onClick={() => syncPeople.mutate()}>Sincronizar</Button></DialogActions></Dialog>
  </Stack>;
}

function statusLabel(status?: string) {
  if (status === "draft") return "Preparando captura";
  if (status === "enrolling") return "Esperando dedo en el dispositivo";
  if (status === "captured") return "Huella capturada; lista para añadir";
  if (status === "failed") return "La captura falló";
  return "Preparando captura";
}

function DeviceCredentialSummary({ assignment, credentials, audit, expectedEmployeeNo }: { assignment: Row; credentials: Row[]; audit?: Row; expectedEmployeeNo: string }) {
  const byType = Object.fromEntries(credentials.map((item) => [item.credential_type, item]));
  const mismatch = assignment.external_person_id !== expectedEmployeeNo;
  return <Paper variant="outlined" sx={{ px: 1, py: 0.75, minWidth: 390 }} title={mismatch ? `Identificador físico ${assignment.external_person_id}; esperado ${expectedEmployeeNo}` : undefined}>
    <Stack direction={{ xs: "column", sm: "row" }} gap={0.5} alignItems={{ sm: "center" }} flexWrap="wrap">
      <Typography variant="caption" fontWeight={700} sx={{ minWidth: 145 }}>{assignment.devices?.name ?? assignment.device_id}</Typography>
      <CredentialStateChip label="Persona" state={byType.person} fallback={assignment.sync_status} />
      <CredentialStateChip label="Tarjeta" state={byType.card} />
      <CredentialStateChip label="Huella" state={byType.fingerprint} />
    </Stack>
    {(byType.person?.last_error || byType.card?.last_error || byType.fingerprint?.last_error || audit?.sanitized_error || mismatch) && <Typography variant="caption" color="error" display="block" sx={{ mt: 0.5 }}>
      {mismatch ? `employeeNo físico no coincide (${assignment.external_person_id}). ` : ""}{byType.fingerprint?.last_error || byType.person?.last_error || byType.card?.last_error || audit?.sanitized_error} {audit?.trace_id ? `Trace: ${audit.trace_id}` : ""}
    </Typography>}
  </Paper>;
}

function CredentialDevicePanel({ credentials, audit }: { credentials: Row[]; audit?: Row | null }) {
  const byType = Object.fromEntries(credentials.map((item) => [item.credential_type, item]));
  return <Paper variant="outlined" sx={{ p: 1.25 }}><Stack spacing={0.75}>
    <Typography variant="body2" fontWeight={700}>Estado confirmado por DeviceGateway</Typography>
    <Stack direction="row" gap={0.5} flexWrap="wrap"><CredentialStateChip label="Persona" state={byType.person} /><CredentialStateChip label="Tarjeta" state={byType.card} /><CredentialStateChip label="Huella" state={byType.fingerprint} /></Stack>
    {(byType.fingerprint?.last_error || audit?.sanitized_error) && <Alert severity="error"><Typography variant="body2">{byType.fingerprint?.last_error || audit?.sanitized_error}</Typography><Typography variant="caption">Trace: {byType.fingerprint?.trace_id || audit?.trace_id || "no disponible"}</Typography></Alert>}
  </Stack></Paper>;
}

function CredentialStateChip({ label, state, fallback = "pending" }: { label: string; state?: Row; fallback?: string }) {
  const status = state?.status ?? fallback;
  const color = ["captured", "synced"].includes(status) ? "success" : status === "failed" ? "error" : ["pending", "processing"].includes(status) ? "warning" : "default";
  const verifiedCount = Number(state?.verified_count ?? 0);
  const suffix = verifiedCount > 0 ? ` ${verifiedCount}` : "";
  return <Chip size="small" color={color} variant={color === "default" ? "outlined" : "filled"} label={`${label}: ${credentialStatusLabel(status)}${suffix}`} />;
}

function credentialStatusLabel(status: string) {
  if (status === "synced") return "sincronizada";
  if (status === "captured") return "capturada";
  if (status === "processing") return "procesando";
  if (status === "pending") return "pendiente";
  if (status === "failed") return "fallida";
  return "sin credencial";
}
