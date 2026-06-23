import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Grid2,
  IconButton,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ReactNode } from "react";
import BadgeIcon from "@mui/icons-material/Badge";
import DevicesIcon from "@mui/icons-material/Devices";
import EventAvailableIcon from "@mui/icons-material/EventAvailable";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonSearchIcon from "@mui/icons-material/PersonSearch";
import RefreshIcon from "@mui/icons-material/Refresh";
import SettingsInputAntennaIcon from "@mui/icons-material/SettingsInputAntenna";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import TuneIcon from "@mui/icons-material/Tune";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useQuery } from "@tanstack/react-query";
import { Link as RouterLink } from "react-router-dom";
import { StatusChip } from "../components/StatusChip";
import { supabase } from "../lib/supabase";

type RecentEvent = {
  id: string;
  occurred_at: string;
  event_type: string;
  employees?: { full_name?: string | null; employee_code?: string | null } | null;
  devices?: { name?: string | null } | null;
};

type RecentCommand = {
  id: string;
  created_at: string;
  command_type: string;
  status: string;
  attempts: number;
  devices?: { name?: string | null } | null;
};

type DashboardData = {
  employees: number;
  activeEmployees: number;
  cards: number;
  fingerprints: number;
  faces: number;
  devices: number;
  onlineDevices: number;
  offlineDevices: number;
  errorDevices: number;
  todayEvents: number;
  pendingCommands: number;
  attendanceByStatus: Record<string, number>;
  recentEvents: RecentEvent[];
  recentCommands: RecentCommand[];
};

const attendanceLabels: Record<string, string> = {
  complete: "Normal",
  late: "Tarde",
  incomplete: "Incompleto",
  absent: "Ausente",
  early_leave: "Salida temp.",
  day_off: "Descanso",
  holiday: "Feriado",
  leave: "Permiso",
  error: "Error"
};

const attendancePalette: Record<string, string> = {
  complete: "#4f46e5",
  late: "#f59e0b",
  incomplete: "#6366f1",
  absent: "#ef4444",
  early_leave: "#fb923c",
  day_off: "#94a3b8",
  holiday: "#38bdf8",
  leave: "#8b5cf6",
  error: "#dc2626"
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function todayStartIso() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

type CountRequest = any;

async function countRows(table: string, build?: (request: CountRequest) => CountRequest) {
  let request = supabase.from(table).select("id", { count: "exact", head: true });
  if (build) request = build(request);
  const { count, error } = await request;
  if (error) throw error;
  return count ?? 0;
}

async function getDashboardData(): Promise<DashboardData> {
  const today = todayKey();
  const startIso = todayStartIso();

  const [
    employees,
    activeEmployees,
    cards,
    fingerprints,
    faces,
    devices,
    onlineDevices,
    offlineDevices,
    errorDevices,
    todayEvents,
    pendingCommands,
    attendance,
    recentEvents,
    recentCommands
  ] = await Promise.all([
    countRows("employees"),
    countRows("employees", (request) => request.eq("status", "active")),
    countRows("employees", (request) => request.not("card_number", "is", null)),
    countRows("employees", (request) => request.gt("fingerprint_count", 0)),
    countRows("employees", (request) => request.eq("face_status", "enrolled")),
    countRows("devices"),
    countRows("devices", (request) => request.eq("status", "online")),
    countRows("devices", (request) => request.eq("status", "offline")),
    countRows("devices", (request) => request.eq("status", "error")),
    countRows("attendance_events", (request) => request.gte("occurred_at", startIso)),
    countRows("device_commands", (request) => request.eq("status", "pending")),
    supabase.from("daily_attendance").select("status").eq("attendance_date", today),
    supabase
      .from("attendance_events")
      .select("id,occurred_at,event_type,employees:employee_id(full_name,employee_code),devices:device_id(name)")
      .order("occurred_at", { ascending: false })
      .limit(6),
    supabase
      .from("device_commands")
      .select("id,created_at,command_type,status,attempts,devices:device_id(name)")
      .order("created_at", { ascending: false })
      .limit(5)
  ]);

  if (attendance.error) throw attendance.error;
  if (recentEvents.error) throw recentEvents.error;
  if (recentCommands.error) throw recentCommands.error;

  const attendanceByStatus = (attendance.data ?? []).reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    employees,
    activeEmployees,
    cards,
    fingerprints,
    faces,
    devices,
    onlineDevices,
    offlineDevices,
    errorDevices,
    todayEvents,
    pendingCommands,
    attendanceByStatus,
    recentEvents: (recentEvents.data ?? []) as RecentEvent[],
    recentCommands: (recentCommands.data ?? []) as RecentCommand[]
  };
}

