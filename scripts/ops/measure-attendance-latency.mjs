import WebSocket from "../../services/device-gateway/node_modules/ws/wrapper.mjs";
import { createClient } from "../../services/device-gateway/node_modules/@supabase/supabase-js/dist/index.mjs";

process.loadEnvFile(process.env.GATEWAY_ENV_FILE ?? "/opt/hikvision-attendance/services/device-gateway/.env");

const date = process.argv[2];
const force = process.argv[3] !== "--normal";
const cacheOnly = process.argv[3] === "--cache-only";
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error("Usage: node scripts/ops/measure-attendance-latency.mjs YYYY-MM-DD [--normal|--cache-only]");
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required");

const options = { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } };
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const { data: roleRows, error: roleError } = await admin.from("user_roles")
  .select("user_id,roles:role_id(key)");
if (roleError) throw roleError;
const roleRow = roleRows.find((row) => {
  const role = Array.isArray(row.roles) ? row.roles[0] : row.roles;
  return role?.key === "super_admin" || role?.key === "it_admin";
});
if (!roleRow) throw new Error("No authenticated admin user is available for the frontend contract test");
const { data: usersPage, error: usersError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (usersError) throw usersError;
const user = usersPage.users.find((item) => item.id === roleRow.user_id);
if (!user?.email) throw new Error("The selected admin user has no email");
const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email });
if (linkError) throw linkError;
const tokenHash = link.properties?.hashed_token;
if (!tokenHash) throw new Error("Supabase did not return a hashed one-time token");

const frontend = createClient(process.env.SUPABASE_URL, anonKey, options);
const { data: verified, error: verifyError } = await frontend.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
if (verifyError) throw verifyError;
if (!verified.session) throw new Error("The authenticated frontend session was not created");

const traceId = crypto.randomUUID();
const realtime = { subscribed_at: null, insert_visible_at: null, terminal_visible_at: null };
let resolveTerminal;
const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
const channel = frontend.channel(`attendance-latency-${traceId}`)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "attendance_sync_jobs" }, (payload) => {
    if (payload.new.trace_id !== traceId) return;
    realtime.insert_visible_at = new Date().toISOString();
  })
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "attendance_sync_jobs" }, (payload) => {
    if (payload.new.trace_id !== traceId) return;
    if (["complete", "partial", "failed"].includes(payload.new.status)) {
      realtime.terminal_visible_at = new Date().toISOString();
      resolveTerminal(payload.new);
    }
  });
await new Promise((resolve, reject) => {
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      realtime.subscribed_at = new Date().toISOString();
      resolve();
    } else if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) reject(new Error(`Realtime subscription ${status}`));
  });
});

const { count: jobsBeforeReport, error: jobsBeforeError } = await admin.from("attendance_sync_jobs")
  .select("id", { count: "exact", head: true });
if (jobsBeforeError) throw jobsBeforeError;
const reportStart = performance.now();
const beforeReport = await fetchCachedReport(frontend, date);
const cachedReportRoundTripMs = Math.round(performance.now() - reportStart);
const { count: jobsAfterReport, error: jobsAfterError } = await admin.from("attendance_sync_jobs")
  .select("id", { count: "exact", head: true });
if (jobsAfterError) throw jobsAfterError;

if (cacheOnly) {
  console.log(JSON.stringify({
    date,
    cached_report_round_trip_ms: cachedReportRoundTripMs,
    cached_report_rows: beforeReport?.rows?.length ?? 0,
    report_read_created_jobs: jobsAfterReport !== jobsBeforeReport
  }, null, 2));
  await frontend.removeChannel(channel);
  frontend.realtime.disconnect();
  admin.realtime.disconnect();
  process.exit(0);
}

const clientClickedAt = new Date().toISOString();
const enqueueStart = performance.now();
const { data: enqueue, error: enqueueError } = await frontend.functions.invoke("attendance-sync", {
  body: { action: "enqueue_day", date, force, trace_id: traceId, client_clicked_at: clientClickedAt }
});
if (enqueueError) throw enqueueError;
const enqueueRoundTripMs = Math.round(performance.now() - enqueueStart);
const jobId = enqueue?.job?.id;
if (!jobId) throw new Error("The enqueue response did not include a job id");

const duplicateStart = performance.now();
const { data: duplicate, error: duplicateError } = await frontend.functions.invoke("attendance-sync", {
  body: { action: "enqueue_day", date, force, trace_id: crypto.randomUUID(), client_clicked_at: new Date().toISOString() }
});
if (duplicateError) throw duplicateError;
const duplicateRoundTripMs = Math.round(performance.now() - duplicateStart);

let timeoutId;
const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error("Attendance sync exceeded 180 seconds")), 180_000); });
const terminal = await Promise.race([terminalPromise, timeout]);
clearTimeout(timeoutId);
const finalReportStart = performance.now();
const afterReport = await fetchCachedReport(frontend, date);
const finalReportRoundTripMs = Math.round(performance.now() - finalReportStart);

await frontend.removeChannel(channel);
const metrics = {
  date,
  force,
  trace_id: traceId,
  job_id: jobId,
  response: {
    cached_report_round_trip_ms: cachedReportRoundTripMs,
    report_read_created_jobs: jobsAfterReport !== jobsBeforeReport,
    enqueue_round_trip_ms: enqueueRoundTripMs,
    duplicate_click_round_trip_ms: duplicateRoundTripMs,
    duplicate_click_same_job: duplicate?.job?.id === jobId,
    final_report_round_trip_ms: finalReportRoundTripMs,
    final_report_rows: afterReport?.rows?.length ?? 0
  },
  job: {
    status: terminal.status,
    devices_total: terminal.devices_total,
    devices_done: terminal.devices_done,
    events_found: terminal.events_found,
    events_inserted: terminal.events_inserted,
    events_skipped: terminal.events_skipped,
    device_results: terminal.device_results,
    timing: terminal.timing
  },
  realtime: {
    ...realtime,
    insert_commit_to_visible_ms: differenceMs(enqueue?.job?.queued_at, realtime.insert_visible_at),
    terminal_commit_to_visible_ms: differenceMs(terminal.finished_at, realtime.terminal_visible_at)
  }
};
console.log(JSON.stringify(metrics, null, 2));
frontend.realtime.disconnect();
admin.realtime.disconnect();

function differenceMs(from, to) {
  if (!from || !to) return null;
  return Math.max(0, new Date(to).getTime() - new Date(from).getTime());
}

async function fetchCachedReport(client, selectedDate) {
  const [reportResult, jobResult] = await Promise.all([
    client.rpc("get_attendance_daily_report", { p_date: selectedDate }),
    client.from("attendance_sync_jobs").select("id,status,progress,created_at")
      .eq("date", selectedDate).order("created_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  if (reportResult.error) throw reportResult.error;
  if (jobResult.error) throw jobResult.error;
  return { rows: reportResult.data ?? [], latest_job: jobResult.data };
}
