import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Grid2, Paper, Stack, TextField, Typography } from "@mui/material";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { displayName, useCurrentUserProfile } from "../hooks/useCurrentUserProfile";
import { supabase } from "../lib/supabase";

type ProfileForm = {
  full_name: string;
  email: string;
  password: string;
};

export function SettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUser = useCurrentUserProfile();
  const [form, setForm] = useState<ProfileForm>({ full_name: "", email: "", password: "" });
  const [saved, setSaved] = useState(false);
  const canManageAccess = (currentUser.data?.roles ?? []).some((role) => ["super_admin", "it_admin"].includes(role.key));

  useEffect(() => {
    if (!currentUser.data) return;
    setForm({
      full_name: displayName(currentUser.data),
      email: currentUser.data.profile?.email ?? currentUser.data.user.email ?? "",
      password: ""
    });
  }, [currentUser.data]);

  const saveProfile = useMutation({
    mutationFn: async () => {
      if (!currentUser.data) throw new Error("Sesion no encontrada");
      const cleanName = form.full_name.trim();
      const cleanEmail = form.email.trim();

      const authPayload: Parameters<typeof supabase.auth.updateUser>[0] = {
        data: { full_name: cleanName }
      };
      if (cleanEmail && cleanEmail !== currentUser.data.user.email) authPayload.email = cleanEmail;
      if (form.password) {
        if (form.password.length < 8) throw new Error("La nueva contrasena debe tener minimo 8 caracteres.");
        authPayload.password = form.password;
      }

      const { error: authError } = await supabase.auth.updateUser(authPayload);
      if (authError) throw authError;

      const { error: profileError } = await supabase.from("profiles").upsert({
        id: currentUser.data.user.id,
        email: cleanEmail,
        full_name: cleanName,
        status: currentUser.data.profile?.status ?? "active",
        company_id: currentUser.data.profile?.company_id ?? null
      });
      if (profileError) throw profileError;
    },
    onSuccess: async () => {
      setSaved(true);
      setForm((current) => ({ ...current, password: "" }));
      await queryClient.invalidateQueries({ queryKey: ["current-user-profile"] });
      await queryClient.invalidateQueries({ queryKey: ["users-admin"] });
    }
  });

  return (
    <Stack spacing={2.2}>
      <Box>
        <Typography variant="h4">Mi perfil</Typography>
        <Typography color="text.secondary">Administra tus datos personales y revisa tus permisos reales.</Typography>
      </Box>

      {currentUser.error && <Alert severity="error">{currentUser.error.message}</Alert>}
      {saveProfile.error && <Alert severity="error">{saveProfile.error.message}</Alert>}
      {saved && <Alert severity="success" onClose={() => setSaved(false)}>Perfil actualizado.</Alert>}

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, md: 7 }}>
          <Paper variant="outlined" sx={{ p: 2.25, boxShadow: "none" }}>
            <Stack spacing={1.8}>
              <Typography variant="h6">Datos de cuenta</Typography>
              <TextField
                label="Nombre visible"
                value={form.full_name}
                onChange={(event) => setForm((current) => ({ ...current, full_name: event.target.value }))}
                fullWidth
                required
              />
              <TextField
                label="Correo"
                type="email"
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                fullWidth
                required
                helperText="Cambiar correo puede requerir confirmacion por email segun Supabase Auth."
              />
              <TextField
                label="Nueva contrasena"
                type="password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                fullWidth
                helperText="Opcional. Dejala vacia si no deseas cambiarla."
              />
              <Button variant="contained" onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending || !form.full_name.trim() || !form.email.trim()}>
                Guardar cambios
              </Button>
            </Stack>
          </Paper>
        </Grid2>

        <Grid2 size={{ xs: 12, md: 5 }}>
          <Paper variant="outlined" sx={{ p: 2.25, boxShadow: "none", height: "100%" }}>
            <Stack spacing={1.5}>
              <Typography variant="h6">Permisos asignados</Typography>
              <Stack direction="row" spacing={0.8} flexWrap="wrap" useFlexGap>
                {(currentUser.data?.roles ?? []).length === 0 ? (
                  <Typography color="text.secondary">No tienes roles asignados.</Typography>
                ) : (
                  currentUser.data?.roles.map((role) => (
                    <Chip key={`${role.id}-${role.company_id ?? "global"}`} label={`${role.name}${role.company_name ? ` - ${role.company_name}` : ""}`} variant="outlined" />
                  ))
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary">
                Estos permisos vienen de la tabla `user_roles`. Para cambiar roles globales o de otros usuarios usa el modulo Usuarios y roles.
              </Typography>
              {canManageAccess && (
                <Button variant="outlined" onClick={() => navigate("/users")} sx={{ alignSelf: "flex-start" }}>
                  Administrar usuarios y roles
                </Button>
              )}
            </Stack>
          </Paper>
        </Grid2>
      </Grid2>
    </Stack>
  );
}
