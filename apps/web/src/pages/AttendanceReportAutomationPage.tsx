import { useMemo, useState } from "react";
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  IconButton, MenuItem, Paper, Stack, Switch, Tab, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, Tabs, TextField, Typography
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import PreviewIcon from "@mui/icons-material/Preview";
import ReplayIcon from "@mui/icons-material/Replay";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CrudPage, type CrudField } from "../components/CrudPage";
import { supabase } from "../lib/supabase";

const contactRoles = ["custom_to", "custom_cc", "branch_manager", "regional_supervisor", "hr_assistant", "hr_manager", "commercial_manager", "department_head"];
const roleLabels: Record<string, string> = {
  custom_to: "Destinatario principal", custom_cc: "Copia personalizada", branch_manager: "Gerente de tienda",
  regional_supervisor: "Supervisor regional", hr_assistant: "Asistente RRHH", hr_manager: "Gerente RRHH",
  commercial_manager: "Gerente comercial", department_head: "Encargado de departamento"
};

const ruleFields: CrudField[] = [
  { name: "company_id", label: "Empresa (opcional)", type: "relation", relation: { table: "companies", labelColumn: "name" } },
  { name: "code", label: "Código", required: true }, { name: "name", label: "Nombre", required: true },
  { name: "applicable_unit_type", label: "Tipo aplicable", type: "select", options: ["store", "administration", "department"], required: true },
  { name: "expected_check_in", label: "Entrada esperada", type: "time", required: true },
  { name: "expected_check_out", label: "Salida esperada", type: "time", required: true },
  { name: "max_break_minutes", label: "Pausa máxima (min)", type: "number", required: true },
  { name: "check_in_tolerance_minutes", label: "Tolerancia de entrada (min)", type: "number", defaultValue: 0 },
  { name: "check_out_tolerance_minutes", label: "Tolerancia de salida (min)", type: "number", defaultValue: 0 },
  { name: "warnings_trigger_hr_copy", label: "Alertas también copian a gerente RRHH", type: "boolean", defaultValue: false },
  { name: "is_active", label: "Activa", type: "boolean", defaultValue: true }
];

const configFields: CrudField[] = [
  { name: "company_id", label: "Empresa", type: "relation", relation: { table: "companies", labelColumn: "name" }, required: true },
  { name: "branch_id", label: "Sucursal", type: "relation", relation: { table: "branches", labelColumn: "name" }, required: true },
  { name: "department_id", label: "Departamento", type: "relation", relation: { table: "departments", labelColumn: "name" } },
  { name: "region", label: "Región" },
  { name: "unit_type", label: "Tipo de unidad", type: "select", options: ["store", "administration", "department"], required: true, defaultValue: "store" },
  { name: "send_time", label: "Hora automática (Guatemala)", type: "time", required: true, defaultValue: "06:00" },
  { name: "rule_id", label: "Regla de asistencia", type: "relation", relation: { table: "attendance_report_rules", labelColumn: "name" }, required: true },
  { name: "include_excel", label: "Adjuntar Excel", type: "boolean", defaultValue: true },
  { name: "include_html", label: "Incluir resumen HTML", type: "boolean", defaultValue: true },
  { name: "copy_hr_manager_only_on_violation", label: "Gerente RRHH solo con infracción", type: "boolean", defaultValue: true },
  { name: "warnings_trigger_hr_copy", label: "Alertas también copian gerente RRHH", type: "boolean", defaultValue: false },
  { name: "copy_commercial_manager", label: "Copiar gerente comercial", type: "boolean", defaultValue: true },
  { name: "is_active", label: "Envío automático activo", type: "boolean", defaultValue: false }
];

