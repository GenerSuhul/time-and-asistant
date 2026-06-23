import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";
import { requireRole } from "../_shared/auth.ts";

const schema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branch_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional()
});

function datesBetween(start: string, end: string) {
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const payload = schema.parse(await req.json());
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin", "branch_manager"]);
    const results = [];
    for (const date of datesBetween(payload.start_date, payload.end_date)) {
      results.push(await calculateAttendanceForDate(supabase, { ...payload, date }));
    }
    return jsonResponse({ days: results.length, results });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
