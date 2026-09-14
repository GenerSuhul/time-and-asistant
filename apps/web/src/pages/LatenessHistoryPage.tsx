import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUserProfile } from "../hooks/useCurrentUserProfile";
import { isRegionalLatenessViewer } from "../lib/accessControl";
import { supabase } from "../lib/supabase";

type Branch = { id: string; name: string; company_id: string; region_id: string | null };
type Region = { id: string; name: string; company_id: string; source_region_id: string | null };
type Row = { id: string; attendance_date: string; branch_name: string; department_name: string | null; employee_name: string; employee_code: string; expected_check_in: string | null; actual_check_in: string | null; late_minutes: number; status: string };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const clock = (value: string | null) => value ? new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "—";

export function LatenessHistoryPage() {
  const user = useCurrentUserProfile();
  const [params] = useSearchParams();
  const [start, setStart] = useState(() => `${today().slice(0, 7)}-01`);
  const [end, setEnd] = useState(today);
  const [region, setRegion] = useState("");
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(20);
  useEffect(() => { setSearch(params.get("search") ?? ""); }, [params]);
  useEffect(() => { const timer = setTimeout(() => { setDebouncedSearch(search); setPage(0); }, 300); return () => clearTimeout(timer); }, [search]);
  const limited = isRegionalLatenessViewer((user.data?.roles ?? []).map((role) => role.key));
  const options = useQuery({
    queryKey: ["lateness-options", user.data?.user.id, limited], enabled: Boolean(user.data),
    queryFn: async () => {
      let branches = supabase.from("branches").select("id,name,company_id,region_id").eq("is_active", true).order("name");
      if (limited) {
        const result = await supabase.rpc("allowed_lateness_branch_ids");
        if (result.error) throw result.error;
        branches = branches.in("id", result.data ?? []);
      }
      const [b, r] = await Promise.all([branches, supabase.from("regions").select("id,name,company_id,source_region_id").eq("is_active", true).order("name")]);
      if (b.error) throw b.error;
      if (r.error) throw r.error;
      return { branches: b.data as Branch[], regions: r.data as Region[] };
    }
  });
  const selectedRegion = options.data?.regions.find((r) => r.id === region);
  const branches = (options.data?.branches ?? []).filter((b) => !region || (b.region_id === selectedRegion?.source_region_id && b.company_id === selectedRegion.company_id));
  const validDates = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;
  const query = useQuery({
    queryKey: ["lateness-history", user.data?.user.id, start, end, region, branch, debouncedSearch, page, size, limited, options.data],
    enabled: Boolean(options.data) && validDates,
    queryFn: async () => {
      let request = supabase.from("lateness_history_rows").select("id,attendance_date,branch_name,department_name,employee_name,employee_code,expected_check_in,actual_check_in,late_minutes,status", { count: "exact" })
        .gte("attendance_date", start).lte("attendance_date", end);
      if (limited) request = request.in("branch_id", (options.data?.branches ?? []).map((b) => b.id));
      if (region) request = request.eq("region_id", region);
      if (branch) request = request.eq("branch_id", branch);
      // Keep search a literal ilike pattern, never interpolate PostgREST syntax.
      if (debouncedSearch.trim()) request = request.ilike("employee_name", `%${debouncedSearch.trim().replace(/[\\%_]/g, "\\$&")}%`);
      const result = await request.order("attendance_date", { ascending: false }).order("id").range(page * size, (page + 1) * size - 1);
      if (result.error) throw result.error;
      return { rows: result.data as Row[], count: result.count ?? 0 };
    }
  });
  return <Stack spacing={2}>
    <Typography variant="h4">Histórico de tardanzas</Typography>
    <Typography color="text.secondary">Consulta las tardanzas de tus sucursales. Horas en Guatemala.</Typography>
    <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
      <TextField label="Desde" type="date" value={start} onChange={(e) => { setStart(e.target.value); setPage(0); }} InputLabelProps={{ shrink: true }} />
      <TextField label="Hasta" type="date" value={end} onChange={(e) => { setEnd(e.target.value); setPage(0); }} InputLabelProps={{ shrink: true }} />
      <TextField select label="Región" value={region} onChange={(e) => { setRegion(e.target.value); setBranch(""); setPage(0); }} sx={{ minWidth: 160 }}><MenuItem value="">Todas las permitidas</MenuItem>{options.data?.regions.map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}</TextField>
      <TextField select label="Sucursal" value={branch} onChange={(e) => { setBranch(e.target.value); setPage(0); }} sx={{ minWidth: 180 }}><MenuItem value="">Todas las permitidas</MenuItem>{branches.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}</TextField>
      <TextField label="Buscar empleado" value={search} onChange={(e) => setSearch(e.target.value)} />
    </Stack>
    {!validDates && <Alert severity="warning">Selecciona un rango de fechas válido.</Alert>}
    {(options.isLoading || query.isFetching) && <LinearProgress />}
    {(options.error || query.error) && <Alert severity="error">{(options.error || query.error)?.message}</Alert>}
    <TableContainer component={Paper}><Table aria-label="Histórico de tardanzas"><TableHead><TableRow>{["Fecha", "Sucursal", "Departamento", "Empleado", "Hora esperada", "Hora real", "Minutos tarde", "Estado"].map((label) => <TableCell key={label}>{label}</TableCell>)}</TableRow></TableHead><TableBody>
      {validDates && query.data?.rows.map((row) => <TableRow key={row.id}><TableCell>{row.attendance_date}</TableCell><TableCell>{row.branch_name}</TableCell><TableCell>{row.department_name ?? "—"}</TableCell><TableCell>{row.employee_name}<Typography variant="caption" display="block">{row.employee_code}</Typography></TableCell><TableCell>{row.expected_check_in?.slice(0, 5) ?? "—"}</TableCell><TableCell>{clock(row.actual_check_in)}</TableCell><TableCell>{row.late_minutes}</TableCell><TableCell>{row.status === "late" ? "Tarde" : row.status}</TableCell></TableRow>)}
      {validDates && !query.isFetching && query.data?.rows.length === 0 && <TableRow><TableCell colSpan={8}>No hay tardanzas para estos filtros.</TableCell></TableRow>}
    </TableBody></Table><TablePagination component="div" count={query.data?.count ?? 0} page={page} rowsPerPage={size} rowsPerPageOptions={[20, 50, 100]} labelRowsPerPage="Filas por página" onPageChange={(_, value) => setPage(value)} onRowsPerPageChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} /></TableContainer>
  </Stack>;
}
