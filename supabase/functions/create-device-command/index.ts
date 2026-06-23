import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { requireRole } from "../_shared/auth.ts";

const schema = z.object({
  device_id: z.string().uuid(),
  command_type: z.enum([
    "sync_person",
    "update_person",
    "delete_person",
    "sync_card",
    "sync_face",
    "enroll_fingerprint",
    "fetch_events",
    "reboot",
    "sync_time"
  ]),
  payload: z.record(z.unknown()).default({})
});

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const payload = schema.parse(await req.json());
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["super_admin", "it_admin"]);
    const { data, error } = await supabase
      .from("device_commands")
      .insert({
        ...payload,
        status: "pending",
        requested_by: actor.user_id
      })
      .select("*")
      .single();

    if (error) throw error;
    return jsonResponse({ command: data }, 201);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
