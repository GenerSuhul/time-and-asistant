import { useMemo, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid2,
  LinearProgress,
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import AccessTimeFilledIcon from "@mui/icons-material/AccessTimeFilled";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import PersonSearchOutlinedIcon from "@mui/icons-material/PersonSearchOutlined";
import SearchIcon from "@mui/icons-material/Search";
import StorefrontOutlinedIcon from "@mui/icons-material/StorefrontOutlined";
import TimerOutlinedIcon from "@mui/icons-material/TimerOutlined";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";

type ReportFilters = {
  startDate: string;
  endDate: string;
  companyId: string;
  branchId: string;
  departmentId: string;
  employeeId: string;
  minLateMinutes: number;
};

type LookupItem = {
  id: string;
  name?: string;
  company_id?: string | null;
  branch_id?: string | null;
  department_id?: string | null;
  employee_code?: string;
  full_name?: string;
};

type ReportLookups = {
  companies: LookupItem[];
  branches: LookupItem[];
  departments: LookupItem[];
  employees: LookupItem[];
};

type LateSummary = {
  total_late_arrivals: number;
  affected_employees: number;
  affected_branches: number;
  average_late_minutes: number;
  total_late_minutes: number;
  maximum_late_minutes: number;
};

type TrendPoint = {
  bucket_start: string;
  late_arrivals: number;
  employees: number;
  total_minutes: number;
  average_minutes: number;
};

type EmployeeRank = {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  branch_name: string;
  late_arrivals: number;
  total_minutes: number;
  average_minutes: number;
  maximum_minutes: number;
};

type BranchRank = {
  branch_id: string | null;
  branch_name: string;
  late_arrivals: number;
  employees: number;
  total_minutes: number;
  average_minutes: number;
};

type LateRow = {
  id: string;
  attendance_date: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  company_name: string;
  branch_name: string;
  department_name: string;
  rule_name: string | null;
  expected_check_in: string | null;
  actual_check_in: string | null;
  actual_check_in_label: string | null;
  late_minutes: number;
};

type LateReport = {
  meta: {
    start_date: string;
    end_date: string;
    bucket: "day" | "week" | "month";
    page: number;
    page_size: number;
    total_rows: number;
  };
  summary: LateSummary;
  trend: TrendPoint[];
  employee_ranking: EmployeeRank[];
  branch_ranking: BranchRank[];
  rows: LateRow[];
};

const emptyLookups: ReportLookups = {
  companies: [],
  branches: [],
  departments: [],
  employees: []
};

const emptySummary: LateSummary = {
  total_late_arrivals: 0,
  affected_employees: 0,
  affected_branches: 0,
  average_late_minutes: 0,
  total_late_minutes: 0,
  maximum_late_minutes: 0
};

function todayInGuatemala() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Guatemala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function initialFilters(): ReportFilters {
  const endDate = todayInGuatemala();
  return {
    startDate: shiftDate(endDate, -29),
    endDate,
    companyId: "",
    branchId: "",
    departmentId: "",
    employeeId: "",
    minLateMinutes: 1
  };
}

function reportArgs(filters: ReportFilters, page: number, pageSize: number) {
  return {
    p_start_date: filters.startDate,
    p_end_date: filters.endDate,
    p_company_id: filters.companyId || undefined,
    p_branch_id: filters.branchId || undefined,
    p_department_id: filters.departmentId || undefined,
    p_employee_id: filters.employeeId || undefined,
    p_min_late_minutes: filters.minLateMinutes,
    p_page: page,
    p_page_size: pageSize
  };
}

async function fetchReport(filters: ReportFilters, page: number, pageSize: number) {
  const { data, error } = await supabase.rpc("get_late_arrivals_report", reportArgs(filters, page, pageSize));
  if (error) throw error;
  return data as unknown as LateReport;
}

function number(value: number) {
  return new Intl.NumberFormat("es-GT").format(value);
}

function minutes(value: number) {
  const rounded = Math.round(Number(value) || 0);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function averageMinutes(value: number) {
  const numeric = Number(value) || 0;
  const formatted = new Intl.NumberFormat("es-GT", { maximumFractionDigits: 1 }).format(
    numeric < 60 ? numeric : numeric / 60
  );
  return `${formatted} ${numeric < 60 ? "min" : "h"}`;
}

function dateLabel(value: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("es-GT", options ?? {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${value}T12:00:00Z`));
}

function MetricCard({
  icon,
  label,
  value,
  helper,
  color
}: {
  icon: ReactNode;
  label: string;
  value: string;
  helper: string;
  color: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2.25, height: "100%", boxShadow: "none", overflow: "hidden" }}>
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Box sx={{ p: 1.1, borderRadius: 2.5, color, bgcolor: alpha(color, 0.1), display: "grid", placeItems: "center" }}>
          {icon}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={700} textTransform="uppercase" letterSpacing={0.45}>
            {label}
          </Typography>
          <Typography sx={{ mt: 0.35, fontSize: { xs: 25, lg: 29 }, lineHeight: 1.15, fontWeight: 800 }}>
            {value}
          </Typography>
          <Typography variant="caption" color="text.secondary">{helper}</Typography>
        </Box>
      </Stack>
    </Paper>
  );
}

function TrendChart({ points, bucket }: { points: TrendPoint[]; bucket: LateReport["meta"]["bucket"] }) {
  if (!points.length) return <EmptyPanel text="No hay tardanzas para graficar en este período." />;
  const maximum = Math.max(...points.map((point) => point.late_arrivals), 1);
  const bucketLabel = bucket === "day" ? "día" : bucket === "week" ? "semana" : "mes";

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h6">Evolución de tardanzas</Typography>
          <Typography variant="caption" color="text.secondary">Agrupado por {bucketLabel}</Typography>
        </Box>
        <Chip size="small" icon={<TrendingUpIcon />} label={`${points.length} períodos`} variant="outlined" />
      </Stack>
      <Box sx={{ overflowX: "auto", pb: 0.75 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="flex-end"
          role="img"
          aria-label={`Tardanzas agrupadas por ${bucketLabel}`}
          sx={{ height: 230, minWidth: Math.max(620, points.length * 34), borderBottom: "1px solid", borderColor: "divider", px: 0.5 }}
        >
          {points.map((point, index) => {
            const height = Math.max(8, Math.round((point.late_arrivals / maximum) * 174));
            const showLabel = points.length <= 16 || index % Math.ceil(points.length / 12) === 0;
            return (
              <Tooltip
                key={point.bucket_start}
                arrow
                title={`${dateLabel(point.bucket_start, { day: "2-digit", month: "short", year: "numeric" })}: ${point.late_arrivals} tardanzas, ${minutes(point.total_minutes)} acumulados`}
              >
                <Stack alignItems="center" justifyContent="flex-end" sx={{ flex: 1, minWidth: 22, height: "100%" }}>
                  <Typography variant="caption" fontWeight={700} sx={{ mb: 0.5 }}>{point.late_arrivals}</Typography>
                  <Box
                    sx={{
                      width: "100%",
                      maxWidth: 30,
                      height,
                      minHeight: 8,
                      borderRadius: "8px 8px 2px 2px",
                      bgcolor: "warning.main",
                      background: "linear-gradient(180deg, #f59e0b 0%, #fb923c 100%)",
                      transition: "height 180ms ease"
                    }}
                  />
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ mt: 0.75, height: 18, whiteSpace: "nowrap", visibility: showLabel ? "visible" : "hidden" }}
                  >
                    {dateLabel(point.bucket_start, { day: "2-digit", month: "short" })}
                  </Typography>
                </Stack>
              </Tooltip>
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}

function RankingList({
  title,
  subtitle,
  rows,
  onSelect
}: {
  title: string;
  subtitle: string;
  rows: Array<{ id: string | null; name: string; helper: string; count: number; minutes: number }>;
  onSelect: (id: string) => void;
}) {
  const maximum = Math.max(...rows.map((row) => row.count), 1);
  return (
    <Paper variant="outlined" sx={{ p: 2.25, height: "100%", boxShadow: "none" }}>
      <Typography variant="h6">{title}</Typography>
      <Typography variant="caption" color="text.secondary">{subtitle}</Typography>
      {!rows.length ? (
        <EmptyPanel text="Sin datos en el período seleccionado." />
      ) : (
        <Stack spacing={1.65} sx={{ mt: 2.25 }}>
          {rows.map((row, index) => (
            <Box
              key={`${row.id ?? row.name}-${index}`}
              component={row.id ? "button" : "div"}
              type={row.id ? "button" : undefined}
              onClick={() => row.id && onSelect(row.id)}
              sx={{
                width: "100%",
                p: 0,
                border: 0,
                bgcolor: "transparent",
                textAlign: "left",
                font: "inherit",
                cursor: row.id ? "pointer" : "default",
                "&:hover .ranking-name": { color: row.id ? "primary.main" : "inherit" }
              }}
            >
              <Stack direction="row" spacing={1.25} alignItems="center">
                <Box sx={{ width: 26, height: 26, borderRadius: 2, display: "grid", placeItems: "center", bgcolor: index < 3 ? alpha("#f59e0b", 0.12) : "#f4f5f8", color: index < 3 ? "#c66a00" : "text.secondary", fontWeight: 800, fontSize: 12 }}>
                  {index + 1}
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" justifyContent="space-between" spacing={1}>
                    <Typography className="ranking-name" variant="body2" fontWeight={700} noWrap>{row.name}</Typography>
                    <Typography variant="body2" fontWeight={800}>{row.count}</Typography>
                  </Stack>
                  <Stack direction="row" justifyContent="space-between" spacing={1}>
                    <Typography variant="caption" color="text.secondary" noWrap>{row.helper}</Typography>
                    <Typography variant="caption" color="text.secondary">{minutes(row.minutes)}</Typography>
                  </Stack>
                  <Box sx={{ mt: 0.65, height: 5, borderRadius: 999, bgcolor: "#f0f1f5", overflow: "hidden" }}>
                    <Box sx={{ height: "100%", width: `${Math.max(5, (row.count / maximum) * 100)}%`, bgcolor: "primary.main", borderRadius: 999 }} />
                  </Box>
                </Box>
              </Stack>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: 150, color: "text.secondary", textAlign: "center" }}>
      <AccessTimeFilledIcon sx={{ opacity: 0.25, fontSize: 34 }} />
      <Typography variant="body2">{text}</Typography>
    </Stack>
  );
}

function csvCell(value: string | number | null) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export function LateArrivalsReportPage() {
  const defaults = useMemo(initialFilters, []);
  const [draft, setDraft] = useState<ReportFilters>(defaults);
  const [applied, setApplied] = useState<ReportFilters>(defaults);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [requestVersion, setRequestVersion] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const lookupsQuery = useQuery({
    queryKey: ["late-arrivals-report-filters"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_late_arrivals_report_filters");
      if (error) throw error;
      return (data ?? emptyLookups) as unknown as ReportLookups;
    },
    staleTime: 5 * 60_000
  });

  const reportQuery = useQuery({
    queryKey: ["late-arrivals-report", applied, page, pageSize, requestVersion],
    queryFn: () => fetchReport(applied, page + 1, pageSize),
    placeholderData: (previous) => previous,
    staleTime: 30_000
  });

  const lookups = lookupsQuery.data ?? emptyLookups;
  const availableBranches = lookups.branches.filter((item) => !draft.companyId || item.company_id === draft.companyId);
  const availableDepartments = lookups.departments.filter((item) =>
    !draft.companyId || item.company_id === draft.companyId
  );
  const availableEmployees = lookups.employees.filter((item) =>
    (!draft.companyId || item.company_id === draft.companyId) &&
    (!draft.branchId || item.branch_id === draft.branchId) &&
    (!draft.departmentId || item.department_id === draft.departmentId)
  );
  const data = reportQuery.data;
  const summary = data?.summary ?? emptySummary;

  function applyFilters(next = draft) {
    if (!next.startDate || !next.endDate) {
      setFormError("Selecciona las fechas de inicio y fin.");
      return;
    }
    if (next.startDate > next.endDate) {
      setFormError("La fecha de inicio no puede ser posterior a la fecha final.");
      return;
    }
    setFormError(null);
    setExportError(null);
    setPage(0);
    setApplied({ ...next });
    setRequestVersion((value) => value + 1);
  }

  function selectPreset(days: number) {
    const endDate = todayInGuatemala();
    const next = { ...draft, startDate: shiftDate(endDate, -(days - 1)), endDate };
    setDraft(next);
    applyFilters(next);
  }

  function selectEmployee(employeeId: string) {
    const employee = lookups.employees.find((item) => item.id === employeeId);
    const next = {
      ...draft,
      companyId: employee?.company_id ?? draft.companyId,
      branchId: employee?.branch_id ?? "",
      departmentId: employee?.department_id ?? "",
      employeeId
    };
    setDraft(next);
    applyFilters(next);
  }

  function selectBranch(branchId: string) {
    const branch = lookups.branches.find((item) => item.id === branchId);
    const next = {
      ...draft,
      companyId: branch?.company_id ?? draft.companyId,
      branchId,
      departmentId: "",
      employeeId: ""
    };
    setDraft(next);
    applyFilters(next);
  }

  async function exportCsv() {
    if (!data?.meta.total_rows) return;
    setExportError(null);
    setExporting(true);
    try {
      if (data.meta.total_rows > 25_000) {
        throw new Error("La exportación está limitada a 25,000 registros. Reduce el período o aplica un filtro.");
      }
      const allRows: LateRow[] = [];
      const pages = Math.ceil(data.meta.total_rows / 100);
      for (let exportPage = 1; exportPage <= pages; exportPage += 1) {
        const result = await fetchReport(applied, exportPage, 100);
        allRows.push(...result.rows);
      }
      const header = ["Fecha", "Código", "Colaborador", "Empresa", "Tienda", "Departamento", "Horario", "Entrada esperada", "Entrada real", "Minutos tarde"];
      const lines = [
        header.map(csvCell).join(","),
        ...allRows.map((row) => [
          row.attendance_date,
          row.employee_code,
          row.employee_name,
          row.company_name,
          row.branch_name,
          row.department_name,
          row.rule_name,
          row.expected_check_in,
          row.actual_check_in_label,
          row.late_minutes
        ].map(csvCell).join(","))
      ];
      const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `historico-tardanzas-${applied.startDate}-${applied.endDate}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }

  const employeeRows = (data?.employee_ranking ?? []).map((item) => ({
    id: item.employee_id,
    name: item.employee_name,
    helper: `${item.branch_name} · prom. ${averageMinutes(item.average_minutes)}`,
    count: item.late_arrivals,
    minutes: item.total_minutes
  }));
  const branchRows = (data?.branch_ranking ?? []).map((item) => ({
    id: item.branch_id,
    name: item.branch_name,
    helper: `${item.employees} ${item.employees === 1 ? "colaborador" : "colaboradores"} · prom. ${averageMinutes(item.average_minutes)}`,
    count: item.late_arrivals,
    minutes: item.total_minutes
  }));

  return (
    <Stack spacing={2.25}>
      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }} spacing={1.5}>
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h4">Histórico de tardanzas</Typography>
            <Chip size="small" color="warning" variant="outlined" label="Desde el primer minuto" />
          </Stack>
          <Typography color="text.secondary" sx={{ mt: 0.6 }}>
            Analiza recurrencia, minutos acumulados y concentración por colaborador o tienda.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          startIcon={<FileDownloadOutlinedIcon />}
          disabled={exporting || !data?.meta.total_rows}
          onClick={exportCsv}
        >
          {exporting ? "Preparando archivo..." : "Exportar CSV"}
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ p: { xs: 1.75, md: 2.25 }, boxShadow: "none" }}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "stretch", md: "center" }} spacing={1.5} sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CalendarMonthIcon color="primary" />
            <Box>
              <Typography variant="h6">Filtros del reporte</Typography>
              <Typography variant="caption" color="text.secondary">Los resultados se actualizan al presionar Consultar.</Typography>
            </Box>
          </Stack>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {[7, 30, 90].map((days) => (
              <Chip
                key={days}
                clickable
                variant={applied.startDate === shiftDate(todayInGuatemala(), -(days - 1)) && applied.endDate === todayInGuatemala() ? "filled" : "outlined"}
                color="primary"
                label={`${days} días`}
                onClick={() => selectPreset(days)}
              />
            ))}
          </Stack>
        </Stack>

        <Grid2 container spacing={1.5}>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField fullWidth size="small" label="Desde" type="date" value={draft.startDate} onChange={(event) => setDraft((current) => ({ ...current, startDate: event.target.value }))} InputLabelProps={{ shrink: true }} />
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField fullWidth size="small" label="Hasta" type="date" value={draft.endDate} onChange={(event) => setDraft((current) => ({ ...current, endDate: event.target.value }))} InputLabelProps={{ shrink: true }} />
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField
              fullWidth
              select
              size="small"
              label="Empresa"
              value={draft.companyId}
              onChange={(event) => setDraft((current) => ({ ...current, companyId: event.target.value, branchId: "", departmentId: "", employeeId: "" }))}
            >
              <MenuItem value="">Todas</MenuItem>
              {lookups.companies.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
            </TextField>
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField
              fullWidth
              select
              size="small"
              label="Tienda / sucursal"
              value={draft.branchId}
              onChange={(event) => setDraft((current) => ({ ...current, branchId: event.target.value, departmentId: "", employeeId: "" }))}
            >
              <MenuItem value="">Todas</MenuItem>
              {availableBranches.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
            </TextField>
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField
              fullWidth
              select
              size="small"
              label="Departamento"
              value={draft.departmentId}
              onChange={(event) => setDraft((current) => ({ ...current, departmentId: event.target.value, employeeId: "" }))}
            >
              <MenuItem value="">Todos</MenuItem>
              {availableDepartments.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
            </TextField>
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField
              fullWidth
              select
              size="small"
              label="Colaborador"
              value={draft.employeeId}
              onChange={(event) => setDraft((current) => ({ ...current, employeeId: event.target.value }))}
            >
              <MenuItem value="">Todos</MenuItem>
              {availableEmployees.map((item) => <MenuItem key={item.id} value={item.id}>{item.full_name}</MenuItem>)}
            </TextField>
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <TextField
              fullWidth
              size="small"
              label="Mínimo de tardanza"
              type="number"
              value={draft.minLateMinutes}
              onChange={(event) => setDraft((current) => ({ ...current, minLateMinutes: Math.max(1, Number(event.target.value) || 1) }))}
              inputProps={{ min: 1, max: 1440 }}
              helperText="Desde la hora programada"
            />
          </Grid2>
          <Grid2 size={{ xs: 12, sm: 6, lg: 2 }}>
            <Button fullWidth variant="contained" startIcon={<SearchIcon />} onClick={() => applyFilters()} sx={{ height: 40 }}>
              Consultar
            </Button>
          </Grid2>
          <Grid2 size={{ xs: 12, lg: 8 }}>
            <Stack direction="row" alignItems="center" sx={{ height: "100%" }}>
              <Typography variant="caption" color="text.secondary">
                Toda entrada posterior a la hora programada cuenta como tardanza; no se descuentan minutos de tolerancia. Período máximo: 5 años.
              </Typography>
            </Stack>
          </Grid2>
        </Grid2>
      </Paper>

      {(reportQuery.isFetching || lookupsQuery.isFetching) && <LinearProgress />}
      {formError && <Alert severity="warning">{formError}</Alert>}
      {exportError && <Alert severity="error">{exportError}</Alert>}
      {reportQuery.error && <Alert severity="error">No fue posible cargar el histórico: {reportQuery.error.message}</Alert>}
      {lookupsQuery.error && <Alert severity="error">No fue posible cargar los filtros: {lookupsQuery.error.message}</Alert>}

      <Grid2 container spacing={2}>
        {reportQuery.isLoading ? Array.from({ length: 4 }, (_, index) => (
          <Grid2 key={index} size={{ xs: 12, sm: 6, lg: 3 }}><Skeleton variant="rounded" height={126} /></Grid2>
        )) : (
          <>
            <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
              <MetricCard icon={<AccessTimeFilledIcon />} label="Entradas tarde" value={number(summary.total_late_arrivals)} helper={`Máximo individual: ${minutes(summary.maximum_late_minutes)}`} color="#f59e0b" />
            </Grid2>
            <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
              <MetricCard icon={<GroupsOutlinedIcon />} label="Colaboradores" value={number(summary.affected_employees)} helper="Personas con al menos una tardanza" color="#4f46e5" />
            </Grid2>
            <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
              <MetricCard icon={<StorefrontOutlinedIcon />} label="Tiendas afectadas" value={number(summary.affected_branches)} helper="Sucursales con incidencias" color="#8b5cf6" />
            </Grid2>
            <Grid2 size={{ xs: 12, sm: 6, lg: 3 }}>
              <MetricCard icon={<TimerOutlinedIcon />} label="Promedio" value={averageMinutes(summary.average_late_minutes)} helper={`${minutes(summary.total_late_minutes)} acumulados`} color="#ef4444" />
            </Grid2>
          </>
        )}
      </Grid2>

      <Paper variant="outlined" sx={{ p: { xs: 1.75, md: 2.25 }, boxShadow: "none" }}>
        {reportQuery.isLoading ? <Skeleton variant="rounded" height={250} /> : <TrendChart points={data?.trend ?? []} bucket={data?.meta.bucket ?? "day"} />}
      </Paper>

      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 12, lg: 6 }}>
          {reportQuery.isLoading ? <Skeleton variant="rounded" height={450} /> : (
            <RankingList
              title="Colaboradores con más tardanzas"
              subtitle="Selecciona una persona para abrir su historial individual."
              rows={employeeRows}
              onSelect={selectEmployee}
            />
          )}
        </Grid2>
        <Grid2 size={{ xs: 12, lg: 6 }}>
          {reportQuery.isLoading ? <Skeleton variant="rounded" height={450} /> : (
            <RankingList
              title="Tiendas con más tardanzas"
              subtitle="Selecciona una tienda para enfocar todo el reporte."
              rows={branchRows}
              onSelect={selectBranch}
            />
          )}
        </Grid2>
      </Grid2>

      <Paper variant="outlined" sx={{ boxShadow: "none", overflow: "hidden" }}>
        <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1} sx={{ p: 2.25, borderBottom: "1px solid", borderColor: "divider" }}>
          <Box>
            <Typography variant="h6">Detalle de entradas tarde</Typography>
            <Typography variant="caption" color="text.secondary">
              {number(data?.meta.total_rows ?? 0)} registros entre {dateLabel(applied.startDate, { day: "2-digit", month: "short", year: "numeric" })} y {dateLabel(applied.endDate, { day: "2-digit", month: "short", year: "numeric" })}
            </Typography>
          </Box>
          {(applied.employeeId || applied.branchId) && (
            <Chip
              icon={applied.employeeId ? <PersonSearchOutlinedIcon /> : <StorefrontOutlinedIcon />}
              label={applied.employeeId
                ? lookups.employees.find((item) => item.id === applied.employeeId)?.full_name ?? "Colaborador"
                : lookups.branches.find((item) => item.id === applied.branchId)?.name ?? "Tienda"}
              onDelete={() => {
                const next = { ...draft, employeeId: "", branchId: applied.employeeId ? draft.branchId : "", departmentId: applied.employeeId ? draft.departmentId : "" };
                setDraft(next);
                applyFilters(next);
              }}
            />
          )}
        </Stack>
        <TableContainer sx={{ maxHeight: 590 }}>
          <Table stickyHeader size="small" sx={{ minWidth: 1040 }}>
            <TableHead>
              <TableRow>
                <TableCell>Fecha</TableCell>
                <TableCell>Colaborador</TableCell>
                <TableCell>Tienda</TableCell>
                <TableCell>Departamento</TableCell>
                <TableCell>Horario</TableCell>
                <TableCell align="center">Entrada esperada</TableCell>
                <TableCell align="center">Entrada real</TableCell>
                <TableCell align="right">Tardanza</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(data?.rows ?? []).map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{dateLabel(row.attendance_date)}</TableCell>
                  <TableCell>
                    <Typography variant="body2" fontWeight={700}>{row.employee_name}</Typography>
                    <Typography variant="caption" color="text.secondary">{row.employee_code}</Typography>
                  </TableCell>
                  <TableCell>{row.branch_name}</TableCell>
                  <TableCell>{row.department_name}</TableCell>
                  <TableCell>{row.rule_name ?? "Sin regla"}</TableCell>
                  <TableCell align="center">{row.expected_check_in ?? "—"}</TableCell>
                  <TableCell align="center">{row.actual_check_in_label ?? "—"}</TableCell>
                  <TableCell align="right">
                    <Chip size="small" color={row.late_minutes >= 30 ? "error" : "warning"} variant="outlined" label={minutes(row.late_minutes)} />
                  </TableCell>
                </TableRow>
              ))}
              {!reportQuery.isLoading && !(data?.rows ?? []).length && (
                <TableRow>
                  <TableCell colSpan={8}><EmptyPanel text="No encontramos entradas tarde con estos filtros." /></TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={data?.meta.total_rows ?? 0}
          page={page}
          rowsPerPage={pageSize}
          rowsPerPageOptions={[10, 25, 50, 100]}
          labelRowsPerPage="Filas por página"
          labelDisplayedRows={({ from, to, count }) => `${from}–${to} de ${count}`}
          onPageChange={(_event, nextPage) => setPage(nextPage)}
          onRowsPerPageChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(0);
          }}
        />
      </Paper>
    </Stack>
  );
}
