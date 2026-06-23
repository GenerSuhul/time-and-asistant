import { Alert, LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function LiveEventsPage() {
  const query = useQuery({
    queryKey: ["live-events"],
    refetchInterval: 5000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance_events")
        .select("*, employees:employee_id(full_name, employee_code), devices:device_id(name)")
        .order("occurred_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    }
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Eventos en vivo</Typography>
      {query.isLoading && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Fecha/hora</TableCell>
              <TableCell>Empleado</TableCell>
              <TableCell>Dispositivo</TableCell>
              <TableCell>Tipo</TableCell>
              <TableCell>Fuente</TableCell>
              <TableCell>Confianza</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((event) => (
              <TableRow key={event.id} hover>
                <TableCell>{event.occurred_at}</TableCell>
                <TableCell>{event.employees?.full_name ?? event.employee_id}</TableCell>
                <TableCell>{event.devices?.name ?? event.device_id}</TableCell>
                <TableCell>{event.event_type}</TableCell>
                <TableCell>{event.source}</TableCell>
                <TableCell>{event.confidence}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
