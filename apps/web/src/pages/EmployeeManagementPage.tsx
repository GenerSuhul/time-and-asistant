import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  FormControl,
  FormControlLabel,
  Grid2,
  IconButton,
  InputAdornment,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
  useMediaQuery
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
import { supabase } from "../lib/supabase";

type AnyRow = Record<string, any>;

type EmployeeForm = {
  id: string;
  company_id: string;
  branch_id: string;
  department_id: string;
  attendance_group_id: string;
  employee_code: string;
  external_employee_id: string;
  full_name: string;
  email: string;
  phone: string;
  document_number: string;
  status: "active" | "inactive" | "suspended";
  card_number: string;
  pin_enabled: boolean;
  hired_at: string;
  terminated_at: string;
  access_valid_from: string;
  access_valid_to: string;
  target_device_ids: string[];
};

const today = new Date().toISOString().slice(0, 10);
const defaultValidTo = "2036-12-31";

const emptyForm: EmployeeForm = {
  id: "",
  company_id: "",
  branch_id: "",
  department_id: "",
  attendance_group_id: "",
  employee_code: "",
  external_employee_id: "",
  full_name: "",
  email: "",
  phone: "",
  document_number: "",
  status: "active",
  card_number: "",
  pin_enabled: false,
  hired_at: today,
  terminated_at: "",
  access_valid_from: today,
  access_valid_to: defaultValidTo,
  target_device_ids: []
};

function relationLabel(value: AnyRow | AnyRow[] | null | undefined, key = "name") {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.[key] ?? "";
}

function freshForm(companyId = ""): EmployeeForm {
  return { ...emptyForm, company_id: companyId, target_device_ids: [] };
}

function formFromEmployee(row: AnyRow, assignments: AnyRow[]): EmployeeForm {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    ...emptyForm,
    id: row.id,
    company_id: row.company_id ?? "",
    branch_id: row.branch_id ?? "",
    department_id: row.department_id ?? "",
    attendance_group_id: row.attendance_group_id ?? "",
    employee_code: row.employee_code ?? "",
    external_employee_id: row.external_employee_id ?? "",
    full_name: row.full_name ?? "",
    email: row.email ?? "",
    phone: row.phone ?? "",
    document_number: row.document_number ?? "",
    status: row.status ?? "active",
    card_number: row.card_number ?? "",
    pin_enabled: Boolean(row.pin_enabled),
    hired_at: row.hired_at ?? today,
    terminated_at: row.terminated_at ?? "",
    access_valid_from: metadata.access_valid_from ?? row.hired_at ?? today,
    access_valid_to: metadata.access_valid_to ?? defaultValidTo,
    target_device_ids: assignments.map((assignment) => assignment.device_id).filter(Boolean)
  };
}

async function invokeFunction(name: string, body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  return data;
}

