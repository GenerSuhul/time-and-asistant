import { z } from "https://esm.sh/zod@3.24.2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { requireRole } from "../_shared/auth.ts";

const schema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branch_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional(),
  status: z.string().optional()
});

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const filters = schema.parse(await req.json());
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin", "branch_manager", "viewer"]);

    let query = supabase
      .from("daily_attendance")
      .select(`
        *,
        employees:employee_id(full_name, employee_code, department_id, attendance_group_id),
        branches:branch_id(name),
        work_schedules:schedule_id(name)
      `)
      .gte("attendance_date", filters.start_date)
      .lte("attendance_date", filters.end_date)
      .order("attendance_date", { ascending: true });

    if (filters.branch_id) query = query.eq("branch_id", filters.branch_id);
    if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
    if (filters.status) query = query.eq("status", filters.status);

    const { data, error } = await query;
    if (error) throw error;

    const departmentIds = [...new Set((data ?? []).map((row) => row.employees?.department_id).filter(Boolean))];
    const groupIds = [...new Set((data ?? []).map((row) => row.employees?.attendance_group_id).filter(Boolean))];

    const [{ data: departments }, { data: groups }] = await Promise.all([
      departmentIds.length ? supabase.from("departments").select("id,name").in("id", departmentIds) : Promise.resolve({ data: [] }),
      groupIds.length ? supabase.from("attendance_groups").select("id,name").in("id", groupIds) : Promise.resolve({ data: [] })
    ]);

    const departmentById = new Map((departments ?? []).map((item) => [item.id, item.name]));
    const groupById = new Map((groups ?? []).map((item) => [item.id, item.name]));

    const rows = (data ?? [])
      .filter((row) => !filters.department_id || row.employees?.department_id === filters.department_id)
      .map((row) => ({
        Departamento: departmentById.get(row.employees?.department_id) ?? "",
        "Grupo de asistencia": groupById.get(row.employees?.attendance_group_id) ?? "",
        Sucursal: row.branches?.name ?? "",
        Nombre: row.employees?.full_name ?? "",
        "Codigo empleado": row.employees?.employee_code ?? "",
        Fecha: row.attendance_date,
        Horario: row.work_schedules?.name ?? "",
        "Entrada esperada": row.expected_check_in ?? "",
        "Entrada real": row.actual_check_in ?? "",
        "Minutos tarde": row.late_minutes ?? 0,
        "Salida almuerzo": row.lunch_out ?? "",
        "Entrada almuerzo": row.lunch_in ?? "",
        "Duracion almuerzo": row.lunch_minutes ?? 0,
        "Salida esperada": row.expected_check_out ?? "",
        "Salida real": row.actual_check_out ?? "",
        "Horas trabajadas": Number(((row.worked_minutes ?? 0) / 60).toFixed(2)),
        "Horas extra": Number(((row.overtime_minutes ?? 0) / 60).toFixed(2)),
        Estado: row.status,
        Observaciones: Array.isArray(row.warnings) ? row.warnings.join("; ") : ""
      }));

    const header = [
      ["Reporte de asistencia"],
      [`Generado: ${new Date().toISOString()}`],
      [`Filtros: ${filters.start_date} a ${filters.end_date}`],
      []
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(header);
    XLSX.utils.sheet_add_json(worksheet, rows, { origin: "A5" });
    worksheet["!cols"] = Object.keys(rows[0] ?? { Departamento: "" }).map((key) => ({ wch: Math.max(14, key.length + 2) }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Asistencia");
    const workbookBytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const path = `attendance-${filters.start_date}-${filters.end_date}-${Date.now()}.xlsx`;

    const { error: uploadError } = await supabase.storage
      .from("exports")
      .upload(path, workbookBytes, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: true
      });
    if (uploadError) throw uploadError;

    const { data: signed } = await supabase.storage.from("exports").createSignedUrl(path, 60 * 30);
    return jsonResponse({ path, signed_url: signed?.signedUrl ?? null, rows: rows.length });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
