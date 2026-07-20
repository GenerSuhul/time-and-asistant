import { useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  MenuItem,
  Typography
} from "@mui/material";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function DailyReportPage() {
  const [date, setDate] = useState(todayInGuatemala);
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageSeverity, setMessageSeverity] = useState<"success" | "info" | "warning" | "error">("info");
  const [syncing, setSyncing] = useState(false);

  const query = useQuery({
    queryKey: ["daily-report", date, branchId, employeeId, departmentId, groupId, deviceId],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("attendance-reports", {
        body: {
          action: "daily",
          date,
          branch_id: branchId || undefined,
          employee_id: employeeId || undefined,
          recalculate: false
        }
      });
      if (error) throw error;
      return (data?.rows ?? []).filter((row: any) =>
        (!departmentId || row.department_id === departmentId) &&
        (!groupId || row.attendance_group_id === groupId) &&
        (!deviceId || row.device_ids?.includes(deviceId))
      );
    }
  });
  const lookups = useQuery({ queryKey: ["attendance-report-lookups"], queryFn: async () => {
    const [branches, departments, groups, employees, devices] = await Promise.all([
      supabase.from("branches").select("id,name").order("name"), supabase.from("departments").select("id,name").order("name"),
      supabase.from("attendance_groups").select("id,name").order("name"), supabase.from("employees").select("id,full_name").order("full_name"),
      supabase.from("devices").select("id,name").order("name")
    ]); return { branches: branches.data ?? [], departments: departments.data ?? [], groups: groups.data ?? [], employees: employees.data ?? [], devices: devices.data ?? [] };
  }});

  const rawQuery = useQuery({
    queryKey: ["raw-events", selectedEmployee, date],
    enabled: rawOpen && Boolean(selectedEmployee),
    queryFn: async () => {
      const next = new Date(`${date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const { data, error } = await supabase
        .from("raw_access_events")
        .select("*")
        .eq("employee_id", selectedEmployee)
        .gte("occurred_at", `${date}T00:00:00-06:00`)
        .lt("occurred_at", `${next.toISOString().slice(0, 10)}T00:00:00-06:00`)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    }
  });

  async function syncFromDevices() {
    setMessage(null);
    setMessageSeverity("info");
    setMessage("Buscando marcajes en dispositivos…");
    setSyncing(true);
    const deadline = Date.now() + 120_000;
    let commandIds: string[] | undefined;
    try {
      while (Date.now() < deadline) {
        const { data, error } = await supabase.functions.invoke("attendance-sync", {
          body: {
            action: "sync_day_and_recalculate",
            date,
            device_ids: deviceId ? [deviceId] : undefined,
            force: true,
            command_ids: commandIds
          }
        });
        if (error) throw error;
        commandIds = data?.command_ids;
        if (data?.state === "processing") {
          await delay(2_000);
          continue;
        }

        const sync = data?.sync ?? {};
        const report = data?.report ?? {};
        const details = `${Number(sync.devices_scanned ?? 0)} dispositivos consultados, ${Number(sync.events_found ?? 0)} eventos encontrados, ${Number(sync.events_inserted ?? 0)} nuevos, ${Number(sync.events_skipped ?? 0)} omitidos por duplicado y ${Number(report.rows ?? 0)} filas del reporte.`;
        if (sync.status === "failed") {
          setMessage(`No fue posible sincronizar el día. ${details}`);
          setMessageSeverity("error");
        } else if (Number(sync.events_found ?? 0) === 0) {
          setMessage(`No se encontraron marcajes para esta fecha. ${details}`);
          setMessageSeverity(sync.status === "partial" ? "warning" : "info");
        } else if (sync.status === "partial") {
          setMessage(`Actualización parcial. ${details}`);
          setMessageSeverity("warning");
        } else {
          setMessage(`Día actualizado. ${details}`);
          setMessageSeverity("success");
        }
        await query.refetch();
        return;
      }
      setMessage("La búsqueda de marcajes excedió 120 segundos. El worker puede continuar procesando; vuelve a intentar en un momento.");
      setMessageSeverity("warning");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageSeverity("error");
    } finally {
      setSyncing(false);
    }
  }

  async function exportExcel() {
    setMessage(null);
    const { data, error } = await supabase.functions.invoke("export-attendance-excel", {
      body: { start_date: date, end_date: date, branch_id: branchId || undefined, department_id: departmentId || undefined, attendance_group_id: groupId || undefined, employee_id: employeeId || undefined, device_id: deviceId || undefined }
    });
    if (error) setMessage(error.message);
    else if (data?.signed_url) window.open(data.signed_url, "_blank", "noopener,noreferrer");
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Reporte diario</Typography>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <TextField size="small" label="Fecha" type="date" value={date} onChange={(event) => setDate(event.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" select label="Sucursal" value={branchId} onChange={(event) => setBranchId(event.target.value)}><MenuItem value="">Todas</MenuItem>{lookups.data?.branches.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Departamento" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.departments.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Grupo asistencia" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.groups.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Empleado" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.employees.map((v) => <MenuItem key={v.id} value={v.id}>{v.full_name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Dispositivo" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.devices.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={syncFromDevices} disabled={syncing}>Actualizar día</Button>
        <Button startIcon={<FileDownloadIcon />} variant="contained" onClick={exportExcel}>Exportar Excel</Button>
      </Stack>
      {message && <Alert severity={messageSeverity}>{message}</Alert>}
      {syncing && <Alert severity="info">Buscando marcajes en dispositivos…</Alert>}
      {(query.isFetching || syncing) && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Departamento</TableCell><TableCell>Grupo de asistencia</TableCell><TableCell>Nombre</TableCell>
              <TableCell>Fecha</TableCell>
              <TableCell>Hora real del registro de entrada</TableCell><TableCell>Hora real de registro de salida</TableCell>
              <TableCell>Grabación de asistencia</TableCell><TableCell>Duración de la pausa</TableCell><TableCell>Registros de descansos</TableCell><TableCell>Periodo de tiempo</TableCell><TableCell>Eventos</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((row: any) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.department ?? ""}</TableCell><TableCell>{row.attendance_group ?? ""}</TableCell><TableCell>{row.employee_name ?? row.employee_id}</TableCell>
                <TableCell>{row.attendance_date}</TableCell>
                <TableCell>{formatGt(row.actual_check_in)}</TableCell><TableCell>{formatGt(row.actual_check_out)}</TableCell>
                <TableCell>{row.actual_check_in || row.actual_check_out ? `${formatGt(row.actual_check_in)} / ${formatGt(row.actual_check_out)}` : "Ninguno"}</TableCell><TableCell>{row.break_minutes ?? 0} min</TableCell><TableCell>{formatBreaks(row.break_records)}</TableCell><TableCell>{Math.round((row.attendance_minutes ?? 0) / 60 * 100) / 100} h</TableCell>
                <TableCell>
                  <Button size="small" onClick={() => { setSelectedEmployee(row.employee_id); setRawOpen(true); }}>
                    Ver
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={rawOpen} onClose={() => setRawOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Eventos crudos</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            {(rawQuery.data ?? []).map((event) => (
              <Paper key={event.id} sx={{ p: 1.5 }}>
                <Typography variant="body2">{event.occurred_at} - {event.raw_event_type} - {event.access_result}</Typography>
                <Typography variant="caption" color="text.secondary">{event.event_hash}</Typography>
              </Paper>
            ))}
          </Stack>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

const formatGt = (value?: string | null) => value ? new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date(value)) : "Ninguno";
const todayInGuatemala = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const formatBreaks = (value: unknown) => Array.isArray(value) && value.length ? value.map((item) => `${formatGt(item?.out)} - ${formatGt(item?.in)} (${item?.minutes ?? 0} min)`).join("; ") : "-";
const delay = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
