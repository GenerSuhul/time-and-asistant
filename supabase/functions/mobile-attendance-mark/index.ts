import { z } from "https://esm.sh/zod@3.24.2";
import { calculateAttendanceForDate } from "../_shared/attendance.ts";
import { requireRole } from "../_shared/auth.ts";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { serviceClient } from "../_shared/supabase.ts";

// This allow-list is intentionally compiled into the function.  A role alone
// is not sufficient: another IT account cannot use this mobile endpoint.
const MOBILE_ADMIN_EMAIL = "it.agrisystem@gmail.com";

const input = z.object({
  event_type: z.enum(["check_in", "check_out", "lunch_out", "lunch_in", "break_out", "break_in"]),
  idempotency_key: z.string().uuid()
}).strict();

function authorizationToken(req: Request) {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function guatemalaDate(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function clientError(error: unknown) {
  const message = error instanceof z.ZodError
    ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    : error instanceof Error ? error.message : String(error);
  if (/^(Unauthorized|Forbidden)/.test(message)) return { status: 403, message: "No tienes autorización para realizar una marcación móvil." };
  if (message.includes("MOBILE_ATTENDANCE_EMPLOYEE_NOT_CONFIGURED")) {
    return { status: 409, message: "La cuenta autorizada no tiene una asignación activa de marcación móvil." };
  }
  if (message.includes("MOBILE_ATTENDANCE_VIRTUAL_DEVICE_MISSING")) {
    return { status: 503, message: "La fuente virtual de marcación no está configurada." };
  }
  if (message.includes("MOBILE_ATTENDANCE_EVENT_TYPE_INVALID")) return { status: 400, message: "Tipo de marcación no permitido." };
  return { status: 400, message };
}

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const payload = input.parse(await req.json());
    const supabase = serviceClient();
    const actor = await requireRole(req, supabase, ["it_admin"]);
    if (actor.type !== "user") throw new Error("Forbidden");

    // Fetch the identity from Auth for this request. Never accept an email
    // from the browser body, user metadata, or a client-side route check.
    const token = authorizationToken(req);
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user || userData.user.id !== actor.user_id) throw new Error("Unauthorized");
    const email = userData.user.email?.trim().toLowerCase();
    if (email !== MOBILE_ADMIN_EMAIL) throw new Error("Forbidden");

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id,status")
      .eq("id", actor.user_id)
      .eq("status", "active")
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) throw new Error("Forbidden");

    // The mark is always attributed through a private server-side allow-list.
    // The client can never choose another employee or a physical device.
    const { data: authorization, error: authorizationError } = await supabase
      .from("mobile_attendance_authorizations")
      .select("employee_id")
      .eq("actor_email", email)
      .eq("is_active", true)
      .maybeSingle();
    if (authorizationError) throw authorizationError;
    if (!authorization?.employee_id) throw new Error("MOBILE_ATTENDANCE_EMPLOYEE_NOT_CONFIGURED");

    const occurredAt = new Date().toISOString();
    const { data: markRows, error: markError } = await supabase.rpc("create_mobile_admin_attendance_mark", {
      p_actor_user_id: actor.user_id,
      p_actor_email: email,
      p_employee_id: authorization.employee_id,
      p_event_type: payload.event_type,
      p_occurred_at: occurredAt,
      p_idempotency_key: payload.idempotency_key,
      p_user_agent: req.headers.get("user-agent") ?? null
    });
    if (markError) throw markError;
    const mark = Array.isArray(markRows) ? markRows[0] : markRows;
    if (!mark?.attendance_event_id || !mark?.occurred_at) throw new Error("La marcación no devolvió un registro válido.");

    const attendanceDate = guatemalaDate(mark.occurred_at);
    await calculateAttendanceForDate(supabase, {
      date: attendanceDate,
      employee_id: authorization.employee_id
    });

    return jsonResponse({
      ok: true,
      mark_id: mark.mark_id,
      attendance_event_id: mark.attendance_event_id,
      event_type: mark.event_type,
      occurred_at: mark.occurred_at,
      attendance_date: attendanceDate,
      duplicated: Boolean(mark.duplicated),
      source: "mobile_web",
      physical_hikvision_event: false
    }, mark.duplicated ? 200 : 201);
  } catch (error) {
    const output = clientError(error);
    console.error("Mobile attendance mark rejected", error instanceof Error ? error.message : error);
    return jsonResponse({ error: output.message }, output.status);
  }
});
