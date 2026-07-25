import { useMemo, useState } from "react";
import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  Divider, FormControlLabel, IconButton, ListItemText, MenuItem, Paper, Stack, Switch,
  Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField,
  Tooltip, Typography
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PreviewIcon from "@mui/icons-material/Preview";
import ReplayIcon from "@mui/icons-material/Replay";
import VisibilityIcon from "@mui/icons-material/Visibility";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CrudPage, type CrudField } from "../components/CrudPage";
import { supabase } from "../lib/supabase";

const scopes = ["global", "company", "region", "branches", "branch", "department"] as const;
const scopeLabels: Record<string, string> = {
  global: "Global", company: "Empresa completa", region: "Región",
  branches: "Varias sucursales", branch: "Una sucursal", department: "Departamento"
};
const contactRoles = ["custom_to", "custom_cc", "branch_manager", "regional_supervisor", "hr_assistant", "hr_manager", "commercial_manager", "department_head"];
const roleLabels: Record<string, string> = {
  custom_to: "Destinatario principal", custom_cc: "Copia personalizada", branch_manager: "Gerente de tienda",
  regional_supervisor: "Supervisor regional", hr_assistant: "Asistente RRHH", hr_manager: "Gerente RRHH",
  commercial_manager: "Gerente comercial", department_head: "Encargado de departamento"
};
const reportColumns = [
  ["name", "Nombre"], ["department", "Departamento"], ["schedule", "Grupo / horario"],
  ["actual_check_in", "Entrada real"], ["actual_check_out", "Salida real"],
  ["attendance_log", "Grabación de asistencia"], ["break_duration", "Duración de pausa"],
  ["break_records", "Registros de descansos"], ["status", "Estado / observación"],
  ["events", "Eventos / detalle"]
] as const;
const statusLabels: Record<string, string> = {
  pending: "Programado", syncing: "Esperando sync", generating: "Generando", queued: "En cola",
  sending: "Enviando", sent: "Enviado", partial: "Parcial", failed: "Fallido", skipped: "Omitido"
};

const ruleFields: CrudField[] = [
  { name: "company_id", label: "Empresa (opcional)", type: "relation", relation: { table: "companies", labelColumn: "name" } },
  { name: "code", label: "Código", required: true }, { name: "name", label: "Nombre", required: true },
  { name: "applicable_unit_type", label: "Tipo aplicable", type: "select", options: ["store", "administration", "department"], required: true },
  { name: "expected_check_in", label: "Entrada esperada", type: "time", required: true },
  { name: "expected_check_out", label: "Salida esperada", type: "time", required: true },
  { name: "max_break_minutes", label: "Pausa máxima (min)", type: "number", required: true },
  { name: "check_in_tolerance_minutes", label: "Tolerancia entrada (min)", type: "number", defaultValue: 0 },
  { name: "check_out_tolerance_minutes", label: "Tolerancia salida (min)", type: "number", defaultValue: 0 },
  { name: "warnings_trigger_hr_copy", label: "Alertas también copian a RRHH", type: "boolean", defaultValue: false },
  { name: "is_active", label: "Activa", type: "boolean", defaultValue: true }
];

export function AttendanceReportAutomationPage() {
  const [tab, setTab] = useState(0);
  return <Stack spacing={2}>
    <Box><Typography variant="h4">Reportes automáticos</Typography><Typography color="text.secondary">Configura alcances, destinatarios, plantilla y envíos diarios del día anterior.</Typography></Box>
    <Paper variant="outlined"><Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto">
      <Tab label="Contactos" /><Tab label="Configuraciones" /><Tab label="Reglas" /><Tab label="Ejecuciones" />
    </Tabs></Paper>
    {tab === 0 && <ContactsSection />}
    {tab === 1 && <ConfigsSection />}
    {tab === 2 && <CrudPage title="Reglas de asistencia" table="attendance_report_rules" orderBy="name" fields={ruleFields}
      columns={[{ name: "code", label: "Código" }, { name: "name", label: "Nombre" }, { name: "applicable_unit_type", label: "Tipo" }, { name: "expected_check_in", label: "Entrada" }, { name: "expected_check_out", label: "Salida" }, { name: "max_break_minutes", label: "Pausa máxima" }, { name: "is_active", label: "Activa", status: true }]} />}
    {tab === 3 && <RunsSection />}
  </Stack>;
}

function useReportLookups() {
  return useQuery({ queryKey: ["attendance-report-lookups-v2"], queryFn: async () => {
    const [companies, branches, departments, regions, rules] = await Promise.all([
      supabase.from("companies").select("id,name").order("name"),
      supabase.from("branches").select("id,name,company_id,region_id,unit_type").eq("is_active", true).order("name"),
      supabase.from("departments").select("id,name,company_id,department_branches(branch_id)").eq("is_active", true).order("name"),
      supabase.from("attendance_report_regions").select("id,name").eq("is_active", true).order("name"),
      supabase.from("attendance_report_rules").select("id,name,company_id,applicable_unit_type").eq("is_active", true).order("name")
    ]);
    for (const result of [companies, branches, departments, regions, rules]) if (result.error) throw result.error;
    return { companies: companies.data ?? [], branches: branches.data ?? [], departments: departments.data ?? [], regions: regions.data ?? [], rules: rules.data ?? [] };
  }});
}

