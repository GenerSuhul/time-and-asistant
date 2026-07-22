import { z } from "https://esm.sh/zod@3.24.2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { requireRole } from "../_shared/auth.ts";
import { edgeErrorResponse } from "../_shared/errors.ts";

const schema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branch_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional(),
  status: z.string().optional()
});

Deno.serve(async (req) => {
  const traceId = crypto.randomUUID();
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
        employees:employee_id(full_name, employee_code, department_id),
        branches:branch_id(name),
        attendance_report_rules:rule_id(name)
      `)
      .gte("attendance_date", filters.start_date)
      .lte("attendance_date", filters.end_date)
      .order("attendance_date", { ascending: true });

    if (filters.branch_id) query = query.eq("branch_id", filters.branch_id);
    if (filters.employee_id) query = query.eq("employee_id", filters.employee_id);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.device_id) query = query.contains("device_ids", [filters.device_id]);

    const { data, error } = await query;
    if (error) throw error;

    const departmentIds = [...new Set((data ?? []).map((row) => row.employees?.department_id).filter(Boolean))];
    const { data: departments } = departmentIds.length ? await supabase.from("departments").select("id,name").in("id", departmentIds) : { data: [] };

    const departmentById = new Map((departments ?? []).map((item) => [item.id, item.name]));

    const rows = (data ?? [])
      .filter((row) => !filters.department_id || row.employees?.department_id === filters.department_id)
      .map((row) => ({
        Departamento: departmentById.get(row.employees?.department_id) ?? "",
        Nombre: row.employees?.full_name ?? "",
        Horario: row.attendance_report_rules?.name ?? "",
        Fecha: row.attendance_date,
        "Hora real del registro de entrada": formatGuatemala(row.actual_check_in),
        "Hora real de registro de salida": formatGuatemala(row.actual_check_out),
        "Grabación de asistencia": row.actual_check_in || row.actual_check_out ? `${formatGuatemala(row.actual_check_in)} / ${formatGuatemala(row.actual_check_out)}` : "Ninguno",
        "Duración de la pausa": `${row.lunch_minutes ?? 0} min`,
        "Registros de descansos": formatBreaks(row.break_records),
        "Periodo de tiempo": `${Number(((row.worked_minutes ?? 0) / 60).toFixed(2))} h`
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
    return edgeErrorResponse(error, traceId);
  }
});

function formatGuatemala(value: string | null | undefined) {
  if (!value) return "Ninguno";
  return new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date(value));
}

function formatBreaks(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "-";
  return value.map((item: any) => `${formatGuatemala(item?.out)} - ${formatGuatemala(item?.in)} (${item?.minutes ?? 0} min)`).join("; ");
}
