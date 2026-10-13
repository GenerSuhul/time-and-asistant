import { useState } from "react";
import AccessTimeRoundedIcon from "@mui/icons-material/AccessTimeRounded";
import CoffeeRoundedIcon from "@mui/icons-material/CoffeeRounded";
import ExitToAppRoundedIcon from "@mui/icons-material/ExitToAppRounded";
import LoginRoundedIcon from "@mui/icons-material/LoginRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from "@mui/material";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { useNavigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { invokeEdge } from "../lib/edgeFunction";
import { supabase } from "../lib/supabase";

const MOBILE_ADMIN_EMAIL = "it.agrisystem@gmail.com";
const AUTHORIZED_EMPLOYEE_NAME = "Gener Alexander Suhul Amador";

type AttendanceEventType = "check_in" | "check_out" | "lunch_out" | "lunch_in" | "break_out" | "break_in";

const EVENT_LABELS: Record<AttendanceEventType, string> = {
  check_in: "Entrada",
  check_out: "Salida",
  lunch_out: "Salida a almuerzo",
  lunch_in: "Entrada de almuerzo",
  break_out: "Salida a descanso",
  break_in: "Entrada de descanso"
};

type MobileMark = {
  mark_id: string;
  attendance_event_id: string;
  event_type: AttendanceEventType;
  occurred_at: string;
  attendance_date: string;
  duplicated: boolean;
};

export function MobileAttendancePage() {
  const navigate = useNavigate();
  const { session, loading } = useSession();
  const [lastMark, setLastMark] = useState<MobileMark | null>(null);
  const isAllowedEmail = session?.user.email?.trim().toLowerCase() === MOBILE_ADMIN_EMAIL;

  const mark = useMutation({
    mutationFn: (event_type: AttendanceEventType) => invokeEdge<MobileMark>("mobile-attendance-mark", {
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
          <Typography variant="body2" color="text.secondary">Esta página está disponible únicamente para el usuario autorizado.</Typography>
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
              <Typography variant="h5" fontWeight={800}>Marcación</Typography>
            </Box>
            <Box sx={{ width: 44, height: 44, borderRadius: 2, display: "grid", placeItems: "center", bgcolor: "primary.main", color: "primary.contrastText" }}>
              <AccessTimeRoundedIcon />
            </Box>
          </Stack>

          <Box sx={{ p: 2, borderRadius: 2, bgcolor: "#f7f7ff", border: "1px solid", borderColor: "#e3e4fa" }}>
            <Typography variant="body2" color="text.secondary">Usuario autorizado</Typography>
            <Typography variant="body1" fontWeight={700}>{AUTHORIZED_EMPLOYEE_NAME}</Typography>
          </Box>

          {mark.error && <Alert severity="error">{mark.error.message}</Alert>}
          {lastMark && (
            <Alert severity="success">
              {lastMark.duplicated ? `${EVENT_LABELS[lastMark.event_type]} ya registrada.` : `${EVENT_LABELS[lastMark.event_type]} registrada.`} {formattedLastMark}
            </Alert>
          )}

          <Stack spacing={1.5}>
            <Typography variant="subtitle2" color="text.secondary">Selecciona la marcación que deseas registrar</Typography>
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
            <Button
              variant="outlined"
              size="large"
              color="inherit"
              startIcon={<RestaurantRoundedIcon />}
              onClick={() => mark.mutate("lunch_out")}
              disabled={mark.isPending}
              sx={{ minHeight: 58, fontWeight: 800 }}
            >
              Marcar salida a almuerzo
            </Button>
            <Button
              variant="outlined"
              size="large"
              color="inherit"
              startIcon={<RestaurantRoundedIcon />}
              onClick={() => mark.mutate("lunch_in")}
              disabled={mark.isPending}
              sx={{ minHeight: 58, fontWeight: 800 }}
            >
              Marcar entrada de almuerzo
            </Button>
            <Button
              variant="outlined"
              size="large"
              color="inherit"
              startIcon={<CoffeeRoundedIcon />}
              onClick={() => mark.mutate("break_out")}
              disabled={mark.isPending}
              sx={{ minHeight: 58, fontWeight: 800 }}
            >
              Marcar salida a descanso
            </Button>
            <Button
              variant="outlined"
              size="large"
              color="inherit"
              startIcon={<CoffeeRoundedIcon />}
              onClick={() => mark.mutate("break_in")}
              disabled={mark.isPending}
              sx={{ minHeight: 58, fontWeight: 800 }}
            >
              Marcar entrada de descanso
            </Button>
          </Stack>

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
