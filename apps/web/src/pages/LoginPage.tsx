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
  TextField,
  Typography
} from "@mui/material";
import AccountCircleOutlinedIcon from "@mui/icons-material/AccountCircleOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
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
        p: { xs: 2, md: 4 },
        bgcolor: "#f4f5fb",
        background:
          "radial-gradient(circle at 14% 18%, rgba(196, 181, 253, 0.28), transparent 28%), radial-gradient(circle at 88% 8%, rgba(129, 140, 248, 0.18), transparent 24%)"
      }}
    >
      <Paper
        variant="outlined"
        sx={{
          width: "min(980px, 100%)",
          minHeight: { md: 580 },
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "0.88fr 1.12fr" },
          overflow: "hidden",
          borderColor: "#eef1f6",
          boxShadow: "0 28px 70px rgba(31, 41, 55, 0.08)"
        }}
      >
        <Box
          sx={{
            display: { xs: "none", md: "flex" },
            flexDirection: "column",
            justifyContent: "space-between",
            p: 4.5,
            bgcolor: "#fbfbfe",
            borderRight: "1px solid",
            borderColor: "divider"
          }}
        >
          <Stack spacing={1.2}>
            <Stack alignItems="flex-start" spacing={0.65}>
              <Typography sx={{ fontSize: 31, fontWeight: 800, lineHeight: 0.9, letterSpacing: -1.8, color: "#111217" }}>
                ac
              </Typography>
              <Box sx={{ width: 24, height: 3, borderRadius: 999, bgcolor: "primary.main" }} />
            </Stack>
            <Box>
              <Typography variant="h5">Renovagt Access</Typography>
              <Typography variant="body2" color="text.secondary">
                Control de asistencia y dispositivos.
              </Typography>
            </Box>
          </Stack>

          <Box
            sx={{
              border: "1px solid",
              borderColor: "divider",
              bgcolor: "#ffffff",
              p: 2.2
            }}
          >
            <Stack spacing={2}>
              <Stack direction="row" spacing={1.2}>
                {[42, 70, 54].map((height) => (
                  <Box key={height} sx={{ flex: 1, height, borderRadius: 2, bgcolor: "#f1f3f8" }} />
                ))}
              </Stack>
              <Box sx={{ height: 8, width: "86%", borderRadius: 999, bgcolor: "#edf0f6" }} />
              <Box sx={{ height: 8, width: "64%", borderRadius: 999, bgcolor: "#edf0f6" }} />
              <Box sx={{ height: 120, borderRadius: 2, bgcolor: "#f7f8fc", position: "relative", overflow: "hidden" }}>
                <Box sx={{ position: "absolute", left: 28, right: 28, bottom: 22, height: 2, bgcolor: "#dfe4ee" }} />
                {[20, 45, 34, 68, 48, 76].map((height, index) => (
                  <Box
                    key={`${height}-${index}`}
                    sx={{
                      position: "absolute",
                      left: 30 + index * 42,
                      bottom: 24,
                      width: 18,
                      height,
                      borderRadius: "8px 8px 0 0",
                      bgcolor: index === 5 ? "primary.main" : "#d8ddf8"
                    }}
                  />
                ))}
              </Box>
            </Stack>
          </Box>

          <Typography variant="caption" color="text.secondary">
            Renovagt, Guatemala
          </Typography>
        </Box>

        <Stack
          component="form"
          onSubmit={submit}
          spacing={2.2}
          sx={{
            justifyContent: "center",
            p: { xs: 3, sm: 5, md: 7 },
            bgcolor: "#ffffff"
          }}
        >
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
            <Stack spacing={0.45}>
              <Typography variant="h4">Iniciar sesion</Typography>
              <Typography variant="body2" color="text.secondary">
                Ingresa con tu usuario administrativo.
              </Typography>
            </Stack>
            <TextField select size="small" defaultValue="es" sx={{ width: 124 }}>
              <MenuItem value="es">Espanol</MenuItem>
            </TextField>
          </Stack>

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
              control={<Checkbox checked={remember} onChange={(event) => setRemember(event.target.checked)} size="small" />}
              label={<Typography variant="body2">Recordarme</Typography>}
            />
            <Typography component="a" href="#" variant="body2" sx={{ color: "primary.main", textDecoration: "none", fontWeight: 700 }}>
              Olvide la contrasena
            </Typography>
          </Stack>

          <Button type="submit" variant="contained" size="large" disabled={loading} sx={{ py: 1.2 }}>
            {loading ? "Ingresando..." : "Ingresar"}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
