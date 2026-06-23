import { Grid2, Paper, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

const metrics = [
  { label: "Empleados", table: "employees" },
  { label: "Dispositivos", table: "devices" },
  { label: "Eventos hoy", table: "attendance_events" },
  { label: "Comandos pendientes", table: "device_commands", filter: ["status", "pending"] as const }
];

export function DashboardPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const result: Record<string, number> = {};
      for (const metric of metrics) {
        let request = supabase.from(metric.table).select("id", { count: "exact", head: true });
        if (metric.filter) request = request.eq(metric.filter[0], metric.filter[1]);
        const { count, error } = await request;
        if (error) throw error;
        result[metric.label] = count ?? 0;
      }
      return result;
    }
  });

  return (
    <Stack spacing={3}>
      <Typography variant="h4">Dashboard</Typography>
      <Grid2 container spacing={2}>
        {metrics.map((metric) => (
          <Grid2 key={metric.label} size={{ xs: 12, sm: 6, md: 3 }}>
            <Paper sx={{ p: 2 }}>
              <Typography color="text.secondary">{metric.label}</Typography>
              <Typography variant="h4">{query.data?.[metric.label] ?? "-"}</Typography>
            </Paper>
          </Grid2>
        ))}
      </Grid2>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">Estado operativo</Typography>
        <Typography color="text.secondary">
          Produccion inicia sin datos demo. Configura compania, sucursales, horarios, empleados y dispositivos desde la UI.
        </Typography>
      </Paper>
    </Stack>
  );
}
