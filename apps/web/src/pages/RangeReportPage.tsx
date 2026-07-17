import { useState } from "react";
import { Alert, Button, LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { supabase } from "../lib/supabase";

export function RangeReportPage() {
  const [startDate, setStartDate] = useState(format(subDays(new Date(), 7), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [branchId, setBranchId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["range-report", startDate, endDate, branchId, departmentId, groupId, employeeId, deviceId, status],
    queryFn: async () => {
      let request = supabase
        .from("daily_attendance")
        .select("*, employees:employee_id(full_name, employee_code, department_id, attendance_group_id), branches:branch_id(name)")
        .gte("attendance_date", startDate)
        .lte("attendance_date", endDate)
        .order("attendance_date", { ascending: false });
      if (branchId) request = request.eq("branch_id", branchId);
      if (status) request = request.eq("status", status);
      if (employeeId) request = request.eq("employee_id", employeeId);
      if (deviceId) request = request.contains("device_ids", [deviceId]);
      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []).filter((row) => (!departmentId || row.employees?.department_id === departmentId) && (!groupId || row.employees?.attendance_group_id === groupId));
    }
  });
  const lookups = useQuery({ queryKey: ["attendance-report-lookups"], queryFn: async () => {
    const [branches, departments, groups, employees, devices] = await Promise.all([
      supabase.from("branches").select("id,name").order("name"), supabase.from("departments").select("id,name").order("name"), supabase.from("attendance_groups").select("id,name").order("name"),
      supabase.from("employees").select("id,full_name").order("full_name"), supabase.from("devices").select("id,name").order("name")
    ]); return { branches: branches.data ?? [], departments: departments.data ?? [], groups: groups.data ?? [], employees: employees.data ?? [], devices: devices.data ?? [] };
  }});

  async function recalculate() {
    const { error } = await supabase.functions.invoke("recalculate-attendance-range", {
      body: { start_date: startDate, end_date: endDate, branch_id: branchId || undefined, employee_id: employeeId || undefined }
    });
    if (error) setMessage(error.message);
    else {
      setMessage("Rango recalculado.");
      await query.refetch();
    }
  }

  async function exportExcel() {
    const { data, error } = await supabase.functions.invoke("export-attendance-excel", {
      body: {
        start_date: startDate,
        end_date: endDate,
        branch_id: branchId || undefined,
        department_id: departmentId || undefined,
        attendance_group_id: groupId || undefined,
        employee_id: employeeId || undefined,
        device_id: deviceId || undefined,
        status: status || undefined
      }
    });
    if (error) setMessage(error.message);
    else if (data?.signed_url) window.open(data.signed_url, "_blank", "noopener,noreferrer");
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Reporte por rango</Typography>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <TextField size="small" label="Inicio" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" label="Fin" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" select label="Sucursal" value={branchId} onChange={(event) => setBranchId(event.target.value)}><MenuItem value="">Todas</MenuItem>{lookups.data?.branches.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Departamento" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.departments.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Grupo asistencia" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.groups.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Empleado" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.employees.map((v) => <MenuItem key={v.id} value={v.id}>{v.full_name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Dispositivo" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.devices.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" label="Estado" value={status} onChange={(event) => setStatus(event.target.value)} />
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={recalculate}>Recalcular</Button>
        <Button startIcon={<FileDownloadIcon />} variant="contained" onClick={exportExcel}>Exportar</Button>
      </Stack>
      {message && <Alert severity={message.includes("recalculado") ? "success" : "error"}>{message}</Alert>}
      {query.isLoading && <LinearProgress />}
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Departamento</TableCell><TableCell>Grupo de asistencia</TableCell><TableCell>Nombre</TableCell><TableCell>Fecha</TableCell>
              <TableCell>Hora real del registro de entrada</TableCell><TableCell>Hora real de registro de salida</TableCell><TableCell>Grabación de asistencia</TableCell><TableCell>Duración de la pausa</TableCell><TableCell>Registros de descansos</TableCell><TableCell>Periodo de tiempo</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{lookups.data?.departments.find((v) => v.id === row.employees?.department_id)?.name ?? ""}</TableCell><TableCell>{lookups.data?.groups.find((v) => v.id === row.employees?.attendance_group_id)?.name ?? ""}</TableCell><TableCell>{row.employees?.full_name ?? row.employee_id}</TableCell><TableCell>{row.attendance_date}</TableCell>
                <TableCell>{formatGt(row.actual_check_in)}</TableCell><TableCell>{formatGt(row.actual_check_out)}</TableCell><TableCell>{row.actual_check_in || row.actual_check_out ? `${formatGt(row.actual_check_in)} / ${formatGt(row.actual_check_out)}` : "Ninguno"}</TableCell><TableCell>{row.lunch_minutes ?? 0} min</TableCell><TableCell>{formatBreaks(row.break_records)}</TableCell><TableCell>{Math.round((row.worked_minutes ?? 0) / 60 * 100) / 100} h</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

const formatGt = (value?: string | null) => value ? new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date(value)) : "Ninguno";
const formatBreaks = (value: unknown) => Array.isArray(value) && value.length ? value.map((item) => `${formatGt(item?.out)} - ${formatGt(item?.in)} (${item?.minutes ?? 0} min)`).join("; ") : "-";
