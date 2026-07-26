import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";
import {
  enqueueFreshAttendanceReportSync,
  resolveConfigOutputs,
  transitionRun
} from "../_shared/attendance-report-service.ts";

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
          await transitionRun(supabase, run.id, "generating", "Sincronización finalizada; iniciando generación", {
            sync_status: syncJob.status
          });
        }
        await invokeGenerator(supabase, run.id, run.report_date);
        runsAdvanced += 1;
      } catch (error) {
        errors.push(`run ${run.id}: ${sanitizeError(error)}`);
      }
    }

    const { data: configs, error: configsError } = await supabase.from("attendance_report_configs")
      .select("*,attendance_report_config_branches(branch_id)")
      .eq("is_active", true).lte("send_time", `${clock.time}:59`);
    if (configsError) throw configsError;
    const syncByScope = new Map<string, any>();
    for (const config of configs ?? []) {
      try {
        const { branches, outputs } = await resolveConfigOutputs(supabase, config);
        if (!outputs.length || !branches.length) throw new Error("El alcance no resuelve sucursales activas");
        for (const output of outputs) {
          let createdRunId: string | null = null;
          try {
            const { data: existing, error: existingError } = await supabase.from("attendance_report_runs")
              .select("id").eq("config_id", config.id).eq("report_date", targetDate)
              .eq("output_key", output.outputKey).maybeSingle();
            if (existingError) throw existingError;
            if (existing) continue;
            const scopeBranches = branches.filter((branch) => output.branchIds.includes(branch.id));
            const { data: run, error: runError } = await supabase.from("attendance_report_runs").insert({
              config_id: config.id,
              report_date: targetDate,
              company_id: output.companyIds.length === 1 ? output.companyIds[0] : null,
              branch_id: output.primaryBranchId,
              branch_ids: output.branchIds,
              output_key: output.outputKey,
              department_id: config.department_id,
              status: "pending",
              status_detail: "Programado por el scheduler",
              scope_snapshot: {
                scope_type: config.scope_type, output_mode: config.output_mode,
                output_key: output.outputKey, company_ids: output.companyIds,
                branch_ids: output.branchIds, branch_names: scopeBranches.map((branch) => branch.name),
                region_ids: output.regionIds, department_id: config.department_id ?? null
              },
              columns_snapshot: { enabled: config.html_columns, order: config.column_order },
              audit_log: [{ status: "pending", detail: "Programado por el scheduler", at: new Date().toISOString() }]
            }).select("*").single();
            if (runError) {
              if (runError.code === "23505") continue;
              throw runError;
            }
            createdRunId = run.id;
            const scopeKey = `${targetDate}:${[...output.branchIds].sort().join(",")}`;
            let syncJob = syncByScope.get(scopeKey);
            if (!syncJob) {
              syncJob = await enqueueFreshAttendanceReportSync(
                supabase,
                targetDate,
                output.companyIds,
                output.branchIds,
                "automatic_attendance_report"
              );
              syncByScope.set(scopeKey, syncJob);
            }
            if (syncJob) {
              await transitionRun(supabase, run.id, "syncing", "Esperando sincronización de dispositivos", { sync_job_id: syncJob.id });
              if (terminalSyncStatuses.includes(syncJob.status)) {
                await transitionRun(supabase, run.id, "generating", "Sincronización finalizada; iniciando generación", { sync_status: syncJob.status });
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
              await transitionRun(supabase, createdRunId, "failed", "El scheduler no pudo avanzar la ejecución", {
                error_message: message
              }).catch(() => undefined);
            }
            errors.push(`config ${config.id} output ${output.outputKey}: ${message}`);
          }
        }
      } catch (error) {
        const message = sanitizeError(error);
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

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/re_[A-Za-z0-9_]+/g, "[redacted]").replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}
