import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const terminalSyncStatuses = ["complete", "partial", "failed"];

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    const clock = guatemalaClock();
    const targetDate = previousDate(clock.date);
    const errors: string[] = [];
    let runsAdvanced = 0;
    let runsCreated = 0;

    const { data: syncingRuns, error: syncingError } = await supabase.from("attendance_report_runs")
      .select("id,report_date,sync_job_id,status")
      .eq("status", "syncing")
      .lte("report_date", targetDate);
    if (syncingError) throw syncingError;
    for (const run of syncingRuns ?? []) {
      try {
        if (run.sync_job_id) {
          const { data: syncJob, error } = await supabase.from("attendance_sync_jobs")
            .select("status,error_message").eq("id", run.sync_job_id).single();
          if (error) throw error;
          if (!terminalSyncStatuses.includes(syncJob.status)) continue;
          await supabase.from("attendance_report_runs").update({ sync_status: syncJob.status }).eq("id", run.id);
        }
        await invokeGenerator(supabase, run.id, run.report_date);
        runsAdvanced += 1;
      } catch (error) {
        errors.push(`run ${run.id}: ${sanitizeError(error)}`);
      }
    }

    const { data: configs, error: configsError } = await supabase.from("attendance_report_configs")
      .select("*").eq("is_active", true).lte("send_time", `${clock.time}:59`);
    if (configsError) throw configsError;
    const syncByScope = new Map<string, any>();
    for (const config of configs ?? []) {
      let createdRunId: string | null = null;
      try {
        const { data: existing, error: existingError } = await supabase.from("attendance_report_runs")
          .select("id").eq("config_id", config.id).eq("report_date", targetDate).maybeSingle();
        if (existingError) throw existingError;
        if (existing) continue;
        const { data: run, error: runError } = await supabase.from("attendance_report_runs").insert({
          config_id: config.id, report_date: targetDate, company_id: config.company_id,
          branch_id: config.branch_id, department_id: config.department_id, status: "pending"
        }).select("*").single();
        if (runError) {
          if (runError.code === "23505") continue;
          throw runError;
        }
        createdRunId = run.id;
        const scopeKey = `${targetDate}:${config.branch_id}`;
        let syncJob = syncByScope.get(scopeKey);
        if (!syncJob) {
          syncJob = await findOrCreateSyncJob(supabase, targetDate, config.company_id, config.branch_id);
          syncByScope.set(scopeKey, syncJob);
        }
        if (syncJob) {
          await supabase.from("attendance_report_runs").update({ status: "syncing", sync_job_id: syncJob.id }).eq("id", run.id);
          if (terminalSyncStatuses.includes(syncJob.status)) {
            await supabase.from("attendance_report_runs").update({ sync_status: syncJob.status }).eq("id", run.id);
            await invokeGenerator(supabase, run.id, targetDate);
            runsAdvanced += 1;
          }
        } else {
          await invokeGenerator(supabase, run.id, targetDate);
          runsAdvanced += 1;
        }
        runsCreated += 1;
      } catch (error) {
        const message = sanitizeError(error);
        if (createdRunId) {
          await supabase.from("attendance_report_runs").update({ status: "failed", error_message: message }).eq("id", createdRunId);
        }
        errors.push(`config ${config.id}: ${message}`);
      }
    }

    if (runsCreated || runsAdvanced || errors.length) {
      await supabase.from("attendance_report_schedule_logs").insert({
        target_date: targetDate, local_time: clock.time,
        status: errors.length ? (runsCreated || runsAdvanced ? "partial" : "failed") : "complete",
        configs_due: configs?.length ?? 0, runs_created: runsCreated, runs_advanced: runsAdvanced,
        errors, finished_at: new Date().toISOString()
      });
    }
    return jsonResponse({ target_date: targetDate, local_time: clock.time, configs_due: configs?.length ?? 0, runs_created: runsCreated, runs_advanced: runsAdvanced, errors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, /Unauthorized/i.test(message) ? 401 : /Forbidden/i.test(message) ? 403 : 400);
  }
});

async function findOrCreateSyncJob(supabase: any, date: string, companyId: string, branchId: string) {
  const { data: devices, error: devicesError } = await supabase.from("devices")
    .select("id").eq("branch_id", branchId).eq("protocol", "hik_devicegateway").not("dev_index", "is", null);
  if (devicesError) throw devicesError;
  const deviceIds = (devices ?? []).map((device: any) => device.id).sort();
  if (!deviceIds.length) return null;
  const { data: candidates, error: candidatesError } = await supabase.from("attendance_sync_jobs")
    .select("*").eq("date", date).is("requested_by", null)
    .in("status", ["pending", "processing", "calculating", "complete", "partial"])
    .order("created_at", { ascending: false }).limit(20);
  if (candidatesError) throw candidatesError;
  const existing = (candidates ?? []).find((job: any) => sameIds(job.device_ids, deviceIds));
  if (existing) return existing;
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("attendance_sync_jobs").insert({
    date, company_ids: [companyId], device_ids: deviceIds, requested_by: null,
    force: true, status: "pending", stage: "queued", progress: 0,
    devices_total: deviceIds.length, edge_received_at: now, queued_at: now,
    timing: { source: "automatic_attendance_report" }
  }).select("*").single();
  if (error) throw error;
  return data;
}

async function invokeGenerator(supabase: any, runId: string, reportDate: string) {
  const { data, error } = await supabase.functions.invoke("generate-attendance-report", {
    body: { report_date: reportDate, run_id: runId, dry_run: false }
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
}

function guatemalaClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

function previousDate(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function sameIds(left: string[], right: string[]) {
  return [...(left ?? [])].sort().join(",") === right.join(",");
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/re_[A-Za-z0-9_]+/g, "[redacted]").replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}
