import { Alert, Box, Grid2, Paper, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { supabase } from "../lib/supabase";

function SettingCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.25, height: "100%", boxShadow: "none" }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
}

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
    <Stack spacing={2.2}>
      <Box>
        <Typography variant="h4">Configuracion</Typography>
        <Typography color="text.secondary">Sesion, seguridad y reglas basicas de produccion.</Typography>
      </Box>

      <Alert severity="info" variant="outlined">
        Produccion inicia sin datos demo automaticos. Los datos de prueba van en scripts separados de desarrollo.
      </Alert>

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, md: 6 }}>
          <SettingCard title="Sesion">
            <Stack spacing={0.6}>
              <Typography color="text.secondary">Usuario: {profile.data?.user.email ?? "-"}</Typography>
              <Typography color="text.secondary">Perfil: {profile.data?.profile?.full_name ?? "-"}</Typography>
            </Stack>
          </SettingCard>
        </Grid2>
        <Grid2 size={{ xs: 12, md: 6 }}>
          <SettingCard title="Seguridad">
            <Typography color="text.secondary">
              El frontend usa solo variables publicas de Vite. Service role vive en gateway y Edge Functions.
            </Typography>
          </SettingCard>
        </Grid2>
      </Grid2>
    </Stack>
  );
}
