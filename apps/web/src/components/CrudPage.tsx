import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
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
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { StatusChip } from "./StatusChip";

export type CrudField = {
  name: string;
  label: string;
  type?: "text" | "number" | "date" | "time" | "datetime-local" | "boolean" | "select" | "textarea";
  required?: boolean;
  options?: string[];
  helperText?: string;
};

export type CrudColumn = {
  name: string;
  label: string;
  status?: boolean;
};

type CrudPageProps = {
  title: string;
  table: string;
  columns: CrudColumn[];
  fields: CrudField[];
  orderBy?: string;
};

type Row = Record<string, unknown> & { id: string };

function emptyForm(fields: CrudField[]) {
  return Object.fromEntries(fields.map((field) => [field.name, field.type === "boolean" ? false : ""]));
}

function cleanPayload(values: Record<string, unknown>, fields: CrudField[]) {
  return Object.fromEntries(
    fields.map((field) => {
      const value = values[field.name];
      if (field.type === "boolean") return [field.name, Boolean(value)];
      if (value === "") return [field.name, null];
      if (field.type === "number") return [field.name, Number(value)];
      return [field.name, value];
    })
  );
}

export function CrudPage({ title, table, columns, fields, orderBy = "created_at" }: CrudPageProps) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const incomingSearch = searchParams.get("search") ?? "";
  const [filter, setFilter] = useState(incomingSearch);
  const [editing, setEditing] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>(() => emptyForm(fields));

  useEffect(() => {
    setFilter(incomingSearch);
  }, [incomingSearch]);

  const query = useQuery({
    queryKey: [table],
    queryFn: async () => {
      const { data, error } = await supabase.from(table).select("*").order(orderBy, { ascending: false });
      if (error) throw error;
      return (data ?? []) as Row[];
    }
  });

  const rows = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (!text) return query.data ?? [];
    return (query.data ?? []).filter((row) => JSON.stringify(row).toLowerCase().includes(text));
  }, [filter, query.data]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = cleanPayload(form, fields);
      const request = editing
        ? supabase.from(table).update(payload).eq("id", editing.id)
        : supabase.from(table).insert(payload);
      const { error } = await request;
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [table] });
      setOpen(false);
    }
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [table] })
  });

  function startCreate() {
    setEditing(null);
    setForm(emptyForm(fields));
    setOpen(true);
  }

  function startEdit(row: Row) {
    setEditing(row);
    setForm(Object.fromEntries(fields.map((field) => [field.name, row[field.name] ?? (field.type === "boolean" ? false : "")])));
    setOpen(true);
  }

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
        <Box>
          <Typography variant="h5">{title}</Typography>
          <Typography variant="body2" color="text.secondary">
            Gestiona registros desde Supabase con RLS activo.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <IconButton onClick={() => query.refetch()} aria-label="refrescar">
            <RefreshIcon />
          </IconButton>
          <Button variant="contained" startIcon={<AddIcon />} onClick={startCreate}>
            Nuevo
          </Button>
        </Stack>
      </Stack>

      <TextField
        size="small"
        label="Filtro"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          )
        }}
      />
      {query.isLoading && <LinearProgress />}
      {query.error && <Alert severity="error">{query.error.message}</Alert>}
      {!query.isLoading && rows.length === 0 && <Alert severity="info">No hay registros para mostrar.</Alert>}

      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map((column) => (
                <TableCell key={column.name}>{column.label}</TableCell>
              ))}
              <TableCell align="right">Acciones</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} hover>
                {columns.map((column) => (
                  <TableCell key={column.name}>
                    {column.status ? <StatusChip value={String(row[column.name] ?? "")} /> : String(row[column.name] ?? "")}
                  </TableCell>
                ))}
                <TableCell align="right">
                  <IconButton size="small" onClick={() => startEdit(row)} aria-label="editar">
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" color="error" onClick={() => remove.mutate(row.id)} aria-label="eliminar">
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{editing ? "Editar" : "Nuevo"} {title}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {fields.map((field) =>
              field.type === "boolean" ? (
                <FormControlLabel
                  key={field.name}
                  control={
                    <Checkbox
                      checked={Boolean(form[field.name])}
                      onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.checked }))}
                    />
                  }
                  label={field.label}
                />
              ) : (
                <TextField
                  key={field.name}
                  label={field.label}
                  required={field.required}
                  select={field.type === "select"}
                  multiline={field.type === "textarea"}
                  minRows={field.type === "textarea" ? 3 : undefined}
                  type={field.type && field.type !== "select" && field.type !== "textarea" ? field.type : "text"}
                  value={form[field.name] ?? ""}
                  helperText={field.helperText}
                  onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))}
                  InputLabelProps={field.type === "date" || field.type === "time" || field.type === "datetime-local" ? { shrink: true } : undefined}
                >
                  {(field.options ?? []).map((option) => (
                    <MenuItem key={option} value={option}>
                      {option.replaceAll("_", " ")}
                    </MenuItem>
                  ))}
                </TextField>
              )
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
          <Button variant="contained" onClick={() => save.mutate()} disabled={save.isPending}>
            Guardar
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
