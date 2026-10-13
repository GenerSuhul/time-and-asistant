import { useState } from "react";
import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";
import ExitToAppRoundedIcon from "@mui/icons-material/ExitToAppRounded";
import LoginRoundedIcon from "@mui/icons-material/LoginRounded";
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { invokeEdge } from "../lib/edgeFunction";
import { supabase } from "../lib/supabase";

const MOBILE_ADMIN_EMAIL = "it.agrisystem@gmail.com";

type MobileMark = {
  mark_id: string;
  attendance_event_id: string;
  event_type: "check_in" | "check_out";
  occurred_at: string;
  attendance_date: string;
  duplicated: boolean;
  source: "mobile_web";
  physical_hikvision_event: false;
};

export function MobileAttendancePage() {
  const navigate = useNavigate();
  const { session, loading } = useSession();
  const [lastMark, setLastMark] = useState<MobileMark | null>(null);
  const isAllowedEmail = session?.user.email?.trim().toLowerCase() === MOBILE_ADMIN_EMAIL;

  const mark = useMutation({
    mutationFn: (event_type: MobileMark["event_type"]) => invokeEdge<MobileMark>("mobile-attendance-mark", {
      event_type,
      idempotency_key: crypto.randomUUID()
    }),
    onSuccess: (result) => setLastMark(result)
  });

  if (loading) {
    return <Box sx={{ minHeight: "100dvh", display: "grid", placeItems: "center" }}><CircularProgress /></Box>;
  }

  if (!session || !isAllowedEmail) {
    return (
      <Box sx={{ minHeight: "100dvh", display: "grid", placeItems: "center", p: 2, bgcolor: "#f7f8fc" }}>
        <Paper sx={{ width: "min(420px, 100%)", p: 3, textAlign: "center" }}>
          <Typography variant="h6" gutterBottom>Acceso restringido</Typography>
          <Typography variant="body2" color="text.secondary">Esta página de marcación móvil está disponible únicamente para el administrador autorizado.</Typography>
          <Button sx={{ mt: 2 }} variant="outlined" onClick={() => navigate("/login", { replace: true })}>Iniciar sesión</Button>
        </Paper>
      </Box>
    );
  }

  const formattedLastMark = lastMark
    ? format(new Date(lastMark.occurred_at), "EEEE d 'de' MMMM, HH:mm:ss", { locale: es })
    : null;

  return (
    <Box
      sx={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        p: { xs: 2, sm: 3 },
        bgcolor: "#f4f5fb",
        background: "radial-gradient(circle at 15% 0%, rgba(99, 102, 241, 0.22), transparent 35%), #f4f5fb"
      }}
    >
      <Paper elevation={0} sx={{ width: "min(460px, 100%)", overflow: "hidden", border: "1px solid", borderColor: "divider", borderRadius: 3 }}>
        <Stack spacing={3} sx={{ p: { xs: 2.5, sm: 3.5 } }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Box>
              <Typography variant="overline" color="primary.main" fontWeight={800}>RENOVAGT ACCESS</Typography>
              <Typography variant="h5" fontWeight={800}>Marcación móvil</Typography>
            </Box>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, display: "grid", placeItems: "center", bgcolor: "primary.main", color: "primary.contrastText" }}>
              <AccessTimeRoundedIcon />
            </Box>
          </Stack>

          <Box sx={{ p: 2, borderRadius: 2, bgcolor: "#f7f7ff", border: "1px solid", borderColor: "#e3e4fa" }}>
            <Typography variant="body2" color="text.secondary">Sesión autorizada</Typography>
            <Typography variant="body1" fontWeight={700}>{MOBILE_ADMIN_EMAIL}</Typography>
          </Box>

          {mark.error && <Alert severity="error">{mark.error.message}</Alert>}
          {lastMark && (
            <Alert severity="success">
              {lastMark.duplicated ? "La marcación ya estaba registrada." : "Marcación registrada."} {formattedLastMark}
            </Alert>
          )}

          <Stack spacing={1.5}>
            <Button
              variant="contained"
              size="large"
              startIcon={<LoginRoundedIcon />}
              onClick={() => mark.mutate("check_in")}
              disabled={mark.isPending}
              sx={{ minHeight: 58, fontWeight: 800 }}
            >
              {mark.isPending ? "Registrando…" : "Marcar entrada"}
            </Button>
            <Button
              variant="outlined"
              size="large"
              color="inherit"
              startIcon={<ExitToAppRoundedIcon />}
              onClick={() => mark.mutate("check_out")}
              disabled={mark.isPending}
              sx={{ minHeight: 58, fontWeight: 800 }}
            >
              Marcar salida
            </Button>
          </Stack>

          <Typography variant="caption" color="text.secondary" textAlign="center">
            La marca queda auditada como marcación móvil. No representa un evento físico de un lector Hikvision.
          </Typography>

          <Button
            size="small"
            color="inherit"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate("/login", { replace: true });
            }}
          >
            Cerrar sesión
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