export function AttendanceReportAutomationPage() {
  const [tab, setTab] = useState(0);
  return <Stack spacing={2}>
    <Box><Typography variant="h4">Reportes automáticos</Typography><Typography color="text.secondary">Configura destinatarios, reglas y envíos diarios del día anterior.</Typography></Box>
    <Paper variant="outlined"><Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto">
      <Tab label="Contactos" /><Tab label="Configuraciones" /><Tab label="Reglas" /><Tab label="Ejecuciones" />
    </Tabs></Paper>
    {tab === 0 && <ContactsSection />}
    {tab === 1 && <CrudPage title="Configuración de reportes" table="attendance_report_configs" orderBy="send_time"
      select="*, branches:branch_id(name), departments:department_id(name), attendance_report_rules:rule_id(name)" fields={configFields}
      columns={[{ name: "branches.name", label: "Sucursal" }, { name: "departments.name", label: "Departamento" }, { name: "region", label: "Región" }, { name: "unit_type", label: "Tipo" }, { name: "send_time", label: "Hora" }, { name: "attendance_report_rules.name", label: "Regla" }, { name: "is_active", label: "Activo", status: true }]} />}
    {tab === 2 && <CrudPage title="Reglas de asistencia" table="attendance_report_rules" orderBy="name" fields={ruleFields}
      columns={[{ name: "code", label: "Código" }, { name: "name", label: "Nombre" }, { name: "applicable_unit_type", label: "Tipo" }, { name: "expected_check_in", label: "Entrada" }, { name: "expected_check_out", label: "Salida" }, { name: "max_break_minutes", label: "Pausa máxima" }, { name: "is_active", label: "Activa", status: true }]} />}
    {tab === 3 && <RunsSection />}
  </Stack>;
}

