import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid2,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusChip } from "../components/StatusChip";
import { supabase, supabaseFunctionUrl, supabasePublicAnonKey } from "../lib/supabase";

type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
};

type Company = {
  id: string;
  name: string;
};

type Profile = {
  id: string;
  email: string | null;
  full_name: string | null;
  status: string;
  company_id: string | null;
  companies?: Company | null;
};

type Assignment = {
  id: string;
  user_id: string;
  company_id: string | null;
  roles: Role | Role[] | null;
  companies?: Company | null;
};

type UserRow = Profile & {
  roleAssignments: Assignment[];
};

type UserForm = {
  id: string;
  email: string;
  password: string;
  full_name: string;
  status: string;
  company_id: string;
  role_company_id: string;
  role_ids: string[];
};

const emptyForm: UserForm = {
  id: "",
  email: "",
  password: "",
  full_name: "",
  status: "active",
  company_id: "",
  role_company_id: "",
  role_ids: []
};

function normalizeRole(value: Role | Role[] | null) {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function roleDescription(roleKey: string) {
  const descriptions: Record<string, string> = {
    super_admin: "Acceso completo al sistema, usuarios y configuracion.",
    it_admin: "Administracion tecnica, dispositivos, comandos y gateway.",
    hr_admin: "Gestion de empleados, asistencia y reportes.",
    branch_manager: "Visibilidad operativa por sucursal.",
    viewer: "Solo lectura."
  };
  return descriptions[roleKey] ?? "Rol operativo del sistema.";
}

export function UsersPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);

  const query = useQuery({
    queryKey: ["users-admin"],
    queryFn: async () => {
      const [profilesResult, rolesResult, companiesResult, assignmentsResult] = await Promise.all([
        supabase.from("profiles").select("id,email,full_name,status,company_id,companies:company_id(id,name)").order("created_at", { ascending: false }),
        supabase.from("roles").select("id,key,name,description").order("name", { ascending: true }),
        supabase.from("companies").select("id,name").order("name", { ascending: true }),
        supabase.from("user_roles").select("id,user_id,company_id,roles:role_id(id,key,name,description),companies:company_id(id,name)").order("created_at", { ascending: true })
      ]);

      if (profilesResult.error) throw profilesResult.error;
      if (rolesResult.error) throw rolesResult.error;
      if (companiesResult.error) throw companiesResult.error;
      if (assignmentsResult.error) throw assignmentsResult.error;

      const assignmentsByUser = ((assignmentsResult.data ?? []) as unknown as Assignment[]).reduce<Record<string, Assignment[]>>((acc, assignment) => {
        acc[assignment.user_id] = [...(acc[assignment.user_id] ?? []), assignment];
        return acc;
      }, {});

      return {
        users: ((profilesResult.data ?? []) as unknown as Profile[]).map((profile) => ({
          ...profile,
          roleAssignments: assignmentsByUser[profile.id] ?? []
        })),
        roles: (rolesResult.data ?? []) as Role[],
        companies: (companiesResult.data ?? []) as Company[]
      };
    }
  });

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        action: editing ? "update_user" : "create_user",
        email: form.email.trim(),
        full_name: form.full_name.trim(),
        status: form.status,
        company_id: form.company_id || null,
        role_company_id: form.role_company_id || null,
        role_ids: form.role_ids
      };
      if (editing) {
        body.user_id = editing.id;
      } else {
        body.password = form.password;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Sesion expirada. Vuelve a iniciar sesion.");

      const response = await fetch(`${supabaseFunctionUrl}/admin-users`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabasePublicAnonKey,
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok || data?.error) {
        throw new Error(data?.error ?? `Error ${response.status} al guardar usuario`);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["users-admin"] });
      setOpen(false);
    }
  });

  function startCreate() {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  }

  function toggleRole(roleId: string) {
    setForm((current) => ({
      ...current,
      role_ids: current.role_ids.includes(roleId)
        ? current.role_ids.filter((id) => id !== roleId)
        : [...current.role_ids, roleId]
    }));
  }

  function startEdit(user: UserRow) {
    const firstAssignment = user.roleAssignments[0];
    setEditing(user);
    setForm({
      id: user.id,
      email: user.email ?? "",
      password: "",
      full_name: user.full_name ?? "",
      status: user.status ?? "active",
      company_id: user.company_id ?? "",
      role_company_id: firstAssignment?.company_id ?? "",
      role_ids: user.roleAssignments.map((assignment) => normalizeRole(assignment.roles)?.id).filter(Boolean) as string[]
    });
    setOpen(true);
  }

  return (
    <Stack spacing={2.2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h4">Usuarios y roles</Typography>
          <Typography color="text.secondary">Administra accesos, perfiles y permisos operativos.</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <IconButton onClick={() => query.refetch()} aria-label="refrescar usuarios">
            <RefreshIcon />
          </IconButton>
          <Button variant="contained" startIcon={<AddIcon />} onClick={startCreate}>
            Nuevo usuario
          </Button>
        </Stack>
      </Stack>

      {query.isLoading && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}
      {save.error && <Alert severity="error">{save.error.message}</Alert>}

      <TableContainer component={Paper} variant="outlined" sx={{ boxShadow: "none" }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Usuario</TableCell>
              <TableCell>Empresa</TableCell>
              <TableCell>Roles</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell align="right">Acciones</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data?.users ?? []).map((user) => (
              <TableRow key={user.id} hover>
                <TableCell>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {user.full_name || "Sin nombre"}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {user.email}
                  </Typography>
                </TableCell>
                <TableCell>{user.companies?.name ?? "Global"}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.7} flexWrap="wrap" useFlexGap>
                    {user.roleAssignments.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">Sin roles</Typography>
                    ) : (
                      user.roleAssignments.map((assignment) => {
                        const role = normalizeRole(assignment.roles);
                        return <Chip key={assignment.id} size="small" label={role?.name ?? "Rol"} variant="outlined" />;
                      })
                    )}
                  </Stack>
                </TableCell>
                <TableCell><StatusChip value={user.status} /></TableCell>
                <TableCell align="right">
                  <IconButton size="small" onClick={() => startEdit(user)} aria-label="editar usuario">
                    <EditIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{editing ? "Editar usuario" : "Nuevo usuario"}</DialogTitle>
        <DialogContent>
          <Grid2 container spacing={1.8} sx={{ pt: 1 }}>
            <Grid2 size={{ xs: 12, md: 6 }}>
              <TextField
                label="Correo"
                type="email"
                required
                fullWidth
                value={form.email}
                onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              />
            </Grid2>
            <Grid2 size={{ xs: 12, md: 6 }}>
              <TextField
                label="Nombre completo"
                required
                fullWidth
                value={form.full_name}
                onChange={(event) => setForm((current) => ({ ...current, full_name: event.target.value }))}
              />
            </Grid2>
            {!editing && (
              <Grid2 size={{ xs: 12, md: 6 }}>
                <TextField
                  label="Contrasena temporal"
                  type="password"
                  required
                  fullWidth
                  value={form.password}
                  helperText="Minimo 8 caracteres. El usuario puede cambiarla luego."
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                />
              </Grid2>
            )}
            <Grid2 size={{ xs: 12, md: 6 }}>
              <TextField
                select
                label="Estado"
                fullWidth
                value={form.status}
                onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}
              >
                {["active", "inactive", "suspended"].map((status) => (
                  <MenuItem key={status} value={status}>{status}</MenuItem>
                ))}
              </TextField>
            </Grid2>
            <Grid2 size={{ xs: 12, md: 6 }}>
              <TextField
                select
                label="Empresa principal"
                fullWidth
                value={form.company_id}
                onChange={(event) => setForm((current) => ({ ...current, company_id: event.target.value }))}
              >
                <MenuItem value="">Global</MenuItem>
                {(query.data?.companies ?? []).map((company) => (
                  <MenuItem key={company.id} value={company.id}>{company.name}</MenuItem>
                ))}
              </TextField>
            </Grid2>
            <Grid2 size={{ xs: 12, md: 6 }}>
              <TextField
                select
                label="Alcance de roles"
                fullWidth
                value={form.role_company_id}
                helperText="Global aplica a todas las empresas."
                onChange={(event) => setForm((current) => ({ ...current, role_company_id: event.target.value }))}
              >
                <MenuItem value="">Global</MenuItem>
                {(query.data?.companies ?? []).map((company) => (
                  <MenuItem key={company.id} value={company.id}>{company.name}</MenuItem>
                ))}
              </TextField>
            </Grid2>
            <Grid2 size={{ xs: 12 }}>
              <Stack spacing={1}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    Roles *
                  </Typography>
                  <Typography variant="caption" color={form.role_ids.length === 0 ? "error" : "text.secondary"}>
                    {form.role_ids.length === 0 ? "Selecciona al menos un rol" : `${form.role_ids.length} seleccionado(s)`}
                  </Typography>
                </Stack>
                <Grid2 container spacing={1.2}>
                  {(query.data?.roles ?? []).map((role) => {
                    const checked = form.role_ids.includes(role.id);
                    return (
                      <Grid2 key={role.id} size={{ xs: 12, md: 6 }}>
                        <Paper
                          variant="outlined"
                          onClick={() => toggleRole(role.id)}
                          sx={{
                            p: 1.4,
                            cursor: "pointer",
                            boxShadow: "none",
                            borderColor: checked ? "primary.main" : "divider",
                            bgcolor: checked ? "rgba(79, 70, 229, 0.06)" : "#ffffff"
                          }}
                        >
                          <Stack direction="row" spacing={1} alignItems="flex-start">
                            <Checkbox checked={checked} onChange={() => toggleRole(role.id)} onClick={(event) => event.stopPropagation()} size="small" />
                            <Box sx={{ minWidth: 0 }}>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {role.name}
                              </Typography>
                              <Typography variant="caption" color="text.secondary">
                                {role.description || roleDescription(role.key)}
                              </Typography>
                            </Box>
                          </Stack>
                        </Paper>
                      </Grid2>
                    );
                  })}
                </Grid2>
              </Stack>
            </Grid2>
            <Grid2 size={{ xs: 12 }}>
              <FormControlLabel
                control={<Checkbox checked disabled size="small" />}
                label={<Typography variant="body2">Enviar cambios mediante Edge Function segura con service role.</Typography>}
              />
            </Grid2>
          </Grid2>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
          <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending || (!editing && form.password.length < 8) || form.role_ids.length === 0}>
            Guardar
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