export function EmployeeManagementPage() {
  const queryClient = useQueryClient();
  const theme = useTheme();
  const fullScreenEditor = useMediaQuery(theme.breakpoints.down("sm"));
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [open, setOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("basic");
  const [editing, setEditing] = useState<AnyRow | null>(null);
  const [form, setForm] = useState<EmployeeForm>(() => freshForm());
  const [fingerDeviceId, setFingerDeviceId] = useState("");
  const [fingerNo, setFingerNo] = useState(1);
  const [syncDeviceId, setSyncDeviceId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AnyRow | null>(null);
  const [notice, setNotice] = useState("");

  const catalog = useQuery({
    queryKey: ["employee-catalog"],
    queryFn: async () => {
      const [companies, branches, departments, groups, devices] = await Promise.all([
        supabase.from("companies").select("id,name").order("name"),
        supabase.from("branches").select("id,name,company_id").order("name"),
        supabase.from("departments").select("id,name,company_id,branch_id").order("name"),
        supabase.from("attendance_groups").select("id,name,company_id,branch_id").order("name"),
        supabase.from("devices").select("id,name,status,dev_index,device_identifier,branch_id").order("name")
      ]);
      for (const result of [companies, branches, departments, groups, devices]) {
        if (result.error) throw result.error;
      }
      return {
        companies: companies.data ?? [],
        branches: branches.data ?? [],
        departments: departments.data ?? [],
        groups: groups.data ?? [],
        devices: devices.data ?? []
      };
    }
  });

  const employees = useQuery({
    queryKey: ["employees-management"],
    queryFn: async () => {
      const [people, assignments, commands] = await Promise.all([
        supabase
          .from("employees")
          .select("*, companies:company_id(name), branches:branch_id(name), departments:department_id(name), attendance_groups:attendance_group_id(name)")
          .order("full_name", { ascending: true }),
        supabase.from("employee_devices").select("*, devices:device_id(id,name,status,dev_index)").order("created_at", { ascending: true }),
        supabase.from("device_commands")
          .select("id,status,payload,command_type,device_id,employee_id,error_message,created_at,devices:device_id(name)")
          .order("created_at", { ascending: false }).limit(200)
      ]);
      if (people.error) throw people.error;
      if (assignments.error) throw assignments.error;
      if (commands.error) throw commands.error;
      return {
        people: people.data ?? [],
        assignments: assignments.data ?? [],
        commands: commands.data ?? []
      };
    }
  });

  const assignmentsByEmployee = useMemo(() => {
    const grouped: Record<string, AnyRow[]> = {};
    for (const assignment of employees.data?.assignments ?? []) {
      grouped[assignment.employee_id] = [...(grouped[assignment.employee_id] ?? []), assignment];
    }
    return grouped;
  }, [employees.data?.assignments]);

  const rows = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return (employees.data?.people ?? []).filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!text) return true;
      return [row.employee_code, row.external_employee_id, row.full_name, row.email, relationLabel(row.departments), relationLabel(row.branches)]
        .join(" ")
        .toLowerCase()
        .includes(text);
    });
  }, [employees.data?.people, filter, statusFilter]);

  const stats = useMemo(() => {
    const people = employees.data?.people ?? [];
    return {
      total: people.length,
      active: people.filter((row) => row.status === "active").length,
      cards: people.filter((row) => row.card_number).length,
      fingerprints: people.filter((row) => Number(row.fingerprint_count ?? 0) > 0 || row.fingerprint_status === "enrolled").length
    };
  }, [employees.data?.people]);

  const commandFailures = useMemo(
    () => (employees.data?.commands ?? [])
      .filter((command) => command.status !== "success" && command.status !== "cancelled" && command.error_message)
      .slice(0, 5),
    [employees.data?.commands]
  );

  const saveEmployee = useMutation({
    mutationFn: async ({ continueAdding }: { continueAdding: boolean }) => {
      const code = form.employee_code.trim();
      const name = form.full_name.trim();
      if (!form.company_id || !code || !name) throw new Error("Empresa, ID y nombre son obligatorios.");

      const metadata = {
        ...(editing?.metadata && typeof editing.metadata === "object" ? editing.metadata : {}),
        access_valid_from: form.access_valid_from || null,
        access_valid_to: form.access_valid_to || null
      };
      const employeePayload = {
        company_id: form.company_id,
        branch_id: form.branch_id || null,
        department_id: form.department_id || null,
        attendance_group_id: form.attendance_group_id || null,
        employee_code: code,
        external_employee_id: form.external_employee_id.trim() || null,
        full_name: name,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        document_number: form.document_number.trim() || null,
        status: form.status,
        card_number: form.card_number.trim() || null,
        pin_enabled: form.pin_enabled,
        hired_at: form.hired_at || null,
        terminated_at: form.terminated_at || null,
        access_valid_from: form.access_valid_from || null,
        access_valid_to: form.access_valid_to || null,
        metadata,
        device_ids: form.target_device_ids
      };

      const data = await invokeFunction("admin-employees", {
        action: editing ? "update" : "create",
        id: editing?.id,
        employee: employeePayload
      }) as { employee?: AnyRow };
      const employee = data.employee;
      if (!employee?.id) throw new Error("No se recibio el empleado guardado.");
      return { employee, continueAdding };
    },
    onSuccess: async ({ continueAdding }) => {
      await queryClient.invalidateQueries({ queryKey: ["employees-management"] });
      setCredentialOpen(false);
      setFingerDeviceId("");
      setFingerNo(1);
      enrollFingerprint.reset();
      if (continueAdding && !editing) {
        const firstCompany = catalog.data?.companies[0]?.id ?? "";
        setEditing(null);
        setForm(freshForm(firstCompany));
        setActiveTab("basic");
        setNotice("Persona creada. El formulario quedó listo para añadir otra persona.");
      } else {
        setOpen(false);
        setEditing(null);
        setForm(freshForm());
        setActiveTab("basic");
        setNotice(editing ? "Persona actualizada correctamente." : "Persona creada correctamente.");
      }
    }
  });

  const deleteEmployee = useMutation({
    mutationFn: async (row: AnyRow) => {
      await invokeFunction("admin-employees", { action: "delete", id: row.id });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["employees-management"] });
      setNotice("Persona eliminada. Las bajas en dispositivos asignados quedaron encoladas.");
      setDeleteTarget(null);
    }
  });

  const enrollFingerprint = useMutation({
    mutationFn: async () => {
      if (!form.id) throw new Error("Guarda la persona antes de capturar huella.");
      if (!fingerDeviceId) throw new Error("Selecciona el dispositivo de enrolamiento.");
      await invokeFunction("admin-employees", {
        action: "enroll_fingerprint",
        employee_id: form.id,
        device_id: fingerDeviceId,
        finger_no: fingerNo
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["employees-management"] });
      setNotice("La solicitud de captura de huella quedó encolada.");
    }
  });

  const syncPeople = useMutation({
    mutationFn: async () => {
      if (!syncDeviceId) throw new Error("Selecciona un dispositivo.");
      await invokeFunction("admin-employees", { action: "sync_device_people", device_id: syncDeviceId });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["employees-management"] });
      setSyncOpen(false);
      setSyncDeviceId("");
      setNotice("Sincronización de personas encolada para el dispositivo seleccionado.");
    }
  });

  const syncAllPeople = useMutation({
    mutationFn: async () => {
      await invokeFunction("admin-employees", { action: "sync_all_device_people" });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["employees-management"] });
      setNotice("Sincronización de personas encolada para todos los dispositivos enlazados.");
    }
  });

  function startCreate() {
    const firstCompany = catalog.data?.companies[0]?.id ?? "";
    setCredentialOpen(false);
    setFingerDeviceId("");
    setFingerNo(1);
    enrollFingerprint.reset();
    saveEmployee.reset();
    setEditing(null);
    setForm(freshForm(firstCompany));
    setActiveTab("basic");
    setOpen(true);
  }

  function startEdit(row: AnyRow) {
    setCredentialOpen(false);
    setFingerDeviceId("");
    setFingerNo(1);
    enrollFingerprint.reset();
    saveEmployee.reset();
    setEditing(row);
    setForm(formFromEmployee(row, assignmentsByEmployee[row.id] ?? []));
    setActiveTab("basic");
    setOpen(true);
  }

  function closeCredentialDrawer() {
    setCredentialOpen(false);
    setFingerDeviceId("");
    setFingerNo(1);
    enrollFingerprint.reset();
  }

  function closeEmployeeEditor() {
    if (saveEmployee.isPending) return;
    setOpen(false);
    closeCredentialDrawer();
    setEditing(null);
    setForm(freshForm());
    setActiveTab("basic");
  }

  function openCredentialDrawer() {
    if (!open) return;
    setFingerDeviceId("");
    setFingerNo(1);
    enrollFingerprint.reset();
    setCredentialOpen(true);
  }

  const deviceOptions = catalog.data?.devices ?? [];
  const persistedDeviceIds = new Set((form.id ? assignmentsByEmployee[form.id] ?? [] : []).map((assignment) => assignment.device_id));
  const fingerprintDeviceOptions = deviceOptions.filter((device) => persistedDeviceIds.has(device.id));

  return (
    <Stack spacing={2.2}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} alignItems={{ md: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h4">Personas</Typography>
          <Typography color="text.secondary">Gestiona empleados, dispositivos destino y credenciales operativas.</Typography>
        </Box>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ width: { xs: "100%", md: "auto" } }}>
          <IconButton aria-label="refrescar" onClick={() => employees.refetch()}>
            <RefreshIcon />
          </IconButton>
          <Button variant="outlined" startIcon={<SyncIcon />} onClick={() => setSyncOpen(true)} sx={{ whiteSpace: "nowrap" }}>
            Sincronizar desde dispositivo
          </Button>
          <Button variant="outlined" startIcon={<SyncIcon />} onClick={() => syncAllPeople.mutate()} disabled={syncAllPeople.isPending}>
            Sincronizar todos
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={startCreate}>
            Anadir persona
          </Button>
        </Stack>
      </Stack>

      <Grid2 container spacing={1.5}>
        {[
          ["Personas", stats.total],
          ["Activas", stats.active],
          ["Con tarjeta", stats.cards],
          ["Con huella", stats.fingerprints]
        ].map(([label, value]) => (
          <Grid2 key={label} size={{ xs: 6, md: 3 }}>
            <Paper variant="outlined" sx={{ p: 1.7, boxShadow: "none" }}>
              <Typography variant="caption" color="text.secondary">{label}</Typography>
              <Typography variant="h5">{value}</Typography>
            </Paper>
          </Grid2>
        ))}
      </Grid2>

      <Paper variant="outlined" sx={{ p: 1.5, boxShadow: "none" }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.2}>
          <TextField
            size="small"
            placeholder="Buscar por ID, nombre, departamento o sucursal"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }}
          />
          <TextField select size="small" label="Estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value="active">Activos</MenuItem>
            <MenuItem value="inactive">Inactivos</MenuItem>
            <MenuItem value="suspended">Suspendidos</MenuItem>
            <MenuItem value="all">Todos</MenuItem>
          </TextField>
        </Stack>
      </Paper>

      {(employees.isLoading || catalog.isLoading) && <LinearProgress />}
      {employees.error && <Alert severity="error">{employees.error.message}</Alert>}
      {saveEmployee.error && <Alert severity="error">{saveEmployee.error.message}</Alert>}
      {deleteEmployee.error && <Alert severity="error">{deleteEmployee.error.message}</Alert>}
      {syncAllPeople.error && <Alert severity="error">{syncAllPeople.error.message}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice("")}>{notice}</Alert>}
      {commandFailures.length > 0 && (
        <Alert severity="error">
          <Typography variant="subtitle2">Hay comandos de dispositivo fallidos que requieren revisión:</Typography>
          <Box component="ul" sx={{ my: 0.5, pl: 2.5 }}>
            {commandFailures.map((command) => (
              <li key={command.id}>
                {command.command_type} · {relationLabel(command.devices) || command.device_id} · {command.status}
                {command.payload?.employee_no ? ` · persona ${command.payload.employee_no}` : ""}: {command.error_message}
              </li>
            ))}
          </Box>
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined" sx={{ boxShadow: "none" }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Persona</TableCell>
              <TableCell>Departamento</TableCell>
              <TableCell>Grupo</TableCell>
              <TableCell>Dispositivos</TableCell>
              <TableCell>Credenciales</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell align="right">Acciones</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const assignments = assignmentsByEmployee[row.id] ?? [];
              return (
                <TableRow key={row.id} hover>
                  <TableCell>{row.external_employee_id || row.employee_code}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>{row.full_name}</Typography>
                    <Typography variant="caption" color="text.secondary">{relationLabel(row.branches) || "Sin sucursal"}</Typography>
                  </TableCell>
                  <TableCell>{relationLabel(row.departments) || "-"}</TableCell>
                  <TableCell>{relationLabel(row.attendance_groups) || "-"}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.6} flexWrap="wrap" useFlexGap>
                      {assignments.length ? assignments.map((assignment) => (
                        <Chip
                          key={assignment.id}
                          size="small"
                          variant="outlined"
                          color={assignment.sync_status === "failed" ? "error" : assignment.sync_status === "success" ? "success" : "default"}
                          label={`${assignment.devices?.name ?? assignment.device_id}${assignment.sync_status ? ` · ${assignment.sync_status}` : ""}`}
                          title={assignment.last_error ?? ""}
                        />
                      )) : <Typography variant="caption" color="text.secondary">Sin destino</Typography>}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.6}>
                      <Chip size="small" icon={<CreditCardIcon />} label={row.card_number ? "1" : "0"} variant="outlined" />
                      <Chip size="small" icon={<FingerprintIcon />} label={row.fingerprint_count ?? 0} variant="outlined" />
                    </Stack>
                  </TableCell>
                  <TableCell><StatusChip value={row.status} /></TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => startEdit(row)} aria-label="editar persona">
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => { deleteEmployee.reset(); setDeleteTarget(row); }}
                      aria-label="eliminar persona"
                      disabled={deleteEmployee.isPending}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog
        open={open}
        onClose={closeEmployeeEditor}
        fullWidth
        fullScreen={fullScreenEditor}
        maxWidth="lg"
        scroll="paper"
        PaperProps={{ sx: { maxHeight: { sm: "calc(100dvh - 32px)" } } }}
      >
        <DialogTitle sx={{ pb: 0 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Box>
              <Typography variant="h5">{editing ? "Editar persona" : "Anadir persona"}</Typography>
              <Typography variant="body2" color="text.secondary">Informacion operativa y credenciales por dispositivo.</Typography>
            </Box>
            <IconButton onClick={closeEmployeeEditor} aria-label="cerrar" disabled={saveEmployee.isPending}>
              <CloseIcon />
            </IconButton>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ pt: 2, px: { xs: 1.5, sm: 3 } }}>
          {saveEmployee.error && <Alert severity="error" sx={{ mb: 2 }}>{saveEmployee.error.message}</Alert>}
          <Grid2 container spacing={2}>
            <Grid2 size={{ xs: 12, md: 8 }}>
              <Paper variant="outlined" sx={{ boxShadow: "none" }}>
                <Tabs
                  value={activeTab}
                  onChange={(_, value) => setActiveTab(value)}
                  variant="scrollable"
                  scrollButtons="auto"
                  sx={{ px: 1.5, borderBottom: 1, borderColor: "divider" }}
                >
                  <Tab value="basic" label="Informacion basica" />
                  <Tab value="access" label="Nivel de acceso" />
                  <Tab value="schedule" label="Horario" />
                </Tabs>
                <Box sx={{ p: 2 }}>
                  {activeTab === "basic" && (
                    <Grid2 container spacing={1.5}>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField select label="Empresa *" value={form.company_id} onChange={(event) => setForm((current) => ({ ...current, company_id: event.target.value }))} fullWidth>
                          {(catalog.data?.companies ?? []).map((company) => <MenuItem key={company.id} value={company.id}>{company.name}</MenuItem>)}
                        </TextField>
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField select label="Sucursal" value={form.branch_id} onChange={(event) => setForm((current) => ({ ...current, branch_id: event.target.value }))} fullWidth>
                          <MenuItem value="">Sin sucursal</MenuItem>
                          {(catalog.data?.branches ?? []).map((branch) => <MenuItem key={branch.id} value={branch.id}>{branch.name}</MenuItem>)}
                        </TextField>
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField select label="Departamento" value={form.department_id} onChange={(event) => setForm((current) => ({ ...current, department_id: event.target.value }))} fullWidth>
                          <MenuItem value="">Sin departamento</MenuItem>
                          {(catalog.data?.departments ?? []).map((department) => <MenuItem key={department.id} value={department.id}>{department.name}</MenuItem>)}
                        </TextField>
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="ID empleado *" value={form.employee_code} onChange={(event) => setForm((current) => ({ ...current, employee_code: event.target.value }))} fullWidth helperText={editing ? "Evita cambiarlo si ya fue enviado a dispositivos." : "Sera usado como employeeNo si no defines ID externo."} />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="ID externo / employeeNo" value={form.external_employee_id} onChange={(event) => setForm((current) => ({ ...current, external_employee_id: event.target.value }))} fullWidth />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Nombre completo *" value={form.full_name} onChange={(event) => setForm((current) => ({ ...current, full_name: event.target.value }))} fullWidth />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Documento" value={form.document_number} onChange={(event) => setForm((current) => ({ ...current, document_number: event.target.value }))} fullWidth />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Correo" type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} fullWidth />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Telefono" value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} fullWidth />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField select label="Estado" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as EmployeeForm["status"] }))} fullWidth>
                          <MenuItem value="active">Activo</MenuItem>
                          <MenuItem value="inactive">Inactivo</MenuItem>
                          <MenuItem value="suspended">Suspendido</MenuItem>
                        </TextField>
                      </Grid2>
                    </Grid2>
                  )}

                  {activeTab === "access" && (
                    <Stack spacing={1.5}>
                      <Typography variant="subtitle1">Dispositivos destino</Typography>
                      <FormControl fullWidth>
                        <Select
                          multiple
                          displayEmpty
                          value={form.target_device_ids}
                          onChange={(event) => {
                            const value = event.target.value;
                            setForm((current) => ({ ...current, target_device_ids: typeof value === "string" ? value.split(",") : value }));
                          }}
                          renderValue={(selected) => {
                            if (!selected.length) return <Typography color="text.secondary">Selecciona dispositivos</Typography>;
                            return (
                              <Stack direction="row" spacing={0.7} flexWrap="wrap" useFlexGap>
                                {selected.map((id) => {
                                  const device = deviceOptions.find((item) => item.id === id);
                                  return <Chip key={id} size="small" label={device?.name ?? id} />;
                                })}
                              </Stack>
                            );
                          }}
                        >
                          {deviceOptions.map((device) => (
                            <MenuItem key={device.id} value={device.id}>
                              <Checkbox checked={form.target_device_ids.includes(device.id)} />
                              {device.name} ({device.status}{device.dev_index ? ", enlazado" : ", sin devIndex"})
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <Alert severity="info" variant="outlined">
                        Al guardar se crearan comandos de persona y tarjeta para cada dispositivo seleccionado.
                      </Alert>
                    </Stack>
                  )}

                  {activeTab === "schedule" && (
                    <Grid2 container spacing={1.5}>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField select label="Grupo de asistencia" value={form.attendance_group_id} onChange={(event) => setForm((current) => ({ ...current, attendance_group_id: event.target.value }))} fullWidth>
                          <MenuItem value="">Sin grupo</MenuItem>
                          {(catalog.data?.groups ?? []).map((group) => <MenuItem key={group.id} value={group.id}>{group.name}</MenuItem>)}
                        </TextField>
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Fecha de incorporacion" type="date" value={form.hired_at} onChange={(event) => setForm((current) => ({ ...current, hired_at: event.target.value }))} fullWidth InputLabelProps={{ shrink: true }} />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Valido desde" type="date" value={form.access_valid_from} onChange={(event) => setForm((current) => ({ ...current, access_valid_from: event.target.value }))} fullWidth InputLabelProps={{ shrink: true }} />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Valido hasta" type="date" value={form.access_valid_to} onChange={(event) => setForm((current) => ({ ...current, access_valid_to: event.target.value }))} fullWidth InputLabelProps={{ shrink: true }} />
                      </Grid2>
                      <Grid2 size={{ xs: 12, md: 6 }}>
                        <TextField label="Fecha baja" type="date" value={form.terminated_at} onChange={(event) => setForm((current) => ({ ...current, terminated_at: event.target.value }))} fullWidth InputLabelProps={{ shrink: true }} />
                      </Grid2>
                    </Grid2>
                  )}
                </Box>
              </Paper>
            </Grid2>

            <Grid2 size={{ xs: 12, md: 4 }}>
              <Paper variant="outlined" sx={{ p: 2, boxShadow: "none", height: "100%" }}>
                <Stack spacing={1.6}>
                  <Stack direction="row" spacing={1.1} alignItems="center">
                    <Box sx={{ width: 72, height: 90, borderRadius: 1, bgcolor: "background.default", display: "grid", placeItems: "center" }}>
                      <BadgeIcon color="disabled" />
                    </Box>
                    <Box>
                      <Typography variant="subtitle1">Credenciales</Typography>
                      <Typography variant="body2" color="text.secondary">Tarjeta, huella y sincronizacion.</Typography>
                    </Box>
                  </Stack>
                  <Divider />
                  <Stack direction="row" spacing={1}>
                    <Chip icon={<CreditCardIcon />} label={form.card_number ? "Tarjeta 1" : "Tarjeta 0"} variant="outlined" />
                    <Chip icon={<FingerprintIcon />} label={`Huellas ${editing?.fingerprint_count ?? 0}`} variant="outlined" />
                  </Stack>
                  <Button variant="outlined" onClick={openCredentialDrawer} disabled={!open}>
                    Administracion de credencial
                  </Button>
                  <Alert severity="warning" variant="outlined">
                    Rostro e iris quedan bloqueados hasta aprobar almacenamiento biometrico seguro.
                  </Alert>
                </Stack>
              </Paper>
            </Grid2>
          </Grid2>
        </DialogContent>
        <DialogActions sx={{ px: { xs: 1.5, sm: 3 }, py: 1.5, flexWrap: "wrap", gap: 1, "& > :not(style) ~ :not(style)": { ml: 0 } }}>
          <Button onClick={closeEmployeeEditor} disabled={saveEmployee.isPending} sx={{ width: { xs: "100%", sm: "auto" } }}>Cancelar</Button>
          <Button
            variant={editing ? "contained" : "outlined"}
            onClick={() => saveEmployee.mutate({ continueAdding: false })}
            disabled={saveEmployee.isPending}
            sx={{ width: { xs: "100%", sm: "auto" } }}
          >
            {editing ? "Guardar" : "Anadir"}
          </Button>
          {!editing && (
            <Button
              variant="contained"
              onClick={() => saveEmployee.mutate({ continueAdding: true })}
              disabled={saveEmployee.isPending}
              sx={{ width: { xs: "100%", sm: "auto" } }}
            >
              Anadir y continuar
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Drawer
        anchor="right"
        open={open && credentialOpen}
        onClose={closeCredentialDrawer}
        ModalProps={{ keepMounted: false }}
        sx={{ zIndex: (currentTheme) => currentTheme.zIndex.modal + 1 }}
        PaperProps={{ sx: { width: { xs: "100%", sm: 430 }, p: { xs: 1.5, sm: 2 }, overflowY: "auto" } }}
      >
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Administracion de credencial</Typography>
            <IconButton onClick={closeCredentialDrawer} aria-label="cerrar credenciales"><CloseIcon /></IconButton>
          </Stack>
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle1">Tarjeta</Typography>
            <TextField label="Numero de tarjeta" value={form.card_number} onChange={(event) => setForm((current) => ({ ...current, card_number: event.target.value }))} fullWidth />
            <FormControlLabel control={<Checkbox checked={form.pin_enabled} onChange={(event) => setForm((current) => ({ ...current, pin_enabled: event.target.checked }))} />} label="PIN habilitado" />
          </Stack>
          <Divider />
          <Stack spacing={1}>
            <Typography variant="subtitle1">Huella dactilar</Typography>
            {!form.id && <Alert severity="warning">Guarda la persona antes de capturar huella</Alert>}
            {form.id && fingerprintDeviceOptions.length === 0 && (
              <Alert severity="warning">Asigna y guarda al menos un dispositivo antes de capturar huella.</Alert>
            )}
            <TextField
              select
              label="Dispositivo de enrolamiento"
              value={fingerDeviceId}
              onChange={(event) => setFingerDeviceId(event.target.value)}
              fullWidth
              disabled={!form.id || fingerprintDeviceOptions.length === 0}
              SelectProps={{ MenuProps: { sx: { zIndex: (currentTheme) => currentTheme.zIndex.modal + 2 } } }}
            >
              <MenuItem value="">Selecciona dispositivo</MenuItem>
              {fingerprintDeviceOptions.map((device) => <MenuItem key={device.id} value={device.id}>{device.name} ({device.status})</MenuItem>)}
            </TextField>
            <TextField
              select
              label="Dedo"
              value={fingerNo}
              onChange={(event) => setFingerNo(Number(event.target.value))}
              fullWidth
              SelectProps={{ MenuProps: { sx: { zIndex: (currentTheme) => currentTheme.zIndex.modal + 2 } } }}
            >
              {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                <MenuItem key={value} value={value}>Huella {value}</MenuItem>
              ))}
            </TextField>
            <Button
              variant="contained"
              startIcon={<FingerprintIcon />}
              onClick={() => enrollFingerprint.mutate()}
              disabled={enrollFingerprint.isPending || !form.id || !fingerDeviceId}
            >
              Capturar huella en dispositivo
            </Button>
            {enrollFingerprint.error && <Alert severity="error">{enrollFingerprint.error.message}</Alert>}
            {enrollFingerprint.isSuccess && <Alert severity="success">Solicitud de captura encolada.</Alert>}
            <Alert severity="info" variant="outlined">
              El dispositivo debe iniciar la captura. La plantilla no se muestra ni se guarda en el frontend.
            </Alert>
          </Stack>
        </Stack>
      </Drawer>

      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => { if (!deleteEmployee.isPending) { setDeleteTarget(null); deleteEmployee.reset(); } }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Eliminar persona</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography>
              ¿Seguro que deseas eliminar a <strong>{deleteTarget?.full_name}</strong>?
            </Typography>
            <Alert severity="warning">
              La persona se eliminará de Supabase y se encolará un comando <code>delete_person</code> para cada dispositivo asignado
              ({deleteTarget ? (assignmentsByEmployee[deleteTarget.id] ?? []).length : 0}). Esta acción no se puede deshacer desde la interfaz.
            </Alert>
            {deleteEmployee.error && <Alert severity="error">{deleteEmployee.error.message}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setDeleteTarget(null); deleteEmployee.reset(); }} disabled={deleteEmployee.isPending}>Cancelar</Button>
          <Button
            color="error"
            variant="contained"
            startIcon={<DeleteIcon />}
            disabled={!deleteTarget || deleteEmployee.isPending}
            onClick={() => { if (deleteTarget) deleteEmployee.mutate(deleteTarget); }}
          >
            Eliminar persona
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={syncOpen}
        onClose={() => { setSyncOpen(false); setSyncDeviceId(""); syncPeople.reset(); }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Sincronizar empleados desde dispositivo</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <TextField select label="Dispositivo origen" value={syncDeviceId} onChange={(event) => setSyncDeviceId(event.target.value)} fullWidth>
              <MenuItem value="">Selecciona dispositivo</MenuItem>
              {deviceOptions.map((device) => <MenuItem key={device.id} value={device.id}>{device.name} ({device.status})</MenuItem>)}
            </TextField>
            <Alert severity="info" variant="outlined">
              Esto debe leer personas reales del DeviceGateway y hacer upsert en Supabase. No crea datos demo.
            </Alert>
            {syncPeople.error && <Alert severity="error">{syncPeople.error.message}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setSyncOpen(false); setSyncDeviceId(""); syncPeople.reset(); }}>Cancelar</Button>
          <Button variant="contained" startIcon={<PersonSearchIcon />} disabled={!syncDeviceId || syncPeople.isPending} onClick={() => syncPeople.mutate()}>
            Sincronizar
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
