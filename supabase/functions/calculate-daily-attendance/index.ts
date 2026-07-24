import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";
import { requireRole } from "../_shared/auth.ts";
import { edgeErrorResponse } from "../_shared/errors.ts";

const schema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  company_id: z.string().uuid().optional(),
  branch_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional(),
  trace_id: z.string().uuid().optional()
});

Deno.serve(async (req) => {
  const traceId = crypto.randomUUID();
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const payload = schema.parse(await req.json());
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin", "branch_manager"]);
    const calculationStartedAt = Date.now();
    const effectiveTraceId = payload.trace_id ?? traceId;
    console.log(JSON.stringify({
      event: "daily_attendance_calculation_started",
      trace_id: effectiveTraceId,
      date: payload.date,
      company_id: payload.company_id ?? null,
      branch_id: payload.branch_id ?? null,
      employee_id: payload.employee_id ?? null
    }));
    const result = await calculateAttendanceForDate(supabase, payload);
    console.log(JSON.stringify({
      event: "daily_attendance_calculation_completed",
      trace_id: effectiveTraceId,
      date: payload.date,
      processed_count: result.processed_count,
      duration_ms: Date.now() - calculationStartedAt
    }));
    return jsonResponse(result);
  } catch (error) {
    return edgeErrorResponse(error, traceId);
  }
});
