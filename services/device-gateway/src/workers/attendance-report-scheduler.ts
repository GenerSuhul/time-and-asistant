import { config } from "../config.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";

let running = false;

export function startAttendanceReportScheduler() {
  if (!config.ATTENDANCE_REPORTS_ENABLED) {
    logger.info("Automatic attendance report scheduler is disabled");
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { data: schedule, error: scheduleError } = await supabase.functions.invoke("schedule-daily-attendance-reports", { body: {} });
      if (scheduleError) throw scheduleError;
      if ((schedule?.runs_created ?? 0) > 0 || (schedule?.runs_advanced ?? 0) > 0 || schedule?.errors?.length) {
        logger.info({
          targetDate: schedule.target_date,
          configsDue: schedule.configs_due,
          runsCreated: schedule.runs_created,
          runsAdvanced: schedule.runs_advanced,
          errors: schedule.errors
        }, "Automatic attendance report schedule advanced");
      }
      const { data: delivery, error: deliveryError } = await supabase.functions.invoke("send-attendance-report-emails", { body: { limit: 10 } });
      if (deliveryError) throw deliveryError;
      if ((delivery?.processed ?? 0) > 0) {
        logger.info({ processed: delivery.processed, results: delivery.results }, "Attendance report email outbox processed");
      }
    } catch (error) {
      logger.error({ err: error }, "Automatic attendance report scheduler failed");
    } finally {
      running = false;
    }
  };
  logger.info({
    timezone: config.REPORTS_TIMEZONE,
    defaultSendHour: config.ATTENDANCE_REPORT_SEND_HOUR,
    intervalSeconds: config.ATTENDANCE_REPORT_SCHEDULER_INTERVAL_SECONDS
  }, "Automatic attendance report scheduler started");
  setTimeout(() => void tick(), 5_000);
  setInterval(() => void tick(), config.ATTENDANCE_REPORT_SCHEDULER_INTERVAL_SECONDS * 1_000);
}