function formatNumber(value?: number) {
  if (value === undefined) return "-";
  return new Intl.NumberFormat("es-GT").format(value);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("es-GT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function Panel({ children, title, action }: { children: ReactNode; title: string; action?: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.25, height: "100%", boxShadow: "none", borderColor: "#eaedf3" }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ mb: 2.2 }}>
        <Typography variant="h6">{title}</Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}

function MetricCard({
  icon,
  label,
  value,
  helper,
  color,
  progress
}: {
  icon: ReactNode;
  label: string;
  value?: number;
  helper: string;
  color: string;
  progress: number;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2.25, minHeight: 154, overflow: "hidden", position: "relative", boxShadow: "none", borderColor: "#eaedf3" }}>
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Box
          sx={{
            position: "absolute",
            top: 18,
            right: 18,
            width: 34,
            height: 34,
            borderRadius: 2.2,
            display: "grid",
            placeItems: "center",
            color,
            bgcolor: alpha(color, 0.08)
          }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, pr: 5 }}>
          <Typography color="text.secondary" variant="body2" sx={{ fontWeight: 600 }}>
            {label}
          </Typography>
          <Typography variant="h4" sx={{ mt: 1, mb: 0.5 }}>
            {formatNumber(value)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {helper}
          </Typography>
        </Box>
      </Stack>
      <Box sx={{ mt: 2.4, height: 6, borderRadius: 999, bgcolor: "#eef1f6", overflow: "hidden" }}>
        <Box sx={{ width: `${Math.min(Math.max(progress, 0), 100)}%`, height: "100%", bgcolor: color, borderRadius: 999 }} />
      </Box>
    </Paper>
  );
}

function StatusRing({ label, value, total, color, helper }: { label: string; value: number; total: number; color: string; helper: string }) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      <Box
        sx={{
          width: 74,
          height: 74,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: `conic-gradient(${color} ${percent * 3.6}deg, #e5e7eb 0deg)`
        }}
      >
        <Box
          sx={{
            width: 52,
            height: 52,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            bgcolor: "#ffffff",
            fontSize: 12,
            fontWeight: 700
          }}
        >
          {percent}%
        </Box>
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="subtitle1">{label}</Typography>
        <Typography variant="body2" color="text.secondary">
          {formatNumber(value)} de {formatNumber(total)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {helper}
        </Typography>
      </Box>
    </Stack>
  );
}

function EmptyState({ title, body, to, action }: { title: string; body: string; to: string; action: string }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.3} sx={{ minHeight: 188, textAlign: "center", color: "text.secondary" }}>
      <Box sx={{ width: 46, height: 46, borderRadius: 2.2, display: "grid", placeItems: "center", bgcolor: "#f6f7fb", color: "#9aa0aa" }}>
        <TaskAltIcon />
      </Box>
      <Box>
        <Typography variant="subtitle1" color="text.primary">
          {title}
        </Typography>
        <Typography variant="body2" sx={{ maxWidth: 320 }}>
          {body}
        </Typography>
      </Box>
      <Button component={RouterLink} to={to} variant="outlined" size="small" sx={{ color: "text.primary" }}>
        {action}
      </Button>
    </Stack>
  );
}

