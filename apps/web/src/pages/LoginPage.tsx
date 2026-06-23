import { FormEvent, useState } from "react";
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { Navigate } from "react-router-dom";
import { useSession } from "../hooks/useSession";
import { supabase } from "../lib/supabase";

export function LoginPage() {
  const { session } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", bgcolor: "background.default", p: 2 }}>
      <Paper sx={{ width: "100%", maxWidth: 420, p: 4 }}>
        <Stack component="form" spacing={2.5} onSubmit={submit}>
          <Box>
            <Typography variant="h4">Iniciar sesion</Typography>
            <Typography color="text.secondary">Usa Supabase Auth para entrar al sistema.</Typography>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Correo" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <TextField label="Contrasena" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          <Button type="submit" variant="contained" size="large" disabled={loading}>
            Entrar
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