function ContactsSection() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(emptyContact());
  const lookups = useQuery({ queryKey: ["report-contact-lookups"], queryFn: async () => {
    const [companies, branches, departments] = await Promise.all([
      supabase.from("companies").select("id,name").order("name"), supabase.from("branches").select("id,name,company_id").order("name"),
      supabase.from("departments").select("id,name,department_branches(branch_id)").order("name")
    ]);
    for (const result of [companies, branches, departments]) if (result.error) throw result.error;
    return { companies: companies.data ?? [], branches: branches.data ?? [], departments: departments.data ?? [] };
  }});
  const contacts = useQuery({ queryKey: ["attendance_report_contacts"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_contacts").select("*, branches:branch_id(name), departments:department_id(name)").order("name");
    if (error) throw error; return data ?? [];
  }});
  const groups = useMemo(() => groupContacts(contacts.data ?? []), [contacts.data]);
  const save = useMutation({ mutationFn: async () => {
    const payload = { ...form, email: form.email.trim().toLowerCase(), branch_id: form.branch_id || null, department_id: form.department_id || null, region: form.region || null };
    const request = editing ? supabase.from("attendance_report_contacts").update(payload).eq("id", editing.id) : supabase.from("attendance_report_contacts").insert(payload);
    const { error } = await request; if (error) throw error;
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["attendance_report_contacts"] }); setOpen(false); }});
  const remove = useMutation({ mutationFn: async (id: string) => { const { error } = await supabase.from("attendance_report_contacts").delete().eq("id", id); if (error) throw error; }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_contacts"] }) });
  function start(contact?: any) {
    setEditing(contact ?? null);
    setForm(contact ? {
      company_id: contact.company_id,
      branch_id: contact.branch_id ?? "",
      department_id: contact.department_id ?? "",
      name: contact.name,
      email: contact.email,
      role: contact.role,
      region: contact.region ?? "",
      is_active: contact.is_active,
      receives_store_reports: contact.receives_store_reports,
      receives_administration_reports: contact.receives_administration_reports,
      only_on_violation: contact.only_on_violation
    } : emptyContact());
    setOpen(true);
  }
  return <Stack spacing={2}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="h6">Contactos por sucursal</Typography><Button variant="contained" startIcon={<AddIcon />} onClick={() => start()}>Agregar contacto</Button></Stack>
    {(contacts.error || save.error || remove.error) && <Alert severity="error">{String(contacts.error?.message ?? save.error?.message ?? remove.error?.message)}</Alert>}
    {[...groups.entries()].map(([group, items]) => <Paper key={group} variant="outlined" sx={{ p: 2 }}><Typography variant="h6" sx={{ mb: 1.5 }}>{group}</Typography><Stack spacing={1}>
      {items.map((contact: any) => <Stack key={contact.id} direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }} sx={{ p: 1.2, border: 1, borderColor: "divider", borderRadius: 1 }}>
        <Box sx={{ flex: 1 }}><Typography fontWeight={650}>{contact.name}</Typography><Typography variant="body2" color="text.secondary">{contact.email}</Typography></Box>
        <Chip size="small" label={roleLabels[contact.role] ?? contact.role} color={contact.only_on_violation ? "warning" : "default"} />
        {contact.region && <Chip size="small" variant="outlined" label={contact.region} />}
        {!contact.is_active && <Chip size="small" label="Inactivo" />}
        <IconButton size="small" onClick={() => start(contact)}><EditIcon fontSize="small" /></IconButton>
        <IconButton size="small" color="error" onClick={() => { if (confirm("¿Eliminar este contacto?")) remove.mutate(contact.id); }}><DeleteIcon fontSize="small" /></IconButton>
      </Stack>)}
    </Stack></Paper>)}
    {!contacts.isLoading && !contacts.data?.length && <Alert severity="info">Aún no hay contactos configurados. Los envíos permanecerán bloqueados hasta contar con al menos un destinatario TO.</Alert>}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm"><DialogTitle>{editing ? "Editar contacto" : "Agregar contacto"}</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
      <TextField label="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
      <TextField select label="Rol" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{contactRoles.map(role => <MenuItem key={role} value={role}>{roleLabels[role]}</MenuItem>)}</TextField>
      <TextField select label="Empresa" value={form.company_id} onChange={(e) => setForm({ ...form, company_id: e.target.value })}>{lookups.data?.companies.map(v => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
      <TextField select label="Sucursal (opcional)" value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}><MenuItem value="">Corporativo</MenuItem>{lookups.data?.branches.filter(v => !form.company_id || v.company_id === form.company_id).map(v => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
      <TextField select label="Departamento (opcional)" value={form.department_id} onChange={(e) => setForm({ ...form, department_id: e.target.value })}><MenuItem value="">Todos</MenuItem>{lookups.data?.departments.filter(v => !form.branch_id || v.department_branches?.some((link: any) => link.branch_id === form.branch_id)).map(v => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
      <TextField label="Región (opcional)" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
      <FormControlLabel control={<Switch checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />} label="Activo" />
      <FormControlLabel control={<Switch checked={form.receives_store_reports} onChange={(e) => setForm({ ...form, receives_store_reports: e.target.checked })} />} label="Recibe reportes de tienda" />
      <FormControlLabel control={<Switch checked={form.receives_administration_reports} onChange={(e) => setForm({ ...form, receives_administration_reports: e.target.checked })} />} label="Recibe reportes administrativos" />
      <FormControlLabel control={<Switch checked={form.only_on_violation} onChange={(e) => setForm({ ...form, only_on_violation: e.target.checked })} />} label="Recibe solo si hay infracción" />
      {save.error && <Alert severity="error">{save.error.message}</Alert>}
    </Stack></DialogContent><DialogActions><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="contained" disabled={save.isPending || !form.name || !form.email || !form.company_id} onClick={() => save.mutate()}>Guardar</Button></DialogActions></Dialog>
  </Stack>;
}

function RunsSection() {
  const queryClient = useQueryClient();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewDate, setPreviewDate] = useState(yesterdayGuatemala());
  const [previewConfig, setPreviewConfig] = useState("");
  const [previewResult, setPreviewResult] = useState<any>(null);
  const runs = useQuery({ queryKey: ["attendance_report_runs"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_runs").select("*, branches:branch_id(name), departments:department_id(name), email_outbox(id,status)").order("created_at", { ascending: false }).limit(200);
    if (error) throw error; return data ?? [];
  }});
  const configs = useQuery({ queryKey: ["attendance_report_preview_configs"], queryFn: async () => { const { data, error } = await supabase.from("attendance_report_configs").select("id,branch_id,department_id,branches:branch_id(name),departments:department_id(name)").order("created_at"); if (error) throw error; return data ?? []; }});
  const resend = useMutation({ mutationFn: async (row: any) => { const outbox = first(row.email_outbox); if (!outbox?.id) throw new Error("La ejecución no tiene correo generado"); const { data, error } = await supabase.functions.invoke("send-attendance-report-emails", { body: { outbox_id: outbox.id, force: true } }); if (error) throw error; if (data?.error) throw new Error(data.error); }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_runs"] }) });
  const preview = useMutation({ mutationFn: async () => { const config = configs.data?.find(v => v.id === previewConfig); if (!config) throw new Error("Selecciona una configuración"); const { data, error } = await supabase.functions.invoke("preview-attendance-report", { body: { report_date: previewDate, branch_id: config.branch_id, department_id: config.department_id || undefined } }); if (error) throw error; if (data?.error) throw new Error(data.error); return data; }, onSuccess: setPreviewResult });
  async function download(row: any) { if (!row.excel_path) return; const { data, error } = await supabase.storage.from("exports").createSignedUrl(row.excel_path, 300, { download: true }); if (error) throw error; if (data.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer"); }
  return <Stack spacing={2}>
    <Stack direction="row" justifyContent="space-between"><Typography variant="h6">Ejecuciones</Typography><Button startIcon={<PreviewIcon />} variant="outlined" onClick={() => setPreviewOpen(true)}>Vista previa</Button></Stack>
    {(runs.error || resend.error) && <Alert severity="error">{runs.error?.message ?? resend.error?.message}</Alert>}
    <TableContainer component={Paper} variant="outlined"><Table size="small"><TableHead><TableRow><TableCell>Fecha</TableCell><TableCell>Unidad</TableCell><TableCell>Estado</TableCell><TableCell>Resultado</TableCell><TableCell>Error</TableCell><TableCell align="right">Acciones</TableCell></TableRow></TableHead><TableBody>
      {(runs.data ?? []).map((row: any) => <TableRow key={row.id}><TableCell>{row.report_date}</TableCell><TableCell>{relationName(row.branches)}{relationName(row.departments) ? ` / ${relationName(row.departments)}` : ""}</TableCell><TableCell><Chip size="small" label={row.status} color={row.status === "sent" ? "success" : row.status === "failed" ? "error" : "default"} /></TableCell><TableCell>{row.ok_count} correctos · {row.warning_count} alertas · {row.violation_count} infracciones</TableCell><TableCell>{row.error_message ?? ""}</TableCell><TableCell align="right"><IconButton disabled={!row.excel_path} onClick={() => void download(row)}><DownloadIcon /></IconButton><IconButton disabled={!first(row.email_outbox)?.id || resend.isPending} onClick={() => resend.mutate(row)}><ReplayIcon /></IconButton></TableCell></TableRow>)}
    </TableBody></Table></TableContainer>
    <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} fullWidth maxWidth="md"><DialogTitle>Vista previa sin enviar</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}><TextField type="date" label="Fecha" value={previewDate} onChange={e => setPreviewDate(e.target.value)} InputLabelProps={{ shrink: true }} /><TextField select label="Configuración" value={previewConfig} onChange={e => setPreviewConfig(e.target.value)}>{configs.data?.map((config: any) => <MenuItem key={config.id} value={config.id}>{relationName(config.branches)}{relationName(config.departments) ? ` / ${relationName(config.departments)}` : ""}</MenuItem>)}</TextField>{preview.error && <Alert severity="error">{preview.error.message}</Alert>}{previewResult && <Alert severity={previewResult.ready_to_send ? "success" : "warning"}>Total: {previewResult.counts.total}. Correctos: {previewResult.counts.ok}. Alertas: {previewResult.counts.warnings}. Infracciones: {previewResult.counts.violations}. TO: {previewResult.recipients.to.join(", ") || "sin configurar"}. CC: {previewResult.recipients.cc.join(", ") || "ninguno"}.</Alert>}</Stack></DialogContent><DialogActions><Button onClick={() => setPreviewOpen(false)}>Cerrar</Button><Button variant="contained" disabled={preview.isPending || !previewConfig} onClick={() => preview.mutate()}>Generar vista previa</Button></DialogActions></Dialog>
  </Stack>;
}

function emptyContact() { return { company_id: "", branch_id: "", department_id: "", name: "", email: "", role: "custom_to", region: "", is_active: true, receives_store_reports: true, receives_administration_reports: false, only_on_violation: false }; }
function groupContacts(contacts: any[]) { const groups = new Map<string, any[]>(); for (const contact of contacts) { const key = relationName(contact.branches) || "Contactos corporativos"; groups.set(key, [...(groups.get(key) ?? []), contact]); } return groups; }
function relationName(value: any) { return first(value)?.name ?? ""; }
function first(value: any) { return Array.isArray(value) ? value[0] : value; }
function yesterdayGuatemala() { const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); const value = new Date(`${today}T12:00:00Z`); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10); }
