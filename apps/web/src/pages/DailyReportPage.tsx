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
import { format } from "date-fns";
import { supabase } from "../lib/supabase";

export function DailyReportPage() {
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["daily-report", date, branchId, employeeId, departmentId, groupId, deviceId],
    queryFn: async () => {
      let request = supabase
        .from("daily_attendance")
        .select("*, employees:employee_id(full_name, employee_code, department_id, attendance_group_id), branches:branch_id(name), work_schedules:schedule_id(name)")
        .eq("attendance_date", date)
        .order("actual_check_in", { ascending: true });
      if (branchId) request = request.eq("branch_id", branchId);
      if (employeeId) request = request.eq("employee_id", employeeId);
      if (deviceId) request = request.contains("device_ids", [deviceId]);
      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []).filter((row) => (!departmentId || row.employees?.department_id === departmentId) && (!groupId || row.employees?.attendance_group_id === groupId));
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

  async function recalculate() {
    setMessage(null);
    const { error } = await supabase.functions.invoke("calculate-daily-attendance", {
      body: { date, branch_id: branchId || undefined, employee_id: employeeId || undefined }
    });
    if (error) setMessage(error.message);
    else {
      setMessage("Recalculo ejecutado.");
      await query.refetch();
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
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={recalculate}>Recalcular</Button>
        <Button startIcon={<FileDownloadIcon />} variant="contained" onClick={exportExcel}>Exportar Excel</Button>
      </Stack>
      {message && <Alert severity={message.includes("ejecutado") ? "success" : "error"}>{message}</Alert>}
      {query.isLoading && <LinearProgress />}
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
            {(query.data ?? []).map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{lookups.data?.departments.find((v) => v.id === row.employees?.department_id)?.name ?? ""}</TableCell><TableCell>{lookups.data?.groups.find((v) => v.id === row.employees?.attendance_group_id)?.name ?? ""}</TableCell><TableCell>{row.employees?.full_name ?? row.employee_id}</TableCell>
                <TableCell>{row.attendance_date}</TableCell>
                <TableCell>{formatGt(row.actual_check_in)}</TableCell><TableCell>{formatGt(row.actual_check_out)}</TableCell>
                <TableCell>{row.actual_check_in || row.actual_check_out ? `${formatGt(row.actual_check_in)} / ${formatGt(row.actual_check_out)}` : "Ninguno"}</TableCell><TableCell>{row.lunch_minutes ?? 0} min</TableCell><TableCell>{formatBreaks(row.break_records)}</TableCell><TableCell>{Math.round((row.worked_minutes ?? 0) / 60 * 100) / 100} h</TableCell>
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
const formatBreaks = (value: unknown) => Array.isArray(value) && value.length ? value.map((item) => `${formatGt(item?.out)} - ${formatGt(item?.in)} (${item?.minutes ?? 0} min)`).join("; ") : "-";
