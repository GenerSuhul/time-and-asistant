import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("daily"), date, company_id: z.string().uuid().optional(), branch_id: z.string().uuid().optional(), employee_id: z.string().uuid().optional(), recalculate: z.boolean().default(false) }),
  z.object({ action: z.literal("range"), start_date: date, end_date: date, company_id: z.string().uuid().optional(), branch_id: z.string().uuid().optional(), employee_id: z.string().uuid().optional(), recalculate: z.boolean().default(false) }),
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
    else if (companyIds && companyIds.length === 0) return jsonResponse({ timezone: "America/Guatemala", start_date: start, end_date: end, rows: [] });
    if (input.branch_id) query = query.eq("branch_id", input.branch_id);
    if (input.employee_id) query = query.eq("employee_id", input.employee_id);
    const { data: rows, error } = await query;
    if (error) throw error;
    const reportRows = rows ?? [];
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
      .select("id,status,stage,progress,devices_total,devices_done,events_found,events_inserted,events_skipped,error_message,started_at,finished_at,created_at")
      .eq("date", start).eq("requested_by", actor.user_id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (jobError) throw jobError;
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
      active_job: latestJob?.status?.match(/pending|processing|calculating/) ? latestJob : null
    });
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
    return role?.key === "super_admin" && entry.company_id === null;
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
