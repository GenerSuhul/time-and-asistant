import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";
import { edgeErrorResponse } from "../_shared/errors.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const common = {
  device_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
  force: z.boolean().default(false)
};
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enqueue_day"),
    date,
    ...common,
    trace_id: z.string().uuid().optional(),
    client_clicked_at: z.string().datetime().optional()
  }).strict(),
  z.object({ action: z.literal("sync_day"), date, ...common }).strict(),
  z.object({ action: z.literal("sync_range"), start_date: date, end_date: date, ...common }).strict(),
  z.object({
    action: z.literal("sync_day_and_recalculate"),
    date,
    ...common,
    command_ids: z.array(z.string().uuid()).min(1).max(100).optional()
  }).strict()
]);

type GatewaySummary = {
  devices_scanned: number;
  events_found: number;
  events_inserted: number;
  events_updated: number;
  events_skipped: number;
  errors: Array<{ device_id: string; device_identifier: string | null; error: string }>;
  devices: Array<{ device_id: string; status?: string }>;
};

type DeviceScope = { global: boolean; companyIds: Set<string> };
type ScopedDevice = { id: string; company_id: string | null };

Deno.serve(async (req) => {
  const edgeReceivedAt = new Date().toISOString();
  const traceId = crypto.randomUUID();
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const input = schema.parse(await req.json());
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin", "branch_manager", "viewer"]);
    if (actor.type !== "user") throw new Error("An authenticated user is required");

    const startDate = input.action === "sync_range" ? input.start_date : input.date;
    const endDate = input.action === "sync_range" ? input.end_date : input.date;
    assertRange(startDate, endDate, 31);

    const scope = await actorScope(supabase, actor.user_id);
    const devices = await scopedDevices(supabase, input.device_ids, scope);
    const from = `${startDate}T00:00:00-06:00`;
    const to = `${endDate}T23:59:59-06:00`;

    if (input.action === "enqueue_day") {
      const job = await enqueueAttendanceJob(supabase, {
        date: input.date,
        devices,
        requestedBy: actor.user_id,
        force: input.force,
        traceId: input.trace_id,
        clientClickedAt: input.client_clicked_at,
        edgeReceivedAt
      });
      return jsonResponse({
        ok: true,
        state: job.status,
        timezone: "America/Guatemala",
        job
      }, job.status === "complete" || job.status === "partial" ? 200 : 202);
    }

    if (input.action === "sync_day_and_recalculate") {
      const commandIds = input.command_ids
        ? await validateCommands(supabase, input.command_ids, devices, from, to)
        : await queueCommands(supabase, devices.map((item) => item.id), actor.user_id, from, to);
      const commands = await loadCommands(supabase, commandIds);
      const { summary, processing } = summarizeCommands(commands);

      if (processing) {
        return jsonResponse({
          ok: true,
          state: "processing",
          timezone: "America/Guatemala",
          date: startDate,
          command_ids: commandIds,
          sync: { status: "processing", ...summary },
          report: null
        }, 202);
      }

      const companyIds = companyIdsForDevices(devices);
      const report = await calculateAndSummarize(supabase, startDate, companyIds);
      const syncStatus = terminalSyncStatus(summary);
      return jsonResponse({
        ok: syncStatus !== "failed",
        state: "complete",
        timezone: "America/Guatemala",
        date: startDate,
        command_ids: commandIds,
        sync: { status: syncStatus, ...summary },
        report
      });
    }

    const recentDeviceIds = input.force
      ? new Set<string>()
      : await recentSyncs(supabase, devices.map((item) => item.id), startDate, endDate);
    const staleDeviceIds = devices.map((item) => item.id).filter((id) => !recentDeviceIds.has(id));
    let summary = emptySummary();
    let processing = false;
    let commandIds: string[] = [];
    if (staleDeviceIds.length > 0) {
      commandIds = await queueCommands(supabase, staleDeviceIds, actor.user_id, from, to);
      const result = summarizeCommands(await waitForCommands(supabase, commandIds, 105_000));
      summary = result.summary;
      processing = result.processing;
    }

    if (!processing) {
      for (const current of datesBetween(startDate, endDate)) {
        for (const companyId of companyIdsForDevices(devices)) {
          await calculateAttendanceForDate(supabase, { date: current, company_id: companyId });
        }
      }
    }

    const status = processing
      ? "sincronizando"
      : summary.errors.length > 0
        ? "parcial"
        : staleDeviceIds.length === 0
          ? "sincronizado"
          : summary.events_found === 0 ? "sin_eventos" : "sincronizado";
    return jsonResponse({
      status,
      timezone: "America/Guatemala",
      start_date: startDate,
      end_date: endDate,
      command_ids: commandIds,
      devices_requested: devices.length,
      devices_skipped_recent: recentDeviceIds.size,
      already_synced: staleDeviceIds.length === 0,
      ...summary
    }, processing ? 202 : 200);
  } catch (error) {
    return edgeErrorResponse(error, traceId);
  }
});

