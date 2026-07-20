import { Alert, LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function LiveEventsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["live-events"],
    refetchInterval: 30_000,
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

  useEffect(() => {
    const channel = supabase
      .channel("live-attendance-events")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "attendance_events" }, () => {
        void queryClient.invalidateQueries({ queryKey: ["live-events"] });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "attendance_events" }, () => {
        void queryClient.invalidateQueries({ queryKey: ["live-events"] });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient]);

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
              <TableCell>Latencia de ingreso</TableCell>
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
                <TableCell>{formatLatency(event.callback_received_at, event.ingested_at ?? event.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

function formatLatency(receivedAt?: string | null, ingestedAt?: string | null) {
  if (!receivedAt || !ingestedAt) return "-";
  const milliseconds = new Date(ingestedAt).getTime() - new Date(receivedAt).getTime();
  return Number.isFinite(milliseconds) ? `${Math.max(0, milliseconds)} ms` : "-";
}
