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
  employee_id: z.string().uuid().optional()
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
    const result = await calculateAttendanceForDate(supabase, payload);
    return jsonResponse(result);
  } catch (error) {
    return edgeErrorResponse(error, traceId);
  }
});
