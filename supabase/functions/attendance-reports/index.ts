import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reportFilters = {
  company_id: z.string().uuid().optional(),
  branch_id: z.string().uuid().optional(),
  department_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional()
};
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("daily"), date, ...reportFilters, recalculate: z.boolean().default(false) }),
  z.object({ action: z.literal("range"), start_date: date, end_date: date, ...reportFilters, recalculate: z.boolean().default(false) }),
  z.object({ action: z.literal("sync_events"), start_date: date, end_date: date, device_ids: z.array(z.string().uuid()).min(1).max(100) })
]);

Deno.serve(async (req) => {
  const receivedAt = Date.now();
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const input = schema.parse(await req.json());
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin", "branch_manager", "viewer"]);
    if (actor.type !== "user") throw new Error("An authenticated user is required");

    const scope = await actorScope(supabase, actor.user_id);

    if (input.action === "sync_events") {
      assertRange(input.start_date, input.end_date, 31);
      const deviceIds = [...new Set(input.device_ids)];
      await assertDeviceScope(supabase, deviceIds, scope);
      const commands = deviceIds.map((device_id) => ({
        device_id, command_type: "fetch_events", requested_by: actor.user_id,
        payload: { from: `${input.start_date}T00:00:00-06:00`, to: `${input.end_date}T23:59:59-06:00` }
      }));
      const { data, error } = await supabase.from("device_commands").insert(commands).select("id,device_id,status");
      if (error) throw error;
      return jsonResponse({ queued: data?.length ?? 0, commands: data }, 202);
    }

    const start = input.action === "daily" ? input.date : input.start_date;
    const end = input.action === "daily" ? input.date : input.end_date;
    assertRange(start, end, 366);
    const companyIds = input.company_id
      ? assertCompanyScope(input.company_id, scope)
      : scope.global ? null : [...scope.companyIds];
    if (input.recalculate) {
      for (const current of datesBetween(start, end)) {
        if (companyIds === null) {
          await calculateAttendanceForDate(supabase, { date: current, branch_id: input.branch_id, employee_id: input.employee_id });
        } else {
          for (const companyId of companyIds) {
            await calculateAttendanceForDate(supabase, { date: current, company_id: companyId, branch_id: input.branch_id, employee_id: input.employee_id });
          }
        }
      }
    }
    let query = supabase.from("attendance_report_rows").select("*")
      .gte("attendance_date", start).lte("attendance_date", end).order("attendance_date").order("employee_name");
    if (companyIds?.length) query = query.in("company_id", companyIds);
    else if (companyIds && companyIds.length === 0) query = query.is("company_id", null);
    const { data: rows, error } = await query;
    if (error) throw error;
    const scopedRows = rows ?? [];
    const activeFilters = [
      input.branch_id && "sucursal",
      input.department_id && "departamento",
      input.employee_id && "empleado",
      input.device_id && "dispositivo"
    ].filter(Boolean) as string[];
    const reportRows = scopedRows.filter((row: any) =>
      (!input.branch_id || row.branch_id === input.branch_id) &&
      (!input.department_id || row.department_id === input.department_id) &&
      (!input.employee_id || row.employee_id === input.employee_id) &&
      (!input.device_id || (Array.isArray(row.device_ids) && row.device_ids.includes(input.device_id)))
    );
    const ids = reportRows.map((row: any) => row.id as string);
    let lastCalculatedAt: string | null = null;
    if (ids.length > 0) {
      const { data: calculated, error: calculatedError } = await supabase.from("daily_attendance")
        .select("calculated_at").in("id", ids)
        .order("calculated_at", { ascending: false }).limit(1).maybeSingle();
      if (calculatedError) throw calculatedError;
      lastCalculatedAt = calculated?.calculated_at ?? null;
    }
    const { data: latestJob, error: jobError } = await supabase.from("attendance_sync_jobs")
      .select("id,status,stage,progress,devices_total,devices_done,events_found,events_inserted,events_skipped,error_message,device_results,trace_id,timing,started_at,finished_at,created_at")
      .eq("date", start).eq("requested_by", actor.user_id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (jobError) throw jobError;
    const diagnostics = start === end
      ? await dailyDiagnostics(supabase, {
        date: start,
        companyIds,
        branchId: input.branch_id,
        departmentId: input.department_id,
        employeeId: input.employee_id,
        deviceId: input.device_id,
        activeFilters,
        scopedRows: scopedRows.length,
        filteredRows: reportRows.length,
        latestJob
      })
      : null;
    const isToday = start === end && start === todayInGuatemala();
    const calculatedAgeMs = lastCalculatedAt ? Date.now() - new Date(lastCalculatedAt).getTime() : Number.POSITIVE_INFINITY;
    const stale = reportRows.length === 0 || (isToday && calculatedAgeMs > 15 * 60 * 1000 && !latestJob?.status?.match(/pending|processing|calculating/));
    return jsonResponse({
      timezone: "America/Guatemala",
      start_date: start,
      end_date: end,
      rows: reportRows,
      cache: {
        hit: reportRows.length > 0,
        stale,
        last_calculated_at: lastCalculatedAt,
        response_ms: Date.now() - receivedAt
      },
      diagnostics,
      latest_job: latestJob,
      active_job: latestJob?.status?.match(/pending|processing|calculating/) ? latestJob : null
    });
    console.log(JSON.stringify({
      event: "attendance_report_returned",
      actor_id: actor.user_id,
      date: start,
      rows: reportRows.length,
      scoped_rows: scopedRows.length,
      diagnostic_reason: diagnostics?.reason ?? null,
      response_ms: Date.now() - receivedAt
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message.slice(0, 500) }, 400);
  }
});

function todayInGuatemala() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function actorScope(supabase: any, userId: string) {
  const { data, error } = await supabase.from("user_roles")
    .select("company_id,roles:role_id(key)").eq("user_id", userId);
  if (error) throw error;
  const rows = data ?? [];
  const global = rows.some((entry: any) => {
    const role = Array.isArray(entry.roles) ? entry.roles[0] : entry.roles;
    return ["super_admin", "it_admin", "hr_admin"].includes(role?.key) && entry.company_id === null;
  });
  return { global, companyIds: new Set<string>(rows.map((entry: any) => entry.company_id).filter(Boolean)) };
}

function assertCompanyScope(companyId: string, scope: { global: boolean; companyIds: Set<string> }) {
  if (!scope.global && !scope.companyIds.has(companyId)) throw new Error("Company is outside the user's scope");
  return [companyId];
}

async function assertDeviceScope(supabase: any, deviceIds: string[], scope: { global: boolean; companyIds: Set<string> }) {
  const { data, error } = await supabase.from("devices")
    .select("id,branches:branch_id(company_id)").in("id", deviceIds);
  if (error) throw error;
  const allowed = (data ?? []).filter((device: any) => {
    const branch = Array.isArray(device.branches) ? device.branches[0] : device.branches;
    return scope.global || (branch?.company_id && scope.companyIds.has(branch.company_id));
  });
  if (allowed.length !== deviceIds.length) throw new Error("One or more devices are outside the user's scope or unavailable");
}

function datesBetween(start: string, end: string) {
  const result: string[] = [];
  let current = start;
  while (current <= end) { result.push(current); current = nextDate(current); }
  return result;
}
function nextDate(value: string) {
  const dateValue = new Date(`${value}T00:00:00Z`);
  dateValue.setUTCDate(dateValue.getUTCDate() + 1);
  return dateValue.toISOString().slice(0, 10);
}
function assertRange(start: string, end: string, maxDays: number) {
  const days = Math.floor((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000) + 1;
  if (days < 1 || days > maxDays) throw new Error(`Date range must contain between 1 and ${maxDays} days`);
}

async function dailyDiagnostics(supabase: any, input: {
  date: string;
  companyIds: string[] | null;
  branchId?: string;
  departmentId?: string;
  employeeId?: string;
  deviceId?: string;
  activeFilters: string[];
  scopedRows: number;
  filteredRows: number;
  latestJob: any;
}) {
  const noMatchId = "00000000-0000-0000-0000-000000000000";
  let scopedBranchIds: string[] | null = null;
  if (input.companyIds !== null) {
    if (input.companyIds.length === 0) {
      scopedBranchIds = [];
    } else {
      const { data, error } = await supabase.from("branches").select("id").in("company_id", input.companyIds);
      if (error) throw error;
      scopedBranchIds = (data ?? []).map((branch: any) => branch.id as string);
    }
  }
  let employeeQuery = supabase.from("employees").select("id").eq("status", "active");
  if (input.companyIds?.length) employeeQuery = employeeQuery.in("company_id", input.companyIds);
  else if (input.companyIds && input.companyIds.length === 0) employeeQuery = employeeQuery.eq("id", noMatchId);
  if (input.branchId) employeeQuery = employeeQuery.eq("branch_id", input.branchId);
  if (input.departmentId) employeeQuery = employeeQuery.eq("department_id", input.departmentId);
  if (input.employeeId) employeeQuery = employeeQuery.eq("id", input.employeeId);
  const { data: eligibleEmployeeRows, error: employeeError } = await employeeQuery;
  if (employeeError) throw employeeError;
  const eligibleEmployeeIds = (eligibleEmployeeRows ?? []).map((employee: any) => employee.id as string);
  let assignedEmployees = 0;
  if (eligibleEmployeeIds.length > 0) {
    let assignmentQuery = supabase.from("employee_devices")
      .select("employee_id").in("employee_id", eligibleEmployeeIds);
    if (input.deviceId) assignmentQuery = assignmentQuery.eq("device_id", input.deviceId);
    const { data, error } = await assignmentQuery;
    if (error) throw error;
    assignedEmployees = new Set((data ?? []).map((assignment: any) => assignment.employee_id)).size;
  }
  const applyEventScope = (query: any) => {
    query = query.eq("event_date_local", input.date);
    if (input.companyIds?.length) query = query.in("company_id", input.companyIds);
    else if (input.companyIds && input.companyIds.length === 0) query = query.is("company_id", null);
    if (input.branchId) query = query.eq("branch_id", input.branchId);
    if (input.employeeId) query = query.eq("employee_id", input.employeeId);
    else if (input.departmentId) query = eligibleEmployeeIds.length
      ? query.in("employee_id", eligibleEmployeeIds)
      : query.eq("employee_id", noMatchId);
    if (input.deviceId) query = query.eq("device_id", input.deviceId);
    return query;
  };
  const next = nextDate(input.date);
  const applyRawScope = (query: any) => {
    query = query.gte("occurred_at", `${input.date}T00:00:00-06:00`)
      .lt("occurred_at", `${next}T00:00:00-06:00`);
    if (scopedBranchIds?.length) query = query.in("branch_id", scopedBranchIds);
    else if (scopedBranchIds && scopedBranchIds.length === 0) query = query.is("branch_id", null);
    if (input.branchId) query = query.eq("branch_id", input.branchId);
    if (input.employeeId) query = query.eq("employee_id", input.employeeId);
    else if (input.departmentId) query = eligibleEmployeeIds.length
      ? query.in("employee_id", eligibleEmployeeIds)
      : query.eq("employee_id", noMatchId);
    if (input.deviceId) query = query.eq("device_id", input.deviceId);
    return query;
  };
  const [
    rawEvents,
    normalizedEvents,
    linkedEvents,
    validAttendanceEvents,
    unlinkedEvents,
    technicalEvents
  ] = await Promise.all([
    countRows(supabase, "raw_access_events", applyRawScope),
    countRows(supabase, "attendance_events", applyEventScope),
    countRows(supabase, "attendance_events", (query) => applyEventScope(query).not("employee_id", "is", null)),
    countRows(supabase, "attendance_events", (query) =>
      applyEventScope(query).not("employee_id", "is", null).neq("event_type", "unknown")),
    countRows(supabase, "attendance_events", (query) => applyEventScope(query).is("employee_id", null)),
    countRows(supabase, "attendance_events", (query) => applyEventScope(query).eq("event_type", "unknown"))
  ]);

  const jobFound = Number(input.latestJob?.events_found ?? 0);
  const jobSkipped = Number(input.latestJob?.events_skipped ?? 0);
  const historyWithoutNormalizedRow = input.activeFilters.length === 0
    ? Math.max(0, jobFound - normalizedEvents)
    : null;
  const idempotentExisting = historyWithoutNormalizedRow === null
    ? null
    : Math.max(0, jobSkipped - historyWithoutNormalizedRow);

  let reason: string | null = null;
  let message: string | null = null;
  if (input.filteredRows === 0) {
    if (eligibleEmployeeIds.length === 0 && input.activeFilters.length > 0) {
      reason = "no_eligible_employees";
      message = "No hay empleados activos que coincidan con la selección.";
    } else if (input.deviceId && assignedEmployees === 0) {
      reason = "no_assigned_employees";
      message = "El dispositivo seleccionado no tiene empleados asignados para estos filtros.";
    } else if (input.activeFilters.length > 0 && input.scopedRows > 0) {
      reason = "filters_active_no_results";
      message = `Filtros activos sin resultados: ${input.activeFilters.join(", ")}.`;
    } else if (rawEvents === 0 && normalizedEvents === 0) {
      reason = "no_device_events";
      message = "No hay eventos guardados para esta fecha. Puedes buscarlos en los dispositivos.";
    } else if (normalizedEvents === 0) {
      reason = "normalization_missing";
      message = "Hay eventos crudos, pero todavía no se han normalizado como eventos de asistencia.";
    } else if (linkedEvents === 0) {
      reason = "events_not_linked";
      message = "Eventos encontrados pero no vinculados a empleados.";
    } else if (validAttendanceEvents === 0) {
      reason = "technical_events_only";
      message = "Solo se encontraron eventos técnicos; no hay marcajes válidos de asistencia.";
    } else if (input.scopedRows === 0) {
      reason = "daily_calculation_missing";
      message = "Hay marcajes válidos, pero falta calcular el reporte diario.";
    } else {
      reason = "no_report_rows";
      message = "No hay filas que coincidan con la selección actual.";
    }
  }

  return {
    reason,
    message,
    active_filters: input.activeFilters,
    raw_events: rawEvents,
    normalized_events: normalizedEvents,
    linked_events: linkedEvents,
    valid_attendance_events: validAttendanceEvents,
    unlinked_events: unlinkedEvents,
    technical_events: technicalEvents,
    eligible_employees: eligibleEmployeeIds.length,
    assigned_employees: assignedEmployees,
    history_records_without_normalized_row: historyWithoutNormalizedRow,
    idempotent_existing_events: idempotentExisting,
    daily_rows_before_filters: input.scopedRows,
    daily_rows_after_filters: input.filteredRows
  };
}

async function countRows(supabase: any, table: string, apply: (query: any) => any) {
  const { count, error } = await apply(supabase.from(table).select("*", { count: "exact", head: true }));
  if (error) throw error;
  return count ?? 0;
}
