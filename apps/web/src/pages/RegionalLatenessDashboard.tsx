import { Alert, Grid2, LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUserProfile } from "../hooks/useCurrentUserProfile";
import { supabase } from "../lib/supabase";

type Summary = { today: number; week: number; month: number; branches: number; top: { employee_id: string; employee_name: string; tardanzas: number; minutos: number }[] };

export function RegionalLatenessDashboard() {
  const user = useCurrentUserProfile();
  const query = useQuery({
    queryKey: ["regional-lateness-dashboard", user.data?.user.id],
    enabled: Boolean(user.data),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("lateness_dashboard");
      if (error) throw error;
      return data as Summary;
    },
    refetchInterval: 60000
  });
  return <Stack spacing={2}>
    <Typography variant="h4">Dashboard</Typography>
    <Typography color="text.secondary">Tardanzas de tus tiendas asignadas · Hora de Guatemala</Typography>
    {query.isLoading && <LinearProgress />}
    {query.error && <Alert severity="error">{query.error.message}</Alert>}
    {query.data && <>
      {query.data.branches === 0 && <Alert severity="info">Aún no tienes tiendas activas asignadas. Solicita a tu administrador que revise tu alcance regional.</Alert>}
      <Grid2 container spacing={2}>
        {[["Tardanzas hoy", query.data.today], ["Tardanzas últimos 7 días", query.data.week], ["Tardanzas del mes", query.data.month], ["Sucursales asignadas", query.data.branches]].map(([label, count]) => <Grid2 key={label} size={{ xs: 12, sm: 6, lg: 3 }}><Paper sx={{ p: 2 }}><Typography>{label}</Typography><Typography variant="h3">{count}</Typography></Paper></Grid2>)}
      </Grid2>
      <Paper sx={{ p: 2, overflowX: "auto" }}>
        <Typography variant="h6">Empleados con más tardanzas este mes</Typography>
        <Table aria-label="Empleados con más tardanzas"><TableHead><TableRow><TableCell>Empleado</TableCell><TableCell align="right">Tardanzas</TableCell><TableCell align="right">Minutos tarde</TableCell></TableRow></TableHead><TableBody>
          {query.data.top.map((row) => <TableRow key={row.employee_id}><TableCell>{row.employee_name}</TableCell><TableCell align="right">{row.tardanzas}</TableCell><TableCell align="right">{row.minutos}</TableCell></TableRow>)}
          {!query.data.top.length && <TableRow><TableCell colSpan={3}>Sin tardanzas este mes.</TableCell></TableRow>}
        </TableBody></Table>
      </Paper>
    </>}
  </Stack>;
}
