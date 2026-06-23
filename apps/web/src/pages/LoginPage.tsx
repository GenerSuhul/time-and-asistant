import { FormEvent, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { Navigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { supabase } from "../lib/supabase";

export function LoginPage() {
  const { session } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mode, setMode] = useState("admin");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) setError(signInError.message);
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
        p: { xs: 2, md: 4 },
        bgcolor: "#111827",
        backgroundImage:
          "linear-gradient(130deg, rgba(15, 23, 42, 0.98), rgba(17, 24, 39, 0.88)), linear-gradient(90deg, rgba(20, 184, 166, 0.22) 1px, transparent 1px), linear-gradient(rgba(79, 70, 229, 0.16) 1px, transparent 1px)",
        backgroundSize: "auto, 72px 72px, 72px 72px",
        position: "relative",
        "&:before": {
          content: '""',
          position: "absolute",
          inset: "12% 0 auto 8%",
          width: "54vw",
          height: "54vh",
          border: "1px solid rgba(20, 184, 166, 0.22)",
          transform: "skewY(-8deg)",
          boxShadow: "0 0 80px rgba(20, 184, 166, 0.14)",
          background:
            "linear-gradient(135deg, rgba(20, 184, 166, 0.14), transparent 38%), linear-gradient(315deg, rgba(79, 70, 229, 0.16), transparent 42%)"
        }
      }}
    >
      <Paper
        elevation={0}
        sx={{
          width: "min(1120px, 100%)",
          minHeight: { md: 610 },
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "0.96fr 1.04fr" },
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,0.14)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.28)",
          position: "relative",
          zIndex: 1
        }}
      >
        <Box
          sx={{
            display: { xs: "none", md: "flex" },
            flexDirection: "column",
            justifyContent: "space-between",
            p: 5,
            color: "#ffffff",
            bgcolor: "#0f766e",
            background:
              "linear-gradient(145deg, rgba(15, 118, 110, 0.96), rgba(17, 24, 39, 0.96)), linear-gradient(120deg, rgba(255,255,255,0.12), transparent)",
            position: "relative"
          }}
        >
          <Stack spacing={5}>
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: 2,
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 900,
                  bgcolor: "rgba(255,255,255,0.14)",
                  border: "1px solid rgba(255,255,255,0.22)"
                }}
              >
                AC
              </Box>
              <Box>
                <Typography variant="h6">Renovagt Access</Typography>
                <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.72)" }}>
                  Asistencia y control de acceso
                </Typography>
              </Box>
            </Stack>

            <Box>
              <Typography variant="h4" sx={{ maxWidth: 390, mb: 1.25 }}>
                Operacion clara para tiendas, turnos y dispositivos.
              </Typography>
              <Typography sx={{ maxWidth: 430, color: "rgba(255,255,255,0.76)" }}>
                Plataforma productiva conectada a Supabase y al gateway. Sin datos demo automaticos.
              </Typography>
            </Box>

            <Stack spacing={1.5}>
              {["RLS activo y roles base", "Gateway HTTP en produccion", "SDK ISUP pendiente de librerias oficiales"].map((item) => (
                <Stack key={item} direction="row" spacing={1.25} alignItems="center">
                  <CheckCircleOutlineIcon fontSize="small" sx={{ color: "#5eead4" }} />
                  <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.82)" }}>
                    {item}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Stack>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 1.5,
              "& > div": {
                border: "1px solid rgba(255,255,255,0.13)",
                bgcolor: "rgba(255,255,255,0.08)",
                p: 1.5
              }
            }}
          >
            <Box>
              <Typography variant="h6">0</Typography>
              <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.64)" }}>
                datos demo
              </Typography>
            </Box>
            <Box>
              <Typography variant="h6">7660</Typography>
              <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.64)" }}>
                ISUP
              </Typography>
            </Box>
            <Box>
              <Typography variant="h6">24/7</Typography>
              <Typography variant="caption" sx={{ color: "rgba(255,255,255,0.64)" }}>
                monitoreo
              </Typography>
            </Box>
          </Box>
        </Box>

        <Stack
          component="form"
          spacing={2.4}
          onSubmit={submit}
          sx={{
            justifyContent: "center",
            p: { xs: 3, sm: 5, md: 7 },
            bgcolor: "#ffffff"
          }}
        >
          <Stack spacing={0.75}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
              <Box
                sx={{
                  width: 42,
                  height: 42,
                  borderRadius: 2,
                  display: { xs: "grid", md: "none" },
                  placeItems: "center",
                  fontWeight: 900,
                  color: "#ffffff",
                  background: "linear-gradient(135deg, #0f766e, #4f46e5)"
                }}
              >
                AC
              </Box>
              <TextField select size="small" defaultValue="es" sx={{ ml: "auto", width: 132 }}>
                <MenuItem value="es">Espanol</MenuItem>
              </TextField>
            </Stack>
            <Typography variant="overline" color="primary" sx={{ fontWeight: 900 }}>
              Hola
            </Typography>
            <Typography variant="h4">Inicia sesion</Typography>
            <Typography color="text.secondary">
              Entra al panel para operar empleados, dispositivos, comandos y asistencia.
            </Typography>
          </Stack>

          <Tabs value={mode} onChange={(_, value) => setMode(value)} sx={{ minHeight: 42 }}>
            <Tab value="admin" label="Administracion" sx={{ fontWeight: 800, minHeight: 42 }} />
            <Tab value="self" label="Autoservicio" sx={{ fontWeight: 800, minHeight: 42 }} />
          </Tabs>

          {mode === "self" && (
            <Alert severity="info">
              El autoservicio queda reservado para una siguiente fase. Usa Administracion para entrar.
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="Correo electronico"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            autoComplete="email"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <AccountCircleOutlinedIcon fontSize="small" />
                </InputAdornment>
              )
            }}
          />
          <TextField
            label="Contrasena"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            autoComplete="current-password"
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <LockOutlinedIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setShowPassword((current) => !current)} aria-label="mostrar contrasena">
                    {showPassword ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              )
            }}
          />

          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <FormControlLabel
              control={<Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)} />}
              label="Recordarme"
            />
            <Typography component="a" href="#" variant="body2" sx={{ color: "primary.main", textDecoration: "none", fontWeight: 800 }}>
              Olvide la contrasena
            </Typography>
          </Stack>

          <Button type="submit" variant="contained" size="large" disabled={loading || mode !== "admin"} sx={{ py: 1.35 }}>
            {loading ? "Ingresando..." : "Ingresar"}
          </Button>

          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{
              mt: 1,
              p: 1.5,
              bgcolor: (theme) => alpha(theme.palette.primary.main, 0.06),
              border: "1px solid",
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.15)
            }}
          >
            <ShieldOutlinedIcon color="primary" fontSize="small" />
            <Typography variant="body2" color="text.secondary">
              Produccion inicia limpia: estructura, roles, RLS, buckets y configuracion minima.
            </Typography>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
