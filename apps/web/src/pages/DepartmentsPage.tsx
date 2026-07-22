import { useMemo, useState } from "react";
import {
  Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, IconButton, LinearProgress, MenuItem, Paper, Stack, Switch, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Typography
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invokeEdge } from "../lib/edgeFunction";
import { supabase } from "../lib/supabase";

type Row = Record<string, any>;
const empty = { id: "", company_id: "", name: "", code: "", scope: "global", is_active: true, branch_ids: [] as string[] };

export function DepartmentsPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null);
  const catalogs = useQuery({ queryKey: ["department-catalogs"], queryFn: async () => {
    const [companies, branches] = await Promise.all([
      supabase.from("companies").select("id,name").order("name"),
      supabase.from("branches").select("id,name,company_id,is_active").order("name")
    ]);
    if (companies.error) throw companies.error;
    if (branches.error) throw branches.error;
    return { companies: companies.data ?? [], branches: branches.data ?? [] };
  }});
  const departments = useQuery({ queryKey: ["departments-scoped"], queryFn: async () => {
    const { data, error } = await supabase.from("departments")
      .select("id,company_id,name,code,scope,is_active,companies:company_id(name),department_branches(branch_id,branches:branch_id(id,name))")
      .order("name");
    if (error) throw error;
    return data ?? [];
  }});
  const availableBranches = useMemo(() => (catalogs.data?.branches ?? []).filter((item) => !form.company_id || item.company_id === form.company_id), [catalogs.data?.branches, form.company_id]);
  const selectedBranches = availableBranches.filter((item) => form.branch_ids.includes(item.id));

  const save = useMutation({ mutationFn: async () => {
    if (!form.company_id || !form.name.trim()) throw new Error("Empresa y nombre son obligatorios.");
    if (!form.branch_ids.length) throw new Error("Selecciona al menos una sucursal.");
    if (form.scope === "branch" && form.branch_ids.length !== 1) throw new Error("Un departamento exclusivo requiere exactamente una sucursal.");
    await invokeEdge("admin-departments", {
      action: form.id ? "update" : "create", id: form.id || undefined,
      department: { company_id: form.company_id, name: form.name.trim(), code: form.code.trim() || null,
        scope: form.scope, is_active: form.is_active, branch_ids: form.branch_ids }
    });
  }, onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["departments-scoped"] }); setOpen(false); setForm(empty); }});
  const remove = useMutation({ mutationFn: async (id: string) => invokeEdge("admin-departments", { action: "delete", id }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["departments-scoped"] }); setDeleteTarget(null); }});

  function start(row?: Row) {
    const branchIds = row ? (row.department_branches ?? []).map((item: Row) => item.branch_id) : [];
    setForm(row ? { id: row.id, company_id: row.company_id, name: row.name, code: row.code ?? "", scope: row.scope,
      is_active: row.is_active, branch_ids: branchIds } : { ...empty, company_id: catalogs.data?.companies[0]?.id ?? "", branch_ids: [] });
    save.reset();
    setOpen(true);
  }

  return <Stack spacing={2}>
    <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" gap={1}>
      <Box><Typography variant="h4">Departamentos</Typography><Typography color="text.secondary">Alcance por empresa y sucursales, sin duplicar departamentos.</Typography></Box>
      <Button variant="contained" startIcon={<AddIcon />} onClick={() => start()}>Añadir departamento</Button>
    </Stack>
    {(departments.error || catalogs.error || save.error || remove.error) && <Alert severity="error">{String(departments.error?.message ?? catalogs.error?.message ?? save.error?.message ?? remove.error?.message)}</Alert>}
    {(departments.isLoading || catalogs.isLoading) && <LinearProgress />}
    <TableContainer component={Paper} variant="outlined"><Table size="small"><TableHead><TableRow>
      <TableCell>Nombre</TableCell><TableCell>Empresa</TableCell><TableCell>Alcance</TableCell><TableCell>Sucursales asignadas</TableCell><TableCell>Activo</TableCell><TableCell align="right">Acciones</TableCell>
    </TableRow></TableHead><TableBody>{(departments.data ?? []).map((row: Row) => {
      const branches = (row.department_branches ?? []).map((item: Row) => Array.isArray(item.branches) ? item.branches[0] : item.branches).filter(Boolean);
      const scope = row.scope === "branch" ? "Sucursal específica" : branches.length === (catalogs.data?.branches ?? []).filter((item) => item.company_id === row.company_id).length ? "Global" : `${branches.length} sucursales`;
      return <TableRow key={row.id} hover><TableCell><Typography fontWeight={650}>{row.name}</Typography><Typography variant="caption" color="text.secondary">{row.code || "Sin código"}</Typography></TableCell>
        <TableCell>{(Array.isArray(row.companies) ? row.companies[0] : row.companies)?.name}</TableCell><TableCell><Chip size="small" label={scope} color={row.scope === "global" ? "primary" : "default"} variant="outlined" /></TableCell>
        <TableCell><Stack direction="row" gap={0.5} flexWrap="wrap">{branches.map((branch: Row) => <Chip key={branch.id} size="small" label={branch.name} />)}</Stack></TableCell>
        <TableCell>{row.is_active ? "Sí" : "No"}</TableCell><TableCell align="right"><IconButton onClick={() => start(row)}><EditIcon fontSize="small" /></IconButton><IconButton color="error" onClick={() => setDeleteTarget(row)}><DeleteIcon fontSize="small" /></IconButton></TableCell></TableRow>;
    })}</TableBody></Table></TableContainer>

    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md"><DialogTitle>{form.id ? "Editar departamento" : "Añadir departamento"}</DialogTitle><DialogContent><Stack spacing={2} sx={{ mt: 1 }}>
      <TextField select label="Empresa" value={form.company_id} onChange={(event) => setForm((current) => ({ ...current, company_id: event.target.value, branch_ids: [] }))}>{catalogs.data?.companies.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}</TextField>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}><TextField fullWidth label="Nombre" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /><TextField fullWidth label="Código (opcional)" value={form.code} onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))} /></Stack>
      <TextField select label="Alcance" value={form.scope} onChange={(event) => setForm((current) => ({ ...current, scope: event.target.value, branch_ids: event.target.value === "branch" ? current.branch_ids.slice(0, 1) : current.branch_ids }))}><MenuItem value="global">Asignar a varias sucursales</MenuItem><MenuItem value="branch">Solo una sucursal</MenuItem></TextField>
      <Autocomplete multiple options={availableBranches} value={selectedBranches} getOptionLabel={(option) => option.name}
        onChange={(_, values) => setForm((current) => ({ ...current, branch_ids: form.scope === "branch" ? values.slice(-1).map((item) => item.id) : values.map((item) => item.id) }))}
        renderInput={(params) => <TextField {...params} label="Sucursales" placeholder="Buscar sucursal" />}
        renderTags={(values, getTagProps) => values.map((option, index) => <Chip label={option.name} {...getTagProps({ index })} key={option.id} />)} />
      {form.scope === "global" && <Stack direction="row" spacing={1}><Button size="small" onClick={() => setForm((current) => ({ ...current, branch_ids: availableBranches.map((item) => item.id) }))}>Seleccionar todas</Button><Button size="small" onClick={() => setForm((current) => ({ ...current, branch_ids: [] }))}>Limpiar</Button></Stack>}
      <FormControlLabel control={<Switch checked={form.is_active} onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))} />} label="Activo" />
      {save.error && <Alert severity="error">{save.error.message}</Alert>}
    </Stack></DialogContent><DialogActions><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant="contained" disabled={save.isPending} onClick={() => save.mutate()}>Guardar</Button></DialogActions></Dialog>

    <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)}><DialogTitle>Eliminar departamento</DialogTitle><DialogContent><Typography>Se eliminará “{deleteTarget?.name}”. Si tiene personas o reportes asociados, la operación será bloqueada y podrás desactivarlo.</Typography>{remove.error && <Alert severity="error" sx={{ mt: 2 }}>{remove.error.message}</Alert>}</DialogContent><DialogActions><Button onClick={() => setDeleteTarget(null)}>Cancelar</Button><Button color="error" variant="contained" disabled={remove.isPending} onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}>Eliminar</Button></DialogActions></Dialog>
  </Stack>;
}
