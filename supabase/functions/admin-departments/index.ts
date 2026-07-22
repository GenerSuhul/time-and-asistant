import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { edgeErrorResponse } from "../_shared/errors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const department = z.object({
  company_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).nullable().optional(),
  scope: z.enum(["global", "branch"]),
  is_active: z.boolean().default(true),
  branch_ids: z.array(z.string().uuid()).min(1).max(200)
});
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), department }),
  z.object({ action: z.literal("update"), id: z.string().uuid(), department }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() })
]);

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  const traceId = crypto.randomUUID();
  if (req.method !== "POST") return edgeErrorResponse(new Error("METHOD_NOT_ALLOWED"), traceId);
  try {
    const input = schema.parse(await req.json());
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    if (input.action === "delete") {
      const { error } = await supabase.rpc("admin_delete_department", { p_department_id: input.id });
      if (error) throw error;
      return jsonResponse({ ok: true, trace_id: traceId });
    }
    const { branch_ids, ...payload } = input.department;
    const { data, error } = await supabase.rpc("admin_save_department", {
      p_department: payload,
      p_branch_ids: [...new Set(branch_ids)],
      p_department_id: input.action === "update" ? input.id : null
    });
    if (error) throw error;
    return jsonResponse({ department: data, trace_id: traceId }, input.action === "create" ? 201 : 200);
  } catch (error) {
    return edgeErrorResponse(error, traceId);
  }
});