async function enqueueAttendanceJob(supabase: any, input: {
  date: string;
  devices: ScopedDevice[];
  requestedBy: string;
  force: boolean;
  traceId?: string;
  clientClickedAt?: string;
  edgeReceivedAt: string;
}) {
  const { data: active, error: activeError } = await supabase.from("attendance_sync_jobs")
    .select("*")
    .eq("date", input.date)
    .eq("requested_by", input.requestedBy)
    .in("status", ["pending", "processing", "calculating"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw activeError;
  if (active) return { ...active, deduplicated: true };

  if (!input.force) {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: recent, error: recentError } = await supabase.from("attendance_sync_jobs")
      .select("*")
      .eq("date", input.date)
      .eq("requested_by", input.requestedBy)
      .in("status", ["complete", "partial"])
      .gte("finished_at", cutoff)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentError) throw recentError;
    if (recent) return { ...recent, deduplicated: true, skipped_recent: true };
  }

  const deviceIds = input.devices.map((item) => item.id);
  const companyIds = companyIdsForDevices(input.devices);
  const { data, error } = await supabase.from("attendance_sync_jobs").insert({
    date: input.date,
    company_ids: companyIds,
    device_ids: deviceIds,
    requested_by: input.requestedBy,
    force: input.force,
    status: "pending",
    stage: "queued",
    progress: 0,
    devices_total: deviceIds.length,
    trace_id: input.traceId ?? crypto.randomUUID(),
    client_clicked_at: input.clientClickedAt ?? null,
    edge_received_at: input.edgeReceivedAt,
    queued_at: new Date().toISOString(),
    timing: { edge_received_at: input.edgeReceivedAt }
  }).select("*").single();
  if (error) throw error;
  console.log(JSON.stringify({
    event: "attendance_sync_job_queued",
    trace_id: data.trace_id,
    job_id: data.id,
    edge_received_at: data.edge_received_at,
    queued_at: data.queued_at,
    devices_total: data.devices_total
  }));
  return { ...data, deduplicated: false };
}

async function actorScope(supabase: any, userId: string): Promise<DeviceScope> {
  const { data, error } = await supabase.from("user_roles")
    .select("company_id,roles:role_id(key)").eq("user_id", userId);
  if (error) throw error;
  const rows = data ?? [];
  const global = rows.some((entry: any) => {
    const role = Array.isArray(entry.roles) ? entry.roles[0] : entry.roles;
    return role?.key === "super_admin" && entry.company_id === null;
  });
  return { global, companyIds: new Set(rows.map((entry: any) => entry.company_id).filter(Boolean)) };
}

async function scopedDevices(supabase: any, requested: string[] | undefined, scope: DeviceScope): Promise<ScopedDevice[]> {
  let query = supabase.from("devices")
    .select("id,protocol,dev_index,branches:branch_id(company_id)")
    .eq("protocol", "hik_devicegateway").not("dev_index", "is", null);
  const uniqueRequested = requested ? [...new Set(requested)] : undefined;
  if (uniqueRequested) query = query.in("id", uniqueRequested);
  const { data, error } = await query;
  if (error) throw error;
  const devices = (data ?? []).map((item: any) => {
    const branch = Array.isArray(item.branches) ? item.branches[0] : item.branches;
    return { id: item.id as string, company_id: branch?.company_id as string | null };
  });
  const allowed = scope.global ? devices : devices.filter((item: ScopedDevice) => item.company_id && scope.companyIds.has(item.company_id));
  if (uniqueRequested && allowed.length !== uniqueRequested.length) throw new Error("One or more devices are outside the user's scope or unavailable");
  return allowed;
}

async function recentSyncs(supabase: any, deviceIds: string[], startDate: string, endDate: string) {
  if (deviceIds.length === 0) return new Set<string>();
  const from = `${startDate}T06:00:00.000Z`;
  const to = `${nextDate(endDate)}T05:59:59.000Z`;
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("device_history_sync_runs").select("device_id")
    .in("device_id", deviceIds).in("status", ["success", "partial"])
    .gte("finished_at", cutoff).lte("from_datetime", from).gte("to_datetime", to);
  if (error) throw error;
  return new Set((data ?? []).map((item: any) => item.device_id as string));
}

async function queueCommands(supabase: any, deviceIds: string[], requestedBy: string, from: string, to: string) {
  if (deviceIds.length === 0) return [];
  const { data: active, error: activeError } = await supabase.from("device_commands")
    .select("id,device_id").eq("command_type", "fetch_events")
    .in("status", ["pending", "processing"]).in("device_id", deviceIds)
    .contains("payload", { from, to });
  if (activeError) throw activeError;
  const activeDeviceIds = new Set((active ?? []).map((item: any) => item.device_id as string));
  const missing = deviceIds.filter((id) => !activeDeviceIds.has(id));
  let created: Array<{ id: string }> = [];
  if (missing.length > 0) {
    const syncRequestId = crypto.randomUUID();
    const { data, error } = await supabase.from("device_commands").insert(missing.map((deviceId) => ({
      device_id: deviceId,
      command_type: "fetch_events",
      requested_by: requestedBy,
      max_attempts: 1,
      payload: { from, to, sync_request_id: syncRequestId }
    }))).select("id");
    if (error) throw error;
    created = data ?? [];
  }
  return [...(active ?? []), ...created].map((item: any) => item.id as string);
}

