import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  MenuItem,
  Typography
} from "@mui/material";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

export function DailyReportPage() {
  const queryClient = useQueryClient();
  const [draftDate, setDraftDate] = useState(todayInGuatemala);
  const [reportDate, setReportDate] = useState(todayInGuatemala);
  const [branchId, setBranchId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageSeverity, setMessageSeverity] = useState<"success" | "info" | "warning" | "error">("info");
  const [syncing, setSyncing] = useState(false);
  const [syncJob, setSyncJob] = useState<any | null>(null);
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);

  const query = useQuery({
    queryKey: ["daily-report", reportDate, branchId, employeeId, departmentId, groupId, deviceId],
    queryFn: async () => {
      const startedAt = performance.now();
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user.id;
      if (!userId) throw new Error("La sesión autenticada no está disponible");
      const [reportResult, jobResult] = await Promise.all([
        supabase.rpc("get_attendance_daily_report", {
          p_date: reportDate,
          p_branch_id: branchId || undefined,
          p_employee_id: employeeId || undefined
        }),
        supabase.from("attendance_sync_jobs")
          .select("id,date,status,stage,progress,devices_total,devices_done,events_found,events_inserted,events_skipped,error_message,device_results,started_at,finished_at,created_at")
          .eq("date", reportDate).eq("requested_by", userId)
          .order("created_at", { ascending: false }).limit(1).maybeSingle()
      ]);
      if (reportResult.error) throw reportResult.error;
      if (jobResult.error) throw jobResult.error;
      const reportRows = reportResult.data ?? [];
      const rows = reportRows.filter((row: any) =>
        (!departmentId || row.department_id === departmentId) &&
        (!groupId || row.attendance_group_id === groupId) &&
        (!deviceId || row.device_ids?.includes(deviceId))
      );
      const latestJob = jobResult.data;
      const lastCalculatedAt = reportRows.reduce((latest: string | null, row: any) =>
        !latest || new Date(row.calculated_at) > new Date(latest) ? row.calculated_at : latest, null);
      const isToday = reportDate === todayInGuatemala();
      const stale = reportRows.length === 0 || (isToday && (!lastCalculatedAt || Date.now() - new Date(lastCalculatedAt).getTime() > 15 * 60 * 1000) && !isActiveJob(latestJob));
      return {
        rows,
        cache: { hit: reportRows.length > 0, stale, last_calculated_at: lastCalculatedAt, response_ms: Math.round(performance.now() - startedAt) },
        activeJob: isActiveJob(latestJob) ? latestJob : null
      };
    }
  });
  const lookups = useQuery({ queryKey: ["attendance-report-lookups"], queryFn: async () => {
    const [branches, departments, groups, employees, devices] = await Promise.all([
      supabase.from("branches").select("id,name").order("name"), supabase.from("departments").select("id,name").order("name"),
      supabase.from("attendance_groups").select("id,name").order("name"), supabase.from("employees").select("id,full_name").order("full_name"),
      supabase.from("devices").select("id,name").order("name")
    ]); return { branches: branches.data ?? [], departments: departments.data ?? [], groups: groups.data ?? [], employees: employees.data ?? [], devices: devices.data ?? [] };
  }});

  const rawQuery = useQuery({
    queryKey: ["raw-events", selectedEmployee, reportDate],
    enabled: rawOpen && Boolean(selectedEmployee),
    queryFn: async () => {
      const next = new Date(`${reportDate}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const { data, error } = await supabase
        .from("raw_access_events")
        .select("*")
        .eq("employee_id", selectedEmployee)
        .gte("occurred_at", `${reportDate}T00:00:00-06:00`)
        .lt("occurred_at", `${next.toISOString().slice(0, 10)}T00:00:00-06:00`)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    }
  });

  useEffect(() => {
    setSyncJob(null);
    setSyncing(false);
  }, [reportDate, deviceId]);

  const enqueueSync = useCallback(async () => {
    setMessage(null);
    setMessageSeverity("info");
    setMessage(`Actualizando ${reportDate} desde dispositivos…`);
    setSyncing(true);
    const clientClickedAt = new Date().toISOString();
    const traceId = crypto.randomUUID();
    const requestStarted = performance.now();
    try {
      const { data, error } = await supabase.functions.invoke("attendance-sync", {
        body: {
          action: "enqueue_day",
          date: reportDate,
          device_ids: deviceId ? [deviceId] : undefined,
          force: true,
          trace_id: traceId,
          client_clicked_at: clientClickedAt
        }
      });
      if (error) throw error;
      const job = data?.job;
      if (!job?.id) throw new Error("El servidor no devolvió el job de sincronización");
      console.info(JSON.stringify({
        event: "attendance_sync_enqueued",
        trace_id: job.trace_id,
        job_id: job.id,
        frontend_to_edge_response_ms: Math.round(performance.now() - requestStarted)
      }));
      setSyncJob(job);
      if (["complete", "partial", "failed"].includes(job.status)) {
        setSyncing(false);
        await queryClient.invalidateQueries({ queryKey: ["daily-report"] });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageSeverity("error");
      setSyncing(false);
    }
  }, [deviceId, queryClient, reportDate]);

  useEffect(() => {
    const active = query.data?.activeJob;
    if (active?.id && active.id !== syncJob?.id) {
      setSyncJob(active);
      setSyncing(true);
    }
  }, [query.data?.activeJob, syncJob?.id]);

  useEffect(() => {
    if (!syncJob?.id || ["complete", "partial", "failed"].includes(syncJob.status)) return;
    const subscribedAt = performance.now();
    const channel = supabase.channel(`attendance-sync-job-${syncJob.id}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "attendance_sync_jobs", filter: `id=eq.${syncJob.id}`
      }, (payload) => {
        const job = payload.new as any;
        const visibleAt = new Date().toISOString();
        console.info(JSON.stringify({
          event: "attendance_sync_realtime_visible",
          trace_id: job.trace_id,
          job_id: job.id,
          status: job.status,
          realtime_visible_at: visibleAt,
          db_update_to_visible_ms: job.updated_at ? Math.max(0, new Date(visibleAt).getTime() - new Date(job.updated_at).getTime()) : null,
          subscription_age_ms: Math.round(performance.now() - subscribedAt)
        }));
        setSyncJob(job);
        if (["complete", "partial", "failed"].includes(job.status)) {
          setSyncing(false);
          const details = `${job.events_found} eventos encontrados, ${job.events_inserted} nuevos y ${job.events_skipped} ya existentes/omitidos.`;
          setMessage(job.status === "failed"
            ? "No fue posible actualizar desde los dispositivos."
            : job.status === "partial"
              ? "Actualización parcial: algunos dispositivos no respondieron correctamente."
              : `Actualizado. ${details}`);
          setMessageSeverity(job.status === "failed" ? "error" : job.status === "partial" ? "warning" : "success");
          void queryClient.invalidateQueries({ queryKey: ["daily-report"] });
        }
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [queryClient, syncJob?.id, syncJob?.status]);

  async function exportExcel() {
    setMessage(null);
    const { data, error } = await supabase.functions.invoke("export-attendance-excel", {
      body: { start_date: reportDate, end_date: reportDate, branch_id: branchId || undefined, department_id: departmentId || undefined, attendance_group_id: groupId || undefined, employee_id: employeeId || undefined, device_id: deviceId || undefined }
    });
    if (error) setMessage(error.message);
    else if (data?.signed_url) window.open(data.signed_url, "_blank", "noopener,noreferrer");
  }

  function consultReport() {
    setMessage(null);
    if (draftDate === reportDate) {
      void query.refetch();
      return;
    }
    setSyncJob(null);
    setSyncing(false);
    setReportDate(draftDate);
  }

  const deviceResults = Array.isArray(syncJob?.device_results) ? syncJob.device_results : [];
  const successfulDevices = deviceResults.filter((device: any) => device.status === "success").length;
  const failedDevices = Math.max(0, Number(syncJob?.devices_done ?? 0) - successfulDevices);
  const datePending = draftDate !== reportDate;

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Reporte diario</Typography>
      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <Stack spacing={0.25}>
          <TextField size="small" label="Fecha" type="date" value={draftDate} onChange={(event) => setDraftDate(event.target.value)} InputLabelProps={{ shrink: true }} />
          {datePending && <Typography variant="caption" color="warning.main">Fecha pendiente de consultar</Typography>}
        </Stack>
        <TextField size="small" select label="Sucursal" value={branchId} onChange={(event) => setBranchId(event.target.value)}><MenuItem value="">Todas</MenuItem>{lookups.data?.branches.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Departamento" value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.departments.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Grupo asistencia" value={groupId} onChange={(event) => setGroupId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.groups.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Empleado" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.employees.map((v) => <MenuItem key={v.id} value={v.id}>{v.full_name}</MenuItem>)}</TextField>
        <TextField size="small" select label="Dispositivo" value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.devices.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        <Button variant="contained" onClick={consultReport}>Consultar reporte</Button>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={() => void enqueueSync()} disabled={syncing || datePending}>Actualizar desde dispositivos</Button>
        <Button startIcon={<FileDownloadIcon />} variant="contained" onClick={exportExcel}>Exportar Excel</Button>
      </Stack>
      {message && <Alert severity={messageSeverity} action={
        ["partial", "failed"].includes(syncJob?.status) && deviceResults.length > 0
          ? <Button color="inherit" size="small" onClick={() => setSyncDetailsOpen(true)}>Ver detalle</Button>
          : undefined
      }>{message}</Alert>}
      {syncJob?.status === "partial" && <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
          <Typography variant="body2">Consultados: {syncJob.devices_done}</Typography>
          <Typography variant="body2">Correctos: {successfulDevices}</Typography>
          <Typography variant="body2">Con error/offline: {failedDevices}</Typography>
          <Typography variant="body2">Eventos encontrados: {syncJob.events_found}</Typography>
          <Typography variant="body2">Nuevos guardados: {syncJob.events_inserted}</Typography>
          <Typography variant="body2">Ya existentes/omitidos: {syncJob.events_skipped}</Typography>
          <Button size="small" onClick={() => setSyncDetailsOpen(true)}>Ver detalle</Button>
        </Stack>
      </Paper>}
      {syncing && <Alert severity="info">{syncStage(syncJob, reportDate)}</Alert>}
      {syncing && <LinearProgress variant="determinate" value={Number(syncJob?.progress ?? 1)} />}
      {query.isFetching && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Departamento</TableCell><TableCell>Grupo de asistencia</TableCell><TableCell>Nombre</TableCell>
              <TableCell>Fecha</TableCell>
              <TableCell>Hora real del registro de entrada</TableCell><TableCell>Hora real de registro de salida</TableCell>
              <TableCell>Grabación de asistencia</TableCell><TableCell>Duración de la pausa</TableCell><TableCell>Registros de descansos</TableCell><TableCell>Periodo de tiempo</TableCell><TableCell>Eventos</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(query.data?.rows ?? []).map((row: any) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.department ?? ""}</TableCell><TableCell>{row.attendance_group ?? ""}</TableCell><TableCell>{row.employee_name ?? row.employee_id}</TableCell>
                <TableCell>{row.attendance_date}</TableCell>
                <TableCell>{formatGt(row.actual_check_in)}</TableCell><TableCell>{formatGt(row.actual_check_out)}</TableCell>
                <TableCell>{row.actual_check_in || row.actual_check_out ? `${formatGt(row.actual_check_in)} / ${formatGt(row.actual_check_out)}` : "Ninguno"}</TableCell><TableCell>{row.break_minutes ?? 0} min</TableCell><TableCell>{formatBreaks(row.break_records)}</TableCell><TableCell>{Math.round((row.attendance_minutes ?? 0) / 60 * 100) / 100} h</TableCell>
                <TableCell>
                  <Button size="small" onClick={() => { setSelectedEmployee(row.employee_id); setRawOpen(true); }}>
                    Ver
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={rawOpen} onClose={() => setRawOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Eventos crudos</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            {(rawQuery.data ?? []).map((event) => (
              <Paper key={event.id} sx={{ p: 1.5 }}>
                <Typography variant="body2">{event.occurred_at} - {event.raw_event_type} - {event.access_result}</Typography>
                <Typography variant="caption" color="text.secondary">{event.event_hash}</Typography>
              </Paper>
            ))}
          </Stack>
        </DialogContent>
      </Dialog>

      <Dialog open={syncDetailsOpen} onClose={() => setSyncDetailsOpen(false)} fullWidth maxWidth="lg">
        <DialogTitle>Detalle de actualización — {syncJob?.date ?? reportDate}</DialogTitle>
        <DialogContent>
          <TableContainer>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Dispositivo</TableCell><TableCell>Device ID</TableCell><TableCell>Estado</TableCell>
                <TableCell>Encontrados</TableCell><TableCell>Insertados</TableCell><TableCell>Omitidos</TableCell><TableCell>Error</TableCell>
              </TableRow></TableHead>
              <TableBody>{deviceResults.map((device: any) => <TableRow key={device.device_id}>
                <TableCell>{device.device_name ?? device.device_identifier ?? "-"}</TableCell>
                <TableCell>{device.device_id}</TableCell><TableCell>{device.status}</TableCell>
                <TableCell>{device.events_found ?? 0}</TableCell><TableCell>{device.events_inserted ?? 0}</TableCell>
                <TableCell>{device.events_skipped ?? 0}</TableCell><TableCell>{device.error ?? "-"}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          </TableContainer>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

const formatGt = (value?: string | null) => value ? new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date(value)) : "Ninguno";
const todayInGuatemala = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const formatBreaks = (value: unknown) => Array.isArray(value) && value.length ? value.map((item) => `${formatGt(item?.out)} - ${formatGt(item?.in)} (${item?.minutes ?? 0} min)`).join("; ") : "-";
function syncStage(job: any, date: string) {
  if (!job) return `Actualizando ${date} desde dispositivos…`;
  if (job.stage === "calculating_report") return `Calculando reporte de ${date}…`;
  if (job.stage === "persisting_events") return `Actualizando ${date}: guardando ${job.events_found ?? 0} eventos encontrados…`;
  if (String(job.stage).startsWith("consulting_device_")) return `Actualizando ${date}: consultando dispositivo ${Math.min((job.devices_done ?? 0) + 1, job.devices_total ?? 1)}/${job.devices_total ?? 1}. Eventos encontrados: ${job.events_found ?? 0}`;
  return `Actualizando ${date} desde dispositivos…`;
}

function isActiveJob(job: any) {
  return Boolean(job && ["pending", "processing", "calculating"].includes(job.status));
}