function ContactsSection() {
  const queryClient = useQueryClient();
  const lookups = useReportLookups();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(emptyContact());
  const contacts = useQuery({ queryKey: ["attendance_report_contacts-v2"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_contacts").select(`
      *,companies:company_id(name),branches:branch_id(name),departments:department_id(name),
      attendance_report_regions:region_id(name),attendance_report_contact_branches(branch_id)
    `).order("name");
    if (error) throw error;
    return data ?? [];
  }});
  const save = useMutation({ mutationFn: async () => {
    validateScopeForm(form);
    const regionName = lookups.data?.regions.find((item: any) => item.id === form.region_id)?.name ?? null;
    const branchId = form.scope_type === "branch" ? form.branch_ids[0] : null;
    const payload = {
      company_id: form.scope_type === "global" ? null : form.company_id,
      branch_id: branchId, department_id: form.scope_type === "department" ? form.department_id : null,
      region_id: form.scope_type === "region" ? form.region_id : null, region: form.scope_type === "region" ? regionName : null,
      scope_type: form.scope_type, name: form.name.trim(), email: form.email.trim().toLowerCase(), role: form.role,
      is_active: form.is_active, receives_store_reports: form.receives_store_reports,
      receives_administration_reports: form.receives_administration_reports, only_on_violation: form.only_on_violation
    };
    let saved: any;
    if (editing) {
      const result = await supabase.from("attendance_report_contacts").update(payload).eq("id", editing.id).select("id").single();
      if (result.error) throw result.error; saved = result.data;
    } else {
      const result = await supabase.from("attendance_report_contacts").insert(payload).select("id").single();
      if (result.error) throw result.error; saved = result.data;
    }
    const selected = form.scope_type === "branches" || form.scope_type === "department" ? form.branch_ids : branchId ? [branchId] : [];
    const cleared = await supabase.from("attendance_report_contact_branches").delete().eq("contact_id", saved.id);
    if (cleared.error) throw cleared.error;
    if (selected.length) {
      const linked = await supabase.from("attendance_report_contact_branches").insert(selected.map((branchIdValue: string) => ({ contact_id: saved.id, branch_id: branchIdValue })));
      if (linked.error) throw linked.error;
    }
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["attendance_report_contacts-v2"] }); setOpen(false); }});
  const remove = useMutation({ mutationFn: async (id: string) => {
    const { error } = await supabase.from("attendance_report_contacts").delete().eq("id", id); if (error) throw error;
  }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_contacts-v2"] }) });
  function start(contact?: any) {
    setEditing(contact ?? null);
    setForm(contact ? {
      company_id: contact.company_id ?? "", scope_type: contact.scope_type ?? "company",
      branch_ids: contact.attendance_report_contact_branches?.map((link: any) => link.branch_id) ?? (contact.branch_id ? [contact.branch_id] : []),
      department_id: contact.department_id ?? "", region_id: contact.region_id ?? "", name: contact.name,
      email: contact.email, role: contact.role, is_active: contact.is_active,
      receives_store_reports: contact.receives_store_reports, receives_administration_reports: contact.receives_administration_reports,
      only_on_violation: contact.only_on_violation
    } : emptyContact());
    setOpen(true);
  }
  return <Stack spacing={2}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography variant="h6">Contactos y cobertura</Typography><Typography variant="body2" color="text.secondary">Cada contacto recibe únicamente salidas cubiertas completamente por su alcance.</Typography></Box><Button variant="contained" startIcon={<AddIcon />} onClick={() => start()}>Agregar contacto</Button></Stack>
    {(contacts.error || save.error || remove.error) && <Alert severity="error">{errorMessage(contacts.error ?? save.error ?? remove.error)}</Alert>}
    {(contacts.data ?? []).map((contact: any) => <Paper key={contact.id} variant="outlined" sx={{ p: 1.5 }}><Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ md: "center" }}>
      <Box sx={{ flex: 1 }}><Typography fontWeight={650}>{contact.name}</Typography><Typography variant="body2" color="text.secondary">{contact.email}</Typography></Box>
      <Chip size="small" label={roleLabels[contact.role] ?? contact.role} />
      <Chip size="small" color="primary" variant="outlined" label={scopeDescription(contact, lookups.data)} />
      {!contact.is_active && <Chip size="small" label="Inactivo" />}
      <IconButton size="small" onClick={() => start(contact)}><EditIcon fontSize="small" /></IconButton>
      <IconButton size="small" color="error" onClick={() => { if (confirm("¿Eliminar este contacto?")) remove.mutate(contact.id); }}><DeleteIcon fontSize="small" /></IconButton>
    </Stack></Paper>)}
    {!contacts.isLoading && !contacts.data?.length && <Alert severity="info">No hay contactos configurados; las ejecuciones sin TO se marcarán como omitidas.</Alert>}
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md"><DialogTitle>{editing ? "Editar contacto" : "Agregar contacto"}</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
      <TextField select label="Alcance" value={form.scope_type} onChange={e => setForm({ ...form, scope_type: e.target.value, branch_ids: [], department_id: "", region_id: "", company_id: e.target.value === "global" ? "" : form.company_id })}>{scopes.map(scope => <MenuItem key={scope} value={scope}>{scopeLabels[scope]}</MenuItem>)}</TextField>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}><TextField fullWidth label="Nombre" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /><TextField fullWidth label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></Stack>
      <TextField select label="Rol" value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>{contactRoles.map(role => <MenuItem key={role} value={role}>{roleLabels[role]}</MenuItem>)}</TextField>
      <ScopeFields form={form} setForm={setForm} lookups={lookups.data} />
      <Divider />
      <FormControlLabel control={<Switch checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />} label="Activo" />
      <FormControlLabel control={<Switch checked={form.receives_store_reports} onChange={e => setForm({ ...form, receives_store_reports: e.target.checked })} />} label="Recibe reportes de tienda" />
      <FormControlLabel control={<Switch checked={form.receives_administration_reports} onChange={e => setForm({ ...form, receives_administration_reports: e.target.checked })} />} label="Recibe reportes administrativos" />
      <FormControlLabel control={<Switch checked={form.only_on_violation} onChange={e => setForm({ ...form, only_on_violation: e.target.checked })} />} label="Solo si hay infracción" />
      {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
    </Stack></DialogContent><DialogActions><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="contained" disabled={save.isPending || !form.name || !form.email} onClick={() => save.mutate()}>Guardar</Button></DialogActions></Dialog>
  </Stack>;
}

function ConfigsSection() {
  const queryClient = useQueryClient();
  const lookups = useReportLookups();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [form, setForm] = useState(emptyConfig());
  const [previewConfig, setPreviewConfig] = useState<any>(null);
  const configs = useQuery({ queryKey: ["attendance_report_configs-v2"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_configs").select(`
      *,companies:company_id(name),branches:branch_id(name),departments:department_id(name),
      attendance_report_regions:region_id(name),attendance_report_rules:rule_id(name),
      attendance_report_config_branches(branch_id)
    `).order("send_time");
    if (error) throw error; return data ?? [];
  }});
  const contacts = useQuery({ queryKey: ["attendance-report-recipient-candidates"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_contacts").select("*,attendance_report_contact_branches(branch_id)").eq("is_active", true);
    if (error) throw error; return data ?? [];
  }});
  const potentialRecipients = useMemo(() => calculatePotentialRecipients(form, contacts.data ?? [], lookups.data), [form, contacts.data, lookups.data]);
  const save = useMutation({ mutationFn: async () => {
    validateScopeForm(form);
    if (!form.rule_id) throw new Error("Selecciona una regla de asistencia");
    const regionName = lookups.data?.regions.find((item: any) => item.id === form.region_id)?.name ?? null;
    const branchId = form.scope_type === "branch" ? form.branch_ids[0] : null;
    const resolvedBranches = branchesForForm(form, lookups.data);
    if (!resolvedBranches.length) throw new Error("El alcance no contiene sucursales activas. Asigna región/sucursales antes de guardar.");
    const unitTypes = [...new Set(resolvedBranches.map((branch: any) => branch.unit_type))];
    const payload = {
      company_id: form.scope_type === "global" ? null : form.company_id, scope_type: form.scope_type,
      branch_id: branchId, department_id: form.scope_type === "department" ? form.department_id : null,
      region_id: form.scope_type === "region" ? form.region_id : null, region: form.scope_type === "region" ? regionName : null,
      unit_type: form.scope_type === "department" ? "department" : unitTypes.length === 1 ? unitTypes[0] : "mixed",
      output_mode: form.output_mode, send_time: form.send_time, rule_id: form.rule_id,
      include_excel: form.include_excel, include_html: form.include_html,
      copy_hr_manager_only_on_violation: form.copy_hr_manager_only_on_violation,
      warnings_trigger_hr_copy: form.warnings_trigger_hr_copy, copy_commercial_manager: form.copy_commercial_manager,
      html_columns: form.html_columns, column_order: reportColumns.map(([key]) => key), is_active: form.is_active
    };
    let saved: any;
    if (editing) {
      const result = await supabase.from("attendance_report_configs").update(payload).eq("id", editing.id).select("id").single();
      if (result.error) throw result.error; saved = result.data;
    } else {
      const result = await supabase.from("attendance_report_configs").insert(payload).select("id").single();
      if (result.error) throw result.error; saved = result.data;
    }
    const selected = form.scope_type === "branches" || form.scope_type === "department" ? form.branch_ids : branchId ? [branchId] : [];
    const cleared = await supabase.from("attendance_report_config_branches").delete().eq("config_id", saved.id);
    if (cleared.error) throw cleared.error;
    if (selected.length) {
      const linked = await supabase.from("attendance_report_config_branches").insert(selected.map((branchIdValue: string) => ({ config_id: saved.id, branch_id: branchIdValue })));
      if (linked.error) throw linked.error;
    }
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["attendance_report_configs-v2"] }); setOpen(false); }});
  const remove = useMutation({ mutationFn: async (id: string) => {
    const { error } = await supabase.from("attendance_report_configs").delete().eq("id", id); if (error) throw error;
  }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_configs-v2"] }) });
  function start(config?: any) {
    setEditing(config ?? null);
    setForm(config ? {
      company_id: config.company_id ?? "", scope_type: config.scope_type ?? "branch",
      branch_ids: config.attendance_report_config_branches?.map((link: any) => link.branch_id) ?? (config.branch_id ? [config.branch_id] : []),
      department_id: config.department_id ?? "", region_id: config.region_id ?? "", output_mode: config.output_mode ?? "consolidated",
      send_time: String(config.send_time ?? "06:00").slice(0, 5), rule_id: config.rule_id,
      include_excel: config.include_excel, include_html: config.include_html,
      copy_hr_manager_only_on_violation: config.copy_hr_manager_only_on_violation,
      warnings_trigger_hr_copy: config.warnings_trigger_hr_copy, copy_commercial_manager: config.copy_commercial_manager,
      html_columns: { ...defaultColumns(), ...(config.html_columns ?? {}) }, is_active: config.is_active
    } : emptyConfig());
    setOpen(true);
  }
  return <Stack spacing={2}>
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Box><Typography variant="h6">Configuraciones de reportes</Typography><Typography variant="body2" color="text.secondary">El Excel conserva todas las columnas; la selección aplica al HTML y preview.</Typography></Box><Button variant="contained" startIcon={<AddIcon />} onClick={() => start()}>Nueva configuración</Button></Stack>
    {(configs.error || save.error || remove.error) && <Alert severity="error">{errorMessage(configs.error ?? save.error ?? remove.error)}</Alert>}
    <TableContainer component={Paper} variant="outlined"><Table size="small"><TableHead><TableRow><TableCell>Alcance</TableCell><TableCell>Salida</TableCell><TableCell>Hora</TableCell><TableCell>Regla</TableCell><TableCell>Estado</TableCell><TableCell align="right">Acciones</TableCell></TableRow></TableHead><TableBody>
      {(configs.data ?? []).map((config: any) => <TableRow key={config.id}><TableCell>{scopeDescription(config, lookups.data)}</TableCell><TableCell>{config.output_mode === "separate_by_branch" ? "Separado por sucursal" : "Consolidado"}</TableCell><TableCell>{String(config.send_time).slice(0, 5)}</TableCell><TableCell>{relationName(config.attendance_report_rules)}</TableCell><TableCell><Chip size="small" color={config.is_active ? "success" : "default"} label={config.is_active ? "Activo" : "Inactivo"} /></TableCell><TableCell align="right">
        <Tooltip title="Previsualizar plantilla"><IconButton size="small" onClick={() => setPreviewConfig(config)}><PreviewIcon fontSize="small" /></IconButton></Tooltip>
        <IconButton size="small" onClick={() => start(config)}><EditIcon fontSize="small" /></IconButton>
        <IconButton size="small" color="error" onClick={() => { if (confirm("¿Eliminar esta configuración? Las ejecuciones históricas protegidas impedirán borrados inseguros.")) remove.mutate(config.id); }}><DeleteIcon fontSize="small" /></IconButton>
      </TableCell></TableRow>)}
    </TableBody></Table></TableContainer>
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md"><DialogTitle>{editing ? "Editar configuración" : "Nueva configuración"}</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
      <TextField select label="Alcance del reporte" value={form.scope_type} onChange={e => setForm({ ...form, scope_type: e.target.value, branch_ids: [], department_id: "", region_id: "", company_id: e.target.value === "global" ? "" : form.company_id })}>{scopes.map(scope => <MenuItem key={scope} value={scope}>{scopeLabels[scope]}</MenuItem>)}</TextField>
      <ScopeFields form={form} setForm={setForm} lookups={lookups.data} />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
        <TextField fullWidth select label="Tipo de salida" value={form.output_mode} onChange={e => setForm({ ...form, output_mode: e.target.value })}><MenuItem value="consolidated">Consolidado</MenuItem><MenuItem value="separate_by_branch">Separado por sucursal</MenuItem></TextField>
        <TextField fullWidth type="time" label="Hora automática (Guatemala)" value={form.send_time} onChange={e => setForm({ ...form, send_time: e.target.value })} InputLabelProps={{ shrink: true }} />
      </Stack>
      <TextField select label="Regla de asistencia" value={form.rule_id} onChange={e => setForm({ ...form, rule_id: e.target.value })}>{lookups.data?.rules.filter((rule: any) => !rule.company_id || !form.company_id || rule.company_id === form.company_id).map((rule: any) => <MenuItem key={rule.id} value={rule.id}>{rule.name}</MenuItem>)}</TextField>
      <Alert severity={potentialRecipients.length ? "info" : "warning"}>Destinatarios potenciales según alcance: {potentialRecipients.join(", ") || "ninguno"}. La regla TO/CC final también considera rol e infracciones.</Alert>
      <Divider><Chip label="Columnas del HTML" size="small" /></Divider>
      <Stack direction={{ xs: "column", sm: "row" }} flexWrap="wrap">{reportColumns.map(([key, label]) => <FormControlLabel key={key} sx={{ minWidth: 230 }} control={<Checkbox checked={form.html_columns[key] !== false} onChange={e => setForm({ ...form, html_columns: { ...form.html_columns, [key]: e.target.checked } })} />} label={label} />)}</Stack>
      <Divider />
      <Stack direction={{ xs: "column", sm: "row" }} flexWrap="wrap">
        <FormControlLabel control={<Switch checked={form.include_excel} onChange={e => setForm({ ...form, include_excel: e.target.checked })} />} label="Adjuntar Excel completo" />
        <FormControlLabel control={<Switch checked={form.include_html} onChange={e => setForm({ ...form, include_html: e.target.checked })} />} label="Incluir HTML" />
        <FormControlLabel control={<Switch checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />} label="Envío automático activo" />
        <FormControlLabel control={<Switch checked={form.copy_hr_manager_only_on_violation} onChange={e => setForm({ ...form, copy_hr_manager_only_on_violation: e.target.checked })} />} label="RRHH gerente solo con infracción" />
        <FormControlLabel control={<Switch checked={form.warnings_trigger_hr_copy} onChange={e => setForm({ ...form, warnings_trigger_hr_copy: e.target.checked })} />} label="Alertas copian a RRHH" />
        <FormControlLabel control={<Switch checked={form.copy_commercial_manager} onChange={e => setForm({ ...form, copy_commercial_manager: e.target.checked })} />} label="Copiar gerente comercial" />
      </Stack>
      {save.error && <Alert severity="error">{errorMessage(save.error)}</Alert>}
    </Stack></DialogContent><DialogActions><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>Guardar</Button></DialogActions></Dialog>
    {previewConfig && <PreviewDialog config={previewConfig} onClose={() => setPreviewConfig(null)} />}
  </Stack>;
}

function RunsSection() {
  const queryClient = useQueryClient();
  const lookups = useReportLookups();
  const [previewConfig, setPreviewConfig] = useState<any>(null);
  const [html, setHtml] = useState<string | null>(null);
  const configs = useQuery({ queryKey: ["attendance-report-run-configs"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_configs").select("id,company_id,region_id,scope_type,output_mode,branch_id,department_id,attendance_report_config_branches(branch_id),branches:branch_id(name),departments:department_id(name)").order("created_at");
    if (error) throw error; return data ?? [];
  }});
  const runs = useQuery({ queryKey: ["attendance_report_runs-v2"], queryFn: async () => {
    const { data, error } = await supabase.from("attendance_report_runs").select("*,branches:branch_id(name),departments:department_id(name),email_outbox(id,status,html_body,last_error,email_delivery_logs(attempt,status,error_message,created_at))").order("created_at", { ascending: false }).limit(200);
    if (error) throw error; return data ?? [];
  }});
  const resend = useMutation({ mutationFn: async (row: any) => {
    const outbox = first(row.email_outbox); if (!outbox?.id) throw new Error("La ejecución no tiene correo generado");
    if (!confirm("Esto realizará un envío real por Resend. ¿Continuar?")) return;
    const { data, error } = await supabase.functions.invoke("send-attendance-report-emails", { body: { outbox_id: outbox.id, force: true } });
    if (error) throw error; if (data?.error) throw new Error(data.error);
  }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_runs-v2"] }) });
  const retryRun = useMutation({ mutationFn: async (row: any) => {
    if (!confirm("Esto regenerará la ejecución y puede crear un correo real en outbox. ¿Continuar?")) return;
    const { data, error } = await supabase.functions.invoke("generate-attendance-report", {
      body: { report_date: row.report_date, run_id: row.id, dry_run: false }
    });
    if (error) throw error; if (data?.error) throw new Error(data.error);
  }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_runs-v2"] }) });
  const manual = useMutation({ mutationFn: async (config: any) => {
    if (!confirm("La ejecución manual generará outbox real y el worker podrá enviarlo. ¿Continuar?")) return;
    const scopedForm = {
      ...config,
      branch_ids: config.attendance_report_config_branches?.map((link: any) => link.branch_id) ?? (config.branch_id ? [config.branch_id] : [])
    };
    const outputKeys = config.output_mode === "separate_by_branch"
      ? branchesForForm(scopedForm, lookups.data).map((branch: any) => branch.id)
      : ["consolidated"];
    if (!outputKeys.length) throw new Error("La configuración no resuelve sucursales activas");
    for (const outputKey of outputKeys) {
      const { data, error } = await supabase.functions.invoke("generate-attendance-report", { body: { report_date: yesterdayGuatemala(), config_id: config.id, output_key: outputKey, dry_run: false } });
      if (error) throw error; if (data?.error) throw new Error(data.error);
    }
  }, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["attendance_report_runs-v2"] }) });
  async function download(row: any) {
    if (!row.excel_path) return;
    const { data, error } = await supabase.storage.from("exports").createSignedUrl(row.excel_path, 300, { download: true });
    if (error) throw error; if (data.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }
  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" spacing={1}><Box><Typography variant="h6">Ejecuciones reales</Typography><Typography variant="body2" color="text.secondary">El preview nunca envía. Reintento y ejecución manual requieren confirmación porque sí pueden enviar.</Typography></Box><Stack direction="row" spacing={1}>
      <TextField select size="small" label="Previsualizar configuración" value="" sx={{ minWidth: 250 }} onChange={e => setPreviewConfig(configs.data?.find((item: any) => item.id === e.target.value))}><MenuItem value="">Seleccionar</MenuItem>{configs.data?.map((config: any) => <MenuItem key={config.id} value={config.id}>{configLabel(config)}</MenuItem>)}</TextField>
      <TextField select size="small" label="Ejecutar manualmente" value="" sx={{ minWidth: 230 }} onChange={e => { const config = configs.data?.find((item: any) => item.id === e.target.value); if (config) manual.mutate(config); }}><MenuItem value="">Seleccionar</MenuItem>{configs.data?.map((config: any) => <MenuItem key={config.id} value={config.id}>{configLabel(config)}</MenuItem>)}</TextField>
    </Stack></Stack>
    {(runs.error || resend.error || retryRun.error || manual.error) && <Alert severity="error">{errorMessage(runs.error ?? resend.error ?? retryRun.error ?? manual.error)}</Alert>}
    <TableContainer component={Paper} variant="outlined"><Table size="small"><TableHead><TableRow><TableCell>Fecha</TableCell><TableCell>Salida</TableCell><TableCell>Estado</TableCell><TableCell>Resultado</TableCell><TableCell>Detalle/error</TableCell><TableCell align="right">Acciones</TableCell></TableRow></TableHead><TableBody>
      {(runs.data ?? []).map((row: any) => {
        const outbox = first(row.email_outbox);
        return <TableRow key={row.id}><TableCell>{row.report_date}</TableCell><TableCell>{runLabel(row)}</TableCell><TableCell><Chip size="small" label={statusLabels[row.status] ?? row.status} color={row.status === "sent" ? "success" : row.status === "failed" ? "error" : row.status === "partial" ? "warning" : "default"} /></TableCell><TableCell>{row.ok_count} correctos · {row.warning_count} alertas · {row.violation_count} infracciones</TableCell><TableCell>{row.error_message ?? row.skipped_reason ?? row.status_detail ?? ""}</TableCell><TableCell align="right">
          <Tooltip title="Descargar Excel"><span><IconButton disabled={!row.excel_path} onClick={() => void download(row)}><DownloadIcon /></IconButton></span></Tooltip>
          <Tooltip title="Ver HTML enviado"><span><IconButton disabled={!outbox?.html_body} onClick={() => setHtml(outbox?.html_body ?? null)}><VisibilityIcon /></IconButton></span></Tooltip>
          <Tooltip title="Reintentar generación"><span><IconButton disabled={!["failed", "skipped"].includes(row.status) || retryRun.isPending} onClick={() => retryRun.mutate(row)}><PlayArrowIcon /></IconButton></span></Tooltip>
          <Tooltip title="Reintentar envío real"><span><IconButton disabled={!outbox?.id || resend.isPending} onClick={() => resend.mutate(row)}><ReplayIcon /></IconButton></span></Tooltip>
        </TableCell></TableRow>;
      })}
    </TableBody></Table></TableContainer>
    {previewConfig && <PreviewDialog config={previewConfig} onClose={() => setPreviewConfig(null)} />}
    <HtmlDialog html={html} title="HTML generado/enviado" onClose={() => setHtml(null)} />
  </Stack>;
}

function PreviewDialog({ config, onClose }: { config: any; onClose: () => void }) {
  const [date, setDate] = useState(yesterdayGuatemala());
  const [width, setWidth] = useState("100%");
  const preview = useMutation({ mutationFn: async () => {
    const outputKey = config.output_mode === "separate_by_branch"
      ? config.attendance_report_config_branches?.[0]?.branch_id ?? config.branch_id
      : "consolidated";
    const { data, error } = await supabase.functions.invoke("preview-attendance-report", {
      body: { report_date: date, config_id: config.id, output_key: outputKey, html_columns: config.html_columns, column_order: config.column_order }
    });
    if (error) throw error; if (data?.error) throw new Error(data.error); return data;
  }});
  return <Dialog open onClose={onClose} fullWidth maxWidth="xl"><DialogTitle>Previsualizar plantilla — sin enviar correo</DialogTitle><DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField type="date" label="Fecha real" value={date} onChange={e => setDate(e.target.value)} InputLabelProps={{ shrink: true }} /><Button variant="contained" startIcon={<PreviewIcon />} disabled={preview.isPending} onClick={() => preview.mutate()}>Generar preview</Button>{preview.data && <><Button onClick={() => setWidth("100%")}>Desktop</Button><Button onClick={() => setWidth("768px")}>Tablet</Button><Button onClick={() => setWidth("390px")}>Móvil</Button></>}</Stack>
    {preview.error && <Alert severity="error">{errorMessage(preview.error)}</Alert>}
    {preview.data && <Alert severity={preview.data.ready_to_send ? "success" : "warning"}>Datos reales: {preview.data.counts.total} colaboradores. TO: {preview.data.recipients.to.join(", ") || "sin destinatario"} · CC: {preview.data.recipients.cc.join(", ") || "ninguno"}.</Alert>}
    {preview.data?.html && <Box sx={{ mx: "auto", width, maxWidth: "100%", transition: "width .2s" }}><iframe title="Vista previa del reporte" sandbox="" srcDoc={preview.data.html} style={{ width: "100%", minHeight: 650, border: "1px solid #ddd", borderRadius: 8 }} /></Box>}
  </Stack></DialogContent><DialogActions><Button onClick={onClose}>Cerrar</Button></DialogActions></Dialog>;
}

function HtmlDialog({ html, title, onClose }: { html: string | null; title: string; onClose: () => void }) {
  return <Dialog open={Boolean(html)} onClose={onClose} fullWidth maxWidth="xl"><DialogTitle>{title}</DialogTitle><DialogContent>{html && <iframe title={title} sandbox="" srcDoc={html} style={{ width: "100%", minHeight: 700, border: 0 }} />}</DialogContent><DialogActions><Button onClick={onClose}>Cerrar</Button></DialogActions></Dialog>;
}

function ScopeFields({ form, setForm, lookups }: { form: any; setForm: (value: any) => void; lookups: any }) {
  if (form.scope_type === "global") return <Alert severity="info">Aplica a todas las empresas autorizadas. No requiere sucursal ni departamento.</Alert>;
  const companyBranches = (lookups?.branches ?? []).filter((branch: any) => !form.company_id || branch.company_id === form.company_id);
  return <>
    <TextField select label="Empresa" value={form.company_id} onChange={e => setForm({ ...form, company_id: e.target.value, branch_ids: [], department_id: "" })} required>{lookups?.companies.map((company: any) => <MenuItem key={company.id} value={company.id}>{company.name}</MenuItem>)}</TextField>
    {form.scope_type === "region" && <TextField select label="Región" value={form.region_id} onChange={e => setForm({ ...form, region_id: e.target.value })} required>{lookups?.regions.map((region: any) => <MenuItem key={region.id} value={region.id}>{region.name}</MenuItem>)}</TextField>}
    {(form.scope_type === "branch" || form.scope_type === "branches" || form.scope_type === "department") && <TextField select label={form.scope_type === "branch" ? "Sucursal" : form.scope_type === "department" ? "Sucursales (opcional)" : "Sucursales"} value={form.scope_type === "branch" ? (form.branch_ids[0] ?? "") : form.branch_ids} onChange={e => setForm({ ...form, branch_ids: Array.isArray(e.target.value) ? e.target.value : e.target.value ? [e.target.value] : [] })} SelectProps={form.scope_type === "branch" ? undefined : { multiple: true, renderValue: selected => (selected as string[]).map(id => companyBranches.find((branch: any) => branch.id === id)?.name).filter(Boolean).join(", ") }}>
      {form.scope_type === "department" && <MenuItem value=""><em>Todas las aplicables al departamento</em></MenuItem>}
      {companyBranches.map((branch: any) => <MenuItem key={branch.id} value={branch.id}>{form.scope_type !== "branch" && <Checkbox checked={form.branch_ids.includes(branch.id)} />}<ListItemText primary={branch.name} /></MenuItem>)}
    </TextField>}
    {form.scope_type === "department" && <TextField select label="Departamento" value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })} required>{lookups?.departments.filter((department: any) => !form.company_id || department.company_id === form.company_id).map((department: any) => <MenuItem key={department.id} value={department.id}>{department.name}</MenuItem>)}</TextField>}
  </>;
}

function validateScopeForm(form: any) {
  if (form.scope_type !== "global" && !form.company_id) throw new Error("Selecciona una empresa");
  if (form.scope_type === "region" && !form.region_id) throw new Error("Selecciona una región");
  if ((form.scope_type === "branch" || form.scope_type === "branches") && !form.branch_ids.length) throw new Error("Selecciona al menos una sucursal");
  if (form.scope_type === "branch" && form.branch_ids.length !== 1) throw new Error("Selecciona exactamente una sucursal");
  if (form.scope_type === "department" && !form.department_id) throw new Error("Selecciona un departamento");
}

function branchesForForm(form: any, lookups: any) {
  const branches = lookups?.branches ?? [];
  if (form.scope_type === "global") return branches;
  if (form.scope_type === "company") return branches.filter((branch: any) => branch.company_id === form.company_id);
  if (form.scope_type === "region") return branches.filter((branch: any) => branch.company_id === form.company_id && branch.region_id === form.region_id);
  if (form.scope_type === "branch" || form.scope_type === "branches") return branches.filter((branch: any) => form.branch_ids.includes(branch.id));
  if (form.scope_type === "department") {
    if (form.branch_ids.length) return branches.filter((branch: any) => form.branch_ids.includes(branch.id));
    const department = lookups?.departments.find((item: any) => item.id === form.department_id);
    const ids = department?.department_branches?.map((link: any) => link.branch_id) ?? [];
    return branches.filter((branch: any) => ids.includes(branch.id));
  }
  return [];
}

function calculatePotentialRecipients(form: any, contacts: any[], lookups: any) {
  const targetBranches = branchesForForm(form, lookups).map((branch: any) => branch.id);
  const targetRegions = [...new Set(branchesForForm(form, lookups).map((branch: any) => branch.region_id).filter(Boolean))];
  return [...new Set(contacts.filter(contact => {
    if (contact.scope_type === "global") return true;
    if (contact.company_id !== form.company_id) return false;
    if (contact.scope_type === "company") return true;
    if (contact.scope_type === "region") return targetRegions.length === 1 && targetRegions[0] === contact.region_id;
    const contactBranches = contact.attendance_report_contact_branches?.map((link: any) => link.branch_id) ?? (contact.branch_id ? [contact.branch_id] : []);
    if (contact.scope_type === "branch" || contact.scope_type === "branches") return targetBranches.length > 0 && targetBranches.every((id: string) => contactBranches.includes(id));
    if (contact.scope_type === "department") return contact.department_id === form.department_id && (!contactBranches.length || targetBranches.every((id: string) => contactBranches.includes(id)));
    return false;
  }).map(contact => `${contact.name} <${contact.email}>`))];
}

function scopeDescription(row: any, lookups: any) {
  const scope = row.scope_type ?? (row.department_id ? "department" : row.branch_id ? "branch" : row.region_id || row.region ? "region" : "company");
  if (scope === "global") return "Global";
  if (scope === "company") return `Empresa · ${relationName(row.companies) || lookupName(lookups?.companies, row.company_id)}`;
  if (scope === "region") return `Región · ${relationName(row.attendance_report_regions) || lookupName(lookups?.regions, row.region_id) || row.region}`;
  if (scope === "department") return `Departamento · ${relationName(row.departments) || lookupName(lookups?.departments, row.department_id)}`;
  const links = row.attendance_report_contact_branches ?? row.attendance_report_config_branches ?? [];
  const names = links.map((link: any) => lookupName(lookups?.branches, link.branch_id)).filter(Boolean);
  if (scope === "branch") return `Sucursal · ${relationName(row.branches) || names[0] || "sin asignar"}`;
  return `Sucursales · ${names.join(", ") || `${links.length} seleccionadas`}`;
}

function emptyContact() {
  return { company_id: "", scope_type: "company", branch_ids: [] as string[], department_id: "", region_id: "", name: "", email: "", role: "custom_to", is_active: true, receives_store_reports: true, receives_administration_reports: true, only_on_violation: false };
}
function defaultColumns() { return Object.fromEntries(reportColumns.map(([key]) => [key, true])) as Record<string, boolean>; }
function emptyConfig() {
  return { company_id: "", scope_type: "branch", branch_ids: [] as string[], department_id: "", region_id: "", output_mode: "consolidated", send_time: "06:00", rule_id: "", include_excel: true, include_html: true, copy_hr_manager_only_on_violation: true, warnings_trigger_hr_copy: false, copy_commercial_manager: true, html_columns: defaultColumns(), is_active: false };
}
function relationName(value: any) { return first(value)?.name ?? ""; }
function first(value: any) { return Array.isArray(value) ? value[0] : value; }
function lookupName(items: any[] | undefined, id: string) { return items?.find(item => item.id === id)?.name ?? ""; }
function configLabel(config: any) { return relationName(config.branches) || relationName(config.departments) || scopeLabels[config.scope_type] || "Configuración"; }
function runLabel(row: any) { return relationName(row.branches) || row.scope_snapshot?.branch_names?.join(", ") || row.output_key || "Consolidado"; }
function errorMessage(error: any) { return error instanceof Error ? error.message : String(error ?? "Error"); }
function yesterdayGuatemala() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const value = new Date(`${today}T12:00:00Z`); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10);
}