async function validateCommands(supabase: any, commandIds: string[], devices: ScopedDevice[], from: string, to: string) {
  const unique = [...new Set(commandIds)];
  const commands = await loadCommands(supabase, unique);
  const deviceIds = new Set(devices.map((item) => item.id));
  const valid = commands.length === unique.length && commands.every((command: any) =>
    command.command_type === "fetch_events" && deviceIds.has(command.device_id) &&
    command.payload?.from === from && command.payload?.to === to
  );
  if (!valid) throw new Error("One or more sync commands are outside the user's scope or do not match the requested day");
  return unique;
}

async function loadCommands(supabase: any, commandIds: string[]) {
  if (commandIds.length === 0) return [];
  const { data, error } = await supabase.from("device_commands")
    .select("id,device_id,command_type,status,payload,metadata,error_message").in("id", commandIds);
  if (error) throw error;
  return data ?? [];
}

async function waitForCommands(supabase: any, commandIds: string[], waitMs: number) {
  const deadline = Date.now() + waitMs;
  let commands = await loadCommands(supabase, commandIds);
  while (commands.some((item: any) => !isTerminal(item.status)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    commands = await loadCommands(supabase, commandIds);
  }
  return commands;
}

function summarizeCommands(commands: any[]) {
  const summary = emptySummary();
  for (const command of commands) {
    const result = command.metadata?.attendance_sync_result as GatewaySummary | undefined;
    if (result) mergeGatewaySummary(summary, result);
    if (["failed", "cancelled"].includes(command.status) && !result?.errors?.length) {
      summary.errors.push({
        device_id: command.device_id,
        device_identifier: null,
        error: sanitizeError(String(command.error_message ?? "Historical sync command failed"))
      });
      summary.devices.push({ device_id: command.device_id, status: "failed" });
    }
  }
  return { summary, processing: commands.some((item: any) => !isTerminal(item.status)) };
}

async function calculateAndSummarize(supabase: any, selectedDate: string, companyIds: string[]) {
  for (const companyId of companyIds) {
    await calculateAttendanceForDate(supabase, { date: selectedDate, company_id: companyId });
  }
  if (companyIds.length === 0) return emptyReport();
  const { data, error } = await supabase.from("attendance_report_rows")
    .select("actual_check_in,actual_check_out,break_records,status")
    .eq("attendance_date", selectedDate).in("company_id", companyIds);
  if (error) throw error;
  const rows = data ?? [];
  return {
    rows: rows.length,
    with_check_in: rows.filter((row: any) => Boolean(row.actual_check_in)).length,
    with_check_out: rows.filter((row: any) => Boolean(row.actual_check_out)).length,
    with_breaks: rows.filter((row: any) => Array.isArray(row.break_records) && row.break_records.length > 0).length,
    incomplete: rows.filter((row: any) => row.status === "incomplete" || Boolean(row.actual_check_in) !== Boolean(row.actual_check_out)).length
  };
}

function terminalSyncStatus(summary: GatewaySummary): "success" | "partial" | "failed" {
  if (summary.errors.length === 0) return "success";
  const failed = summary.devices.length > 0 && summary.devices.every((item) => item.status === "failed");
  return failed ? "failed" : "partial";
}

function companyIdsForDevices(devices: ScopedDevice[]) {
  return [...new Set(devices.map((item) => item.company_id).filter(Boolean))] as string[];
}

function emptySummary(): GatewaySummary {
  return { devices_scanned: 0, events_found: 0, events_inserted: 0, events_updated: 0, events_skipped: 0, errors: [], devices: [] };
}

function emptyReport() {
  return { rows: 0, with_check_in: 0, with_check_out: 0, with_breaks: 0, incomplete: 0 };
}

function mergeGatewaySummary(target: GatewaySummary, source: GatewaySummary) {
  target.devices_scanned += Number(source.devices_scanned ?? 0);
  target.events_found += Number(source.events_found ?? 0);
  target.events_inserted += Number(source.events_inserted ?? 0);
  target.events_updated += Number(source.events_updated ?? 0);
  target.events_skipped += Number(source.events_skipped ?? 0);
  target.errors.push(...(source.errors ?? []));
  target.devices.push(...(source.devices ?? []));
}

function isTerminal(status: string) {
  return ["success", "failed", "cancelled"].includes(status);
}

function datesBetween(start: string, end: string) {
  const result: string[] = [];
  let current = start;
  while (current <= end) { result.push(current); current = nextDate(current); }
  return result;
}

function nextDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function assertRange(start: string, end: string, maxDays: number) {
  const days = Math.floor((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (days < 1 || days > maxDays) throw new Error(`Date range must contain between 1 and ${maxDays} days`);
}

function sanitizeError(message: string) {
  return message.replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}
