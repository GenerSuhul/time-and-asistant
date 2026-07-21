import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { generateAttendanceReport } from "../_shared/attendance-report-service.ts";

const schema = z.object({
  report_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branch_id: z.string().uuid(),
  department_id: z.string().uuid().optional()
}).strict();

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const input = schema.parse(await req.json());
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    return jsonResponse(await generateAttendanceReport(supabase, { ...input, dry_run: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, /Unauthorized/i.test(message) ? 401 : /Forbidden/i.test(message) ? 403 : 400);
  }
});