export function DashboardPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboardData,
    refetchInterval: 15000
  });

  const data = query.data;
  const totalAttendance = Object.values(data?.attendanceByStatus ?? {}).reduce((sum, value) => sum + value, 0);
  const credentialTotal = data?.employees ?? 0;

  return (
    <Stack spacing={2.2}>
      <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5} alignItems={{ lg: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h4">Dashboard</Typography>
          <Typography color="text.secondary">
            Asistencia, dispositivos y comandos en una vista limpia.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip label={`Hoy ${new Intl.DateTimeFormat("es-GT", { dateStyle: "medium" }).format(new Date())}`} variant="outlined" />
          <Chip label="Sin datos demo" variant="outlined" />
          <IconButton onClick={() => query.refetch()} aria-label="refrescar dashboard">
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Stack>

      {query.isFetching && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
          {query.isLoading ? (
            <Skeleton variant="rounded" height={164} />
          ) : (
            <MetricCard
              icon={<GroupsIcon />}
              label="Empleados"
              value={data?.employees}
              helper={`${formatNumber(data?.activeEmployees)} activos`}
              color="#4f46e5"
              progress={credentialTotal ? ((data?.activeEmployees ?? 0) / credentialTotal) * 100 : 0}
            />
          )}
        </Grid2>
        <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
          {query.isLoading ? (
            <Skeleton variant="rounded" height={164} />
          ) : (
            <MetricCard
              icon={<DevicesIcon />}
              label="Dispositivos"
              value={data?.devices}
              helper={`${formatNumber(data?.onlineDevices)} online`}
              color="#4f46e5"
              progress={data?.devices ? ((data.onlineDevices ?? 0) / data.devices) * 100 : 0}
            />
          )}
        </Grid2>
        <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
          {query.isLoading ? (
            <Skeleton variant="rounded" height={164} />
          ) : (
            <MetricCard
              icon={<EventAvailableIcon />}
              label="Eventos hoy"
              value={data?.todayEvents}
              helper="Marcajes recibidos"
              color="#4f46e5"
              progress={Math.min((data?.todayEvents ?? 0) * 8, 100)}
            />
          )}
        </Grid2>
        <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
          {query.isLoading ? (
            <Skeleton variant="rounded" height={164} />
          ) : (
            <MetricCard
              icon={<TuneIcon />}
              label="Comandos pendientes"
              value={data?.pendingCommands}
              helper="Cola por procesar"
              color="#4f46e5"
              progress={Math.min((data?.pendingCommands ?? 0) * 20, 100)}
            />
          )}
        </Grid2>
      </Grid2>

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, xl: 8 }}>
          <Panel title="Estado de credenciales">
            {credentialTotal === 0 ? (
              <EmptyState
                title="Aun no hay empleados"
                body="Crea la compania, sucursales, horarios y empleados para empezar a medir enrolamiento."
                to="/employees"
                action="Ir a empleados"
              />
            ) : (
              <Grid2 container spacing={2.5}>
                <Grid2 size={{ xs: 12, sm: 6 }}>
                  <StatusRing label="Personas activas" value={data?.activeEmployees ?? 0} total={credentialTotal} color="#4f46e5" helper="Listas para asistencia" />
                </Grid2>
                <Grid2 size={{ xs: 12, sm: 6 }}>
                  <StatusRing label="Tarjetas" value={data?.cards ?? 0} total={credentialTotal} color="#8b5cf6" helper="Con numero asignado" />
                </Grid2>
                <Grid2 size={{ xs: 12, sm: 6 }}>
                  <StatusRing label="Huellas" value={data?.fingerprints ?? 0} total={credentialTotal} color="#6366f1" helper="Minimo una huella" />
                </Grid2>
                <Grid2 size={{ xs: 12, sm: 6 }}>
                  <StatusRing label="Rostros" value={data?.faces ?? 0} total={credentialTotal} color="#a78bfa" helper="Enrolamiento facial" />
                </Grid2>
              </Grid2>
            )}
          </Panel>
        </Grid2>

        <Grid2 size={{ xs: 12, xl: 4 }}>
          <Panel title="Estado de dispositivo" action={<Chip size="small" label={`${formatNumber(data?.devices)} total`} />}>
            {data?.devices === 0 ? (
              <EmptyState
                title="Sin dispositivos configurados"
                body="Registra cada biometrico con Device ID, protocolo ISUP y sucursal antes de activar comandos."
                to="/devices"
                action="Configurar dispositivos"
              />
            ) : (
              <Stack spacing={1.5}>
                {[
                { label: "Online", value: data?.onlineDevices ?? 0, color: "#4f46e5" },
                  { label: "Offline", value: data?.offlineDevices ?? 0, color: "#64748b" },
                  { label: "Error", value: data?.errorDevices ?? 0, color: "#dc2626" }
                ].map((item) => {
                  const total = data?.devices ?? 0;
                  const percent = total ? Math.round((item.value / total) * 100) : 0;
                  return (
                    <Box key={item.label}>
                      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }}>
                        <Typography variant="body2" sx={{ fontWeight: 800 }}>
                          {item.label}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {formatNumber(item.value)} / {formatNumber(total)}
                        </Typography>
                      </Stack>
                      <Box sx={{ height: 9, borderRadius: 999, bgcolor: "#eef2f7", overflow: "hidden" }}>
                        <Box sx={{ width: `${percent}%`, height: "100%", bgcolor: item.color, borderRadius: 999 }} />
                      </Box>
                    </Box>
                  );
                })}
                {(data?.errorDevices ?? 0) > 0 && (
                  <Alert icon={<WarningAmberIcon />} severity="warning">
                    Hay dispositivos con error. Revisa conexion, zona horaria y ultimo evento recibido.
                  </Alert>
                )}
              </Stack>
            )}
          </Panel>
        </Grid2>
      </Grid2>

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, lg: 7 }}>
          <Panel title="Informe de asistencia">
            {totalAttendance === 0 ? (
              <EmptyState
                title="Sin asistencia calculada para hoy"
                body="Cuando lleguen marcajes o ejecutes el calculo diario, este panel mostrara normal, tarde, ausente y excepciones."
                to="/daily-report"
                action="Ver reporte diario"
              />
            ) : (
              <Stack spacing={1.25}>
                {Object.entries(data?.attendanceByStatus ?? {}).map(([status, value]) => {
                  const percent = Math.round((value / totalAttendance) * 100);
                  const color = attendancePalette[status] ?? "#64748b";
                  return (
                    <Box key={status}>
                      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: color }} />
                          <Typography variant="body2" sx={{ fontWeight: 800 }}>
                            {attendanceLabels[status] ?? status}
                          </Typography>
                        </Stack>
                        <Typography variant="body2" color="text.secondary">
                          {formatNumber(value)} ({percent}%)
                        </Typography>
                      </Stack>
                      <Box sx={{ height: 10, borderRadius: 999, bgcolor: "#eef2f7", overflow: "hidden" }}>
                        <Box sx={{ width: `${percent}%`, height: "100%", bgcolor: color, borderRadius: 999 }} />
                      </Box>
                    </Box>
                  );
                })}
              </Stack>
            )}
          </Panel>
        </Grid2>

        <Grid2 size={{ xs: 12, lg: 5 }}>
          <Panel
            title="Inicio rapido"
            action={
              <Button component={RouterLink} to="/settings" size="small" variant="text">
                Configurar
              </Button>
            }
          >
            <Grid2 container spacing={1.25}>
              {[
                { label: "Crear empleados", to: "/employees", icon: <BadgeIcon />, color: "#4f46e5" },
                { label: "Registrar dispositivo", to: "/devices", icon: <SettingsInputAntennaIcon />, color: "#4f46e5" },
                { label: "Enviar comando", to: "/commands", icon: <TuneIcon />, color: "#4f46e5" },
                { label: "Ver eventos", to: "/live-events", icon: <PersonSearchIcon />, color: "#4f46e5" }
              ].map((item) => (
                <Grid2 key={item.to} size={{ xs: 12, sm: 6 }}>
                  <Button
                    component={RouterLink}
                    to={item.to}
                    fullWidth
                    variant="outlined"
                    sx={{ justifyContent: "flex-start", minHeight: 58, borderColor: "#e5e7eb", color: "text.primary" }}
                    startIcon={<Box sx={{ color: item.color, display: "grid" }}>{item.icon}</Box>}
                  >
                    {item.label}
                  </Button>
                </Grid2>
              ))}
            </Grid2>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.8 }}>
              ISUP real queda pendiente hasta instalar el SDK oficial HCISUP/ISUP.
            </Typography>
          </Panel>
        </Grid2>
      </Grid2>

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, lg: 7 }}>
          <Panel title="Eventos recientes" action={<Button component={RouterLink} to="/live-events" size="small">Ver todos</Button>}>
            {(data?.recentEvents.length ?? 0) === 0 ? (
              <EmptyState
                title="Todavia no entran marcajes"
                body="Cuando un dispositivo envie eventos al gateway, apareceran aqui con empleado, equipo y tipo."
                to="/live-events"
                action="Abrir monitor"
              />
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Hora</TableCell>
                      <TableCell>Empleado</TableCell>
                      <TableCell>Dispositivo</TableCell>
                      <TableCell>Tipo</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(data?.recentEvents ?? []).map((event) => (
                      <TableRow key={event.id} hover>
                        <TableCell>{formatTime(event.occurred_at)}</TableCell>
                        <TableCell>{event.employees?.full_name ?? event.employees?.employee_code ?? "Sin empleado"}</TableCell>
                        <TableCell>{event.devices?.name ?? "Sin dispositivo"}</TableCell>
                        <TableCell>{event.event_type}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Panel>
        </Grid2>

        <Grid2 size={{ xs: 12, lg: 5 }}>
          <Panel title="Tareas pendientes" action={<Button component={RouterLink} to="/commands" size="small">Cola</Button>}>
            {(data?.recentCommands.length ?? 0) === 0 ? (
              <EmptyState
                title="Sin comandos recientes"
                body="La cola se llenara cuando sincronices personas, tarjetas, huellas o solicites eventos."
                to="/commands"
                action="Crear comando"
              />
            ) : (
              <Stack divider={<Divider flexItem />} spacing={1.25}>
                {(data?.recentCommands ?? []).map((command) => (
                  <Stack key={command.id} direction="row" alignItems="center" justifyContent="space-between" spacing={1.5}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 800 }} noWrap>
                        {command.command_type}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {command.devices?.name ?? "Dispositivo"} - {formatTime(command.created_at)} - intento {command.attempts}
                      </Typography>
                    </Box>
                    <StatusChip value={command.status} />
                  </Stack>
                ))}
              </Stack>
            )}
          </Panel>
        </Grid2>
      </Grid2>

    </Stack>
  );
}
