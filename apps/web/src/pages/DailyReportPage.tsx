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
  Typography
} from "@mui/material";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { StatusChip } from "../components/StatusChip";
import { supabase } from "../lib/supabase";

export function DailyReportPage() {
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["daily-report", date, branchId, employeeId],
    queryFn: async () => {
      let request = supabase
        .from("daily_attendance")
        .select("*, employees:employee_id(full_name, employee_code), branches:branch_id(name), work_schedules:schedule_id(name)")
        .eq("attendance_date", date)
        .order("actual_check_in", { ascending: true });
      if (branchId) request = request.eq("branch_id", branchId);
      if (employeeId) request = request.eq("employee_id", employeeId);
      const { data, error } = await request;
      if (error) throw error;
      return data ?? [];
    }
  });

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
      body: { start_date: date, end_date: date, branch_id: branchId || undefined, employee_id: employeeId || undefined }
    });
    if (error) setMessage(error.message);
    else if (data?.signed_url) window.open(data.signed_url, "_blank", "noopener,noreferrer");
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Reporte diario</Typography>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <TextField size="small" label="Fecha" type="date" value={date} onChange={(event) => setDate(event.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" label="Branch ID" value={branchId} onChange={(event) => setBranchId(event.target.value)} />
        <TextField size="small" label="Employee ID" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} />
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
              <TableCell>Empleado</TableCell>
              <TableCell>Sucursal</TableCell>
              <TableCell>Fecha</TableCell>
              <TableCell>Entrada</TableCell>
              <TableCell>Salida almuerzo</TableCell>
              <TableCell>Entrada almuerzo</TableCell>
              <TableCell>Salida</TableCell>
              <TableCell>Trabajado</TableCell>
              <TableCell>Tarde</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell>Observaciones</TableCell>
              <TableCell>Eventos</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.employees?.full_name ?? row.employee_id}</TableCell>
                <TableCell>{row.branches?.name ?? ""}</TableCell>
                <TableCell>{row.attendance_date}</TableCell>
                <TableCell>{row.actual_check_in ?? ""}</TableCell>
                <TableCell>{row.lunch_out ?? ""}</TableCell>
                <TableCell>{row.lunch_in ?? ""}</TableCell>
                <TableCell>{row.actual_check_out ?? ""}</TableCell>
                <TableCell>{Math.round((row.worked_minutes ?? 0) / 60 * 100) / 100} h</TableCell>
                <TableCell>{row.late_minutes}</TableCell>
                <TableCell><StatusChip value={row.status} /></TableCell>
                <TableCell>{Array.isArray(row.warnings) ? row.warnings.join("; ") : ""}</TableCell>
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
