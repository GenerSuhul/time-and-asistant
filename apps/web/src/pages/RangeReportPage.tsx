import { useState } from "react";
import { Alert, Button, LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useQuery } from "@tanstack/react-query";
import { format, subDays } from "date-fns";
import { StatusChip } from "../components/StatusChip";
import { supabase } from "../lib/supabase";

export function RangeReportPage() {
  const [startDate, setStartDate] = useState(format(subDays(new Date(), 7), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [branchId, setBranchId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [status, setStatus] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["range-report", startDate, endDate, branchId, status],
    queryFn: async () => {
      let request = supabase
        .from("daily_attendance")
        .select("*, employees:employee_id(full_name, employee_code, department_id), branches:branch_id(name)")
        .gte("attendance_date", startDate)
        .lte("attendance_date", endDate)
        .order("attendance_date", { ascending: false });
      if (branchId) request = request.eq("branch_id", branchId);
      if (status) request = request.eq("status", status);
      const { data, error } = await request;
      if (error) throw error;
      return (data ?? []).filter((row) => !departmentId || row.employees?.department_id === departmentId);
    }
  });

  async function recalculate() {
    const { error } = await supabase.functions.invoke("recalculate-attendance-range", {
      body: { start_date: startDate, end_date: endDate, branch_id: branchId || undefined }
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
        <TextField size="small" label="Branch ID" value={branchId} onChange={(event) => setBranchId(event.target.value)} />
        <TextField size="small" label="Department ID" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} />
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
              <TableCell>Fecha</TableCell>
              <TableCell>Empleado</TableCell>
              <TableCell>Sucursal</TableCell>
              <TableCell>Entrada</TableCell>
              <TableCell>Salida</TableCell>
              <TableCell>Horas</TableCell>
              <TableCell>Extra</TableCell>
              <TableCell>Estado</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.attendance_date}</TableCell>
                <TableCell>{row.employees?.full_name ?? row.employee_id}</TableCell>
                <TableCell>{row.branches?.name ?? ""}</TableCell>
                <TableCell>{row.actual_check_in ?? ""}</TableCell>
                <TableCell>{row.actual_check_out ?? ""}</TableCell>
                <TableCell>{Math.round((row.worked_minutes ?? 0) / 60 * 100) / 100}</TableCell>
                <TableCell>{Math.round((row.overtime_minutes ?? 0) / 60 * 100) / 100}</TableCell>
                <TableCell><StatusChip value={row.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
