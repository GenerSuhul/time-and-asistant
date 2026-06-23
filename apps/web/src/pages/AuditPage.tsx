import { LinearProgress, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function AuditPage() {
  const query = useQuery({
    queryKey: ["audit"],
    queryFn: async () => {
      const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data ?? [];
    }
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Auditoria</Typography>
      {query.isLoading && <LinearProgress />}
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Fecha</TableCell>
              <TableCell>Usuario</TableCell>
              <TableCell>Accion</TableCell>
              <TableCell>Tabla</TableCell>
              <TableCell>Registro</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data ?? []).map((row) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.created_at}</TableCell>
                <TableCell>{row.actor_user_id ?? ""}</TableCell>
                <TableCell>{row.action}</TableCell>
                <TableCell>{row.table_name}</TableCell>
                <TableCell>{row.record_id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
