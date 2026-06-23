import { Alert, Paper, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function SettingsPage() {
  const profile = useQuery({
    queryKey: ["current-profile"],
    queryFn: async () => {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const { data, error } = await supabase.from("profiles").select("*").eq("id", userData.user.id).maybeSingle();
      if (error) throw error;
      return { user: userData.user, profile: data };
    }
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Configuracion general</Typography>
      <Alert severity="info">
        No hay datos demo automaticos. Crea la primera compania, sucursal, horarios, empleados y dispositivos desde la UI o mediante scripts controlados.
      </Alert>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">Sesion</Typography>
        <Typography color="text.secondary">Usuario: {profile.data?.user.email ?? "-"}</Typography>
        <Typography color="text.secondary">Perfil: {profile.data?.profile?.full_name ?? "-"}</Typography>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Typography variant="h6">Seguridad</Typography>
        <Typography color="text.secondary">
          El frontend usa solo VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. Service role vive en gateway y Edge Functions.
        </Typography>
      </Paper>
    </Stack>
  );
}
