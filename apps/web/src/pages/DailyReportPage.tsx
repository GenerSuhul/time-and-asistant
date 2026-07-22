import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
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
import SearchIcon from "@mui/icons-material/Search";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { invokeEdge } from "../lib/edgeFunction";

export function DailyReportPage() {
  const queryClient = useQueryClient();
  const [draftDate, setDraftDate] = useState(todayInGuatemala);
  const [draftBranchId, setDraftBranchId] = useState("");
  const [draftEmployeeId, setDraftEmployeeId] = useState("");
  const [draftDepartmentId, setDraftDepartmentId] = useState("");
  const [draftDeviceId, setDraftDeviceId] = useState("");
  const [reportSelection, setReportSelection] = useState<ReportSelection>(() => emptySelection(todayInGuatemala()));
  const [hasGenerated, setHasGenerated] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageSeverity, setMessageSeverity] = useState<"success" | "info" | "warning" | "error">("info");
  const [syncing, setSyncing] = useState(false);
  const [syncJob, setSyncJob] = useState<any | null>(null);
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);

  const query = useQuery({
    queryKey: reportQueryKey(reportSelection),
    queryFn: () => fetchDailyReport(reportSelection),
    enabled: hasGenerated,
    staleTime: 10_000
  });
  const lookups = useQuery({ queryKey: ["attendance-report-lookups"], queryFn: async () => {
    const [branches, departments, employees, devices] = await Promise.all([
      supabase.from("branches").select("id,name").order("name"), supabase.from("departments").select("id,name").order("name"),
      supabase.from("employees").select("id,full_name").order("full_name"),
      supabase.from("devices").select("id,name").order("name")
    ]); return { branches: branches.data ?? [], departments: departments.data ?? [], employees: employees.data ?? [], devices: devices.data ?? [] };
  }});

  const rawQuery = useQuery({
    queryKey: ["raw-events", selectedEmployee, reportSelection.date],
    enabled: rawOpen && Boolean(selectedEmployee),
    queryFn: async () => {
      const next = new Date(`${reportSelection.date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      const { data, error } = await supabase
        .from("raw_access_events")
        .select("*")
        .eq("employee_id", selectedEmployee)
        .gte("occurred_at", `${reportSelection.date}T00:00:00-06:00`)
        .lt("occurred_at", `${next.toISOString().slice(0, 10)}T00:00:00-06:00`)
        .order("occurred_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    }
  });

  const showTerminalJob = useCallback((job: any) => {
    const results = Array.isArray(job.device_results) ? job.device_results : [];
    const successful = results.filter((device: any) => device.status === "success").length;
    const total = Number(job.devices_total ?? results.length);
    const details = `${job.events_found ?? 0} eventos encontrados, ${job.events_inserted ?? 0} nuevos y ${job.events_skipped ?? 0} ya existentes/omitidos.`;
    setMessage(job.status === "failed"
      ? "No fue posible buscar marcajes en los dispositivos. Revisa el detalle e inténtalo nuevamente."
      : job.status === "partial"
        ? `Reporte parcial: ${successful} de ${total} ${total === 1 ? "dispositivo respondió" : "dispositivos respondieron"}.`
        : `Reporte actualizado. ${details}`);
    setMessageSeverity(job.status === "failed" ? "error" : job.status === "partial" ? "warning" : "success");
  }, []);

  const enqueueSync = useCallback(async (force: boolean, selection: ReportSelection) => {
    setMessage(null);
    setMessageSeverity("info");
    setSyncing(true);
    const clientClickedAt = new Date().toISOString();
    const traceId = crypto.randomUUID();
    const requestStarted = performance.now();
    try {
      const data = await invokeEdge<any>("attendance-sync", {
          action: "enqueue_day",
          date: selection.date,
          device_ids: selection.deviceId ? [selection.deviceId] : undefined,
          force,
          trace_id: traceId,
          client_clicked_at: clientClickedAt
      });
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
        showTerminalJob(job);
        await queryClient.invalidateQueries({ queryKey: ["daily-report"] });
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageSeverity("error");
      setSyncing(false);
    }
  }, [queryClient, showTerminalJob]);

  useEffect(() => {
    const active = query.data?.activeJob;
    if (active?.id && active.id !== syncJob?.id) {
      setSyncJob(active);
      setSyncing(true);
    }
  }, [query.data?.activeJob, syncJob?.id]);

  useEffect(() => {
    if (!syncJob?.id || ["complete", "partial", "failed"].includes(syncJob.status)) return;
    let cancelled = false;
    const subscribedAt = performance.now();
    const applyJobUpdate = (job: any) => {
      if (cancelled) return;
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
        showTerminalJob(job);
        void queryClient.invalidateQueries({ queryKey: ["daily-report"] });
      }
    };
    const channel = supabase.channel(`attendance-sync-job-${syncJob.id}`)
      .on("postgres_changes", {
        event: "UPDATE", schema: "public", table: "attendance_sync_jobs", filter: `id=eq.${syncJob.id}`
      }, (payload) => applyJobUpdate(payload.new))
      .subscribe((status) => {
        if (status !== "SUBSCRIBED") return;
        void supabase.from("attendance_sync_jobs")
          .select("*")
          .eq("id", syncJob.id)
          .single()
          .then(({ data, error }) => {
            if (error) {
              console.warn("No fue posible reconciliar el estado actual del job", error.message);
              return;
            }
            if (data) applyJobUpdate(data);
          });
      });
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [queryClient, showTerminalJob, syncJob?.id, syncJob?.status]);

  async function exportExcel() {
    setMessage(null);
    try {
      const data = await invokeEdge<{ signed_url?: string }>("export-attendance-excel", {
        start_date: reportSelection.date,
        end_date: reportSelection.date,
        branch_id: reportSelection.branchId || undefined,
        department_id: reportSelection.departmentId || undefined,
        employee_id: reportSelection.employeeId || undefined,
        device_id: reportSelection.deviceId || undefined
      });
      if (data?.signed_url) window.open(data.signed_url, "_blank", "noopener,noreferrer");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function generateReport() {
    const selection = draftSelection({
      date: draftDate,
      branchId: draftBranchId,
      departmentId: draftDepartmentId,
      employeeId: draftEmployeeId,
      deviceId: draftDeviceId
    });
    setMessage(null);
    setSyncJob(null);
    setSyncing(false);
    setGenerating(true);
    setReportSelection(selection);
    setHasGenerated(true);
    try {
      const result = await queryClient.fetchQuery({
        queryKey: reportQueryKey(selection),
        queryFn: () => fetchDailyReport(selection),
        staleTime: 10_000
      });
      if (result.activeJob) {
        setSyncJob(result.activeJob);
        setSyncing(true);
      } else if (result.rows.length === 0) {
        await enqueueSync(false, selection);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setMessageSeverity("error");
    } finally {
      setGenerating(false);
    }
  }

  const deviceResults = Array.isArray(syncJob?.device_results) ? syncJob.device_results : [];
  const successfulDevices = deviceResults.filter((device: any) => device.status === "success").length;
  const failedDevices = Math.max(0, Number(syncJob?.devices_total ?? deviceResults.length) - successfulDevices);
  const rows = query.data?.rows ?? [];
  const pendingSelection = draftSelection({
    date: draftDate,
    branchId: draftBranchId,
    departmentId: draftDepartmentId,
    employeeId: draftEmployeeId,
    deviceId: draftDeviceId
  });
  const selectionPending = hasGenerated && !sameSelection(pendingSelection, reportSelection);
  const initialState = !hasGenerated;
  const loadingCache = hasGenerated && (generating || query.isLoading) && !query.data;
  const emptyState = hasGenerated && !loadingCache && rows.length === 0;

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Reporte diario</Typography>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Box sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", lg: "repeat(5, minmax(140px, 1fr))" },
          gap: 1.5
        }}>
          <TextField fullWidth size="small" label="Fecha" type="date" value={draftDate} onChange={(event) => setDraftDate(event.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField fullWidth size="small" select label="Sucursal" value={draftBranchId} onChange={(event) => setDraftBranchId(event.target.value)}><MenuItem value="">Todas</MenuItem>{lookups.data?.branches.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
          <TextField fullWidth size="small" select label="Departamento" value={draftDepartmentId} onChange={(event) => setDraftDepartmentId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.departments.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
          <TextField fullWidth size="small" select label="Empleado" value={draftEmployeeId} onChange={(event) => setDraftEmployeeId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.employees.map((v) => <MenuItem key={v.id} value={v.id}>{v.full_name}</MenuItem>)}</TextField>
          <TextField fullWidth size="small" select label="Dispositivo" value={draftDeviceId} onChange={(event) => setDraftDeviceId(event.target.value)}><MenuItem value="">Todos</MenuItem>{lookups.data?.devices.map((v) => <MenuItem key={v.id} value={v.id}>{v.name}</MenuItem>)}</TextField>
        </Box>
        {selectionPending && <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 1 }}>Hay cambios pendientes. Presiona “Generar reporte” para aplicarlos.</Typography>}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 2 }}>
          <Button startIcon={<SearchIcon />} variant="contained" onClick={() => void generateReport()} disabled={generating} sx={{ whiteSpace: "nowrap" }}>
            {generating ? "Generando…" : "Generar reporte"}
          </Button>
          <Button startIcon={<RefreshIcon />} variant="outlined" onClick={() => void enqueueSync(true, reportSelection)} disabled={!hasGenerated || syncing || generating || selectionPending} sx={{ whiteSpace: "nowrap" }}>
            Actualizar desde dispositivos
          </Button>
          <Button startIcon={<FileDownloadIcon />} variant="text" onClick={exportExcel} disabled={rows.length === 0 || generating} sx={{ whiteSpace: "nowrap" }}>
            Exportar Excel
          </Button>
        </Stack>
      </Paper>
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
      {syncing && <Alert severity="info">{syncStage(syncJob)}</Alert>}
      {syncing && <LinearProgress variant="determinate" value={Number(syncJob?.progress ?? 1)} />}
      {query.isFetching && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}
      {initialState && <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
        <Typography variant="h6">Genera tu reporte diario</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5 }}>Selecciona la fecha y los filtros; nada se consultará hasta que presiones “Generar reporte”.</Typography>
      </Paper>}
      {loadingCache && <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography fontWeight={600}>Buscando información guardada…</Typography>
        <Typography variant="body2" color="text.secondary">Primero revisamos el reporte disponible en Supabase.</Typography>
      </Paper>}
      {emptyState && <Paper variant="outlined" sx={{ p: 4, textAlign: "center" }}>
        <Typography variant="h6">No hay marcajes guardados para esta fecha.</Typography>
        <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>Se consultarán los dispositivos conectados y el reporte se actualizará automáticamente.</Typography>
        <Button startIcon={<SearchIcon />} variant="outlined" onClick={() => void enqueueSync(true, reportSelection)} disabled={syncing}>
          {syncing ? "Buscando en dispositivos…" : "Buscar en dispositivos"}
        </Button>
      </Paper>}
      {!initialState && !loadingCache && rows.length > 0 && <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Departamento</TableCell><TableCell>Nombre</TableCell>
              <TableCell>Fecha</TableCell>
              <TableCell>Hora real del registro de entrada</TableCell><TableCell>Hora real de registro de salida</TableCell>
              <TableCell>Grabación de asistencia</TableCell><TableCell>Duración de la pausa</TableCell><TableCell>Registros de descansos</TableCell><TableCell>Periodo de tiempo</TableCell><TableCell>Eventos</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row: any) => (
              <TableRow key={row.id} hover>
                <TableCell>{row.department ?? ""}</TableCell><TableCell>{row.employee_name ?? row.employee_id}</TableCell>
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
      </TableContainer>}

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
        <DialogTitle>Detalle de dispositivos — {syncJob?.date ?? reportSelection.date}</DialogTitle>
        <DialogContent>
          <TableContainer>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Dispositivo</TableCell><TableCell>Estado</TableCell><TableCell>Eventos</TableCell><TableCell>Error</TableCell>
              </TableRow></TableHead>
              <TableBody>{deviceResults.map((device: any) => <TableRow key={device.device_id}>
                <TableCell>
                  <Typography variant="body2">{device.device_name ?? device.device_identifier ?? "-"}</Typography>
                  <Typography variant="caption" color="text.secondary">{device.device_id}</Typography>
                </TableCell>
                <TableCell>{deviceStatus(device.status)}</TableCell>
                <TableCell>{device.events_found ?? 0}</TableCell><TableCell>{device.error ?? "Sin errores"}</TableCell>
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
function syncStage(job: any) {
  if (!job || ["queued", "starting"].includes(job.stage)) return "Buscando marcajes en dispositivos…";
  if (job.stage === "calculating_report") return "Calculando reporte…";
  if (job.stage === "persisting_events") return `${job.events_found ?? 0} eventos encontrados. Preparando reporte…`;
  if (String(job.stage).startsWith("consulting_device_")) {
    const stage = /^consulting_device_(\d+)_of_(\d+)$/.exec(String(job.stage));
    const current = stage ? Number(stage[1]) : Math.min((job.devices_done ?? 0) + 1, job.devices_total ?? 1);
    const total = stage ? Number(stage[2]) : job.devices_total ?? 1;
    return `Consultando ${current}/${total} dispositivos · ${job.events_found ?? 0} eventos encontrados`;
  }
  return "Buscando marcajes en dispositivos…";
}

function isActiveJob(job: any) {
  return Boolean(job && ["pending", "processing", "calculating"].includes(job.status));
}

type ReportSelection = {
  date: string;
  branchId: string;
  departmentId: string;
  employeeId: string;
  deviceId: string;
};

function emptySelection(date: string): ReportSelection {
  return { date, branchId: "", departmentId: "", employeeId: "", deviceId: "" };
}

function draftSelection(selection: ReportSelection): ReportSelection {
  return selection;
}

function sameSelection(left: ReportSelection, right: ReportSelection) {
  return Object.keys(left).every((key) => left[key as keyof ReportSelection] === right[key as keyof ReportSelection]);
}

function reportQueryKey(selection: ReportSelection) {
  return ["daily-report", selection.date, selection.branchId, selection.employeeId, selection.departmentId, selection.deviceId] as const;
}

async function fetchDailyReport(selection: ReportSelection) {
  const startedAt = performance.now();
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) throw new Error("La sesión autenticada no está disponible");
  const [reportResult, jobResult] = await Promise.all([
    supabase.rpc("get_attendance_daily_report", {
      p_date: selection.date,
      p_branch_id: selection.branchId || undefined,
      p_employee_id: selection.employeeId || undefined
    }),
    supabase.from("attendance_sync_jobs")
      .select("id,date,status,stage,progress,devices_total,devices_done,events_found,events_inserted,events_skipped,error_message,device_results,started_at,finished_at,created_at")
      .eq("date", selection.date).eq("requested_by", userId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (reportResult.error) throw reportResult.error;
  if (jobResult.error) throw jobResult.error;
  const reportRows = reportResult.data ?? [];
  const rows = reportRows.filter((row: any) =>
    (!selection.departmentId || row.department_id === selection.departmentId) &&
    (!selection.deviceId || row.device_ids?.includes(selection.deviceId))
  );
  const latestJob = jobResult.data;
  const lastCalculatedAt = reportRows.reduce((latest: string | null, row: any) =>
    !latest || new Date(row.calculated_at) > new Date(latest) ? row.calculated_at : latest, null);
  return {
    rows,
    cache: { hit: rows.length > 0, last_calculated_at: lastCalculatedAt, response_ms: Math.round(performance.now() - startedAt) },
    activeJob: isActiveJob(latestJob) ? latestJob : null
  };
}

function deviceStatus(status: string | undefined) {
  if (status === "success") return "Correcto";
  if (status === "partial") return "Parcial";
  if (status === "failed") return "Error";
  return status ?? "Sin estado";
}
