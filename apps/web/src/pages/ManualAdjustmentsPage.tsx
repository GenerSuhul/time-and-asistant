import { useState } from "react";
import { Alert, Button, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { StatusChip } from "../components/StatusChip";
import { supabase } from "../lib/supabase";

const eventTypes = ["check_in", "lunch_out", "lunch_in", "check_out", "break_out", "break_in"];

export function ManualAdjustmentsPage() {
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [attendanceDate, setAttendanceDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [occurredAt, setOccurredAt] = useState("");
  const [eventType, setEventType] = useState("check_in");
  const [reason, setReason] = useState("");

  const query = useQuery({
    queryKey: ["manual-adjustments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("manual_adjustments")
        .select("*, employees:employee_id(full_name)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    }
  });

  const createAdjustment = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("manual_adjustments").insert({
        employee_id: employeeId,
        branch_id: branchId || null,
        attendance_date: attendanceDate,
        occurred_at: occurredAt,
        event_type: eventType,
        reason,
        status: "pending"
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["manual-adjustments"] })
  });

  const approve = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("manual_adjustments").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["manual-adjustments"] });
    }
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Ajustes manuales</Typography>
      {(createAdjustment.error || approve.error) && <Alert severity="error">{createAdjustment.error?.message ?? approve.error?.message}</Alert>}
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
          <TextField size="small" label="Employee ID" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} />
          <TextField size="small" label="Branch ID" value={branchId} onChange={(event) => setBranchId(event.target.value)} />
          <TextField size="small" label="Fecha" type="date" value={attendanceDate} onChange={(event) => setAttendanceDate(event.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField size="small" label="Ocurrio en" type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField select size="small" label="Tipo" value={eventType} onChange={(event) => setEventType(event.target.value)}>
            {eventTypes.map((type) => <MenuItem key={type} value={type}>{type}</MenuItem>)}
          </TextField>
          <TextField size="small" label="Motivo" value={reason} onChange={(event) => setReason(event.target.value)} />
          <Button variant="contained" onClick={() => createAdjustment.mutate()} disabled={!employeeId || !occurredAt || !reason}>Crear</Button>
        </Stack>
      </Paper>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Fecha</TableCell>
              <TableCell>Empleado</TableCell>
              <TableCell>Tipo</TableCell>
              <TableCell>Ocurrio</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell>Motivo</TableCell>
              <TableCell>Acciones</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.attendance_date}</TableCell>
                <TableCell>{row.employees?.full_name ?? row.employee_id}</TableCell>
                <TableCell>{row.event_type}</TableCell>
                <TableCell>{row.occurred_at}</TableCell>
                <TableCell><StatusChip value={row.status} /></TableCell>
                <TableCell>{row.reason}</TableCell>
                <TableCell>
                  {row.status === "pending" && <Button size="small" onClick={() => approve.mutate(row.id)}>Aprobar</Button>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
