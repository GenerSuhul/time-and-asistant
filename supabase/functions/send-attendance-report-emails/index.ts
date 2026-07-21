import { z } from "https://esm.sh/zod@3.24.2";
import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { requireRole } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/supabase.ts";

const schema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  outbox_id: z.string().uuid().optional(),
  force: z.boolean().default(false)
}).strict();

Deno.serve(async (req) => {
  const options = handleOptions(req);
  if (options) return options;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const input = schema.parse(await req.json().catch(() => ({})));
    const supabase = serviceClient();
    await requireRole(req, supabase, ["super_admin", "it_admin", "hr_admin"]);
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) throw new Error("RESEND_API_KEY no está configurada");
    const outboxRows = input.outbox_id
      ? await claimSpecific(supabase, input.outbox_id, input.force)
      : await claimPending(supabase, input.limit);
    const results = [];
    for (const outbox of outboxRows) results.push(await deliver(supabase, apiKey, outbox));
    return jsonResponse({ processed: results.length, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, /Unauthorized/i.test(message) ? 401 : /Forbidden/i.test(message) ? 403 : 400);
  }
});

async function claimPending(supabase: any, limit: number) {
  const { data, error } = await supabase.rpc("claim_attendance_email_outbox", { p_limit: limit });
  if (error) throw error;
  return data ?? [];
}

async function claimSpecific(supabase: any, id: string, force: boolean) {
  if (force) {
    const { error } = await supabase.from("email_outbox").update({
      status: "pending", retry_count: 0, next_retry_at: new Date().toISOString(),
      last_error: null, locked_at: null, provider_message_id: null, sent_at: null
    }).eq("id", id);
    if (error) throw error;
  }
  const { data, error } = await supabase.from("email_outbox").update({
    status: "processing", locked_at: new Date().toISOString()
  }).eq("id", id).eq("status", "pending").select("*");
  if (error) throw error;
  if (!data?.length) throw new Error("El correo no está pendiente o no existe");
  return data;
}

async function deliver(supabase: any, apiKey: string, outbox: any) {
  const attempt = Number(outbox.retry_count ?? 0) + 1;
  await supabase.from("email_delivery_logs").insert({
    outbox_id: outbox.id, report_run_id: outbox.report_run_id, attempt, status: "processing", provider: "resend"
  });
  await supabase.from("attendance_report_runs").update({ status: "sending" }).eq("id", outbox.report_run_id);
  try {
    const attachments = [];
    if (outbox.attachment_path) {
      const { data, error } = await supabase.storage.from("exports").download(outbox.attachment_path);
      if (error) throw error;
      attachments.push({ filename: outbox.attachment_name ?? "reporte-asistencia.xlsx", content: bytesToBase64(new Uint8Array(await data.arrayBuffer())) });
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${outbox.from_name} <${outbox.from_email}>`,
        to: outbox.to_emails,
        cc: outbox.cc_emails?.length ? outbox.cc_emails : undefined,
        subject: outbox.subject,
        html: outbox.html_body,
        attachments: attachments.length ? attachments : undefined
      })
    });
    const responseBody = await response.json().catch(() => ({}));
    if (!response.ok) throw new DeliveryError(`Resend HTTP ${response.status}: ${safeMessage(responseBody)}`, response.status);
    const sentAt = new Date().toISOString();
    await supabase.from("email_outbox").update({
      status: "sent", retry_count: attempt, provider_message_id: responseBody.id ?? null,
      last_error: null, sent_at: sentAt, locked_at: null
    }).eq("id", outbox.id);
    await supabase.from("attendance_report_runs").update({ status: "sent", sent_at: sentAt, error_message: null }).eq("id", outbox.report_run_id);
    await supabase.from("email_delivery_logs").insert({
      outbox_id: outbox.id, report_run_id: outbox.report_run_id, attempt, status: "sent",
      provider: "resend", provider_message_id: responseBody.id ?? null, http_status: response.status
    });
    return { outbox_id: outbox.id, status: "sent", provider_message_id: responseBody.id ?? null };
  } catch (error) {
    const message = sanitizeError(error);
    const terminal = attempt >= Number(outbox.max_retries ?? 4);
    const nextRetry = new Date(Date.now() + retryDelayMinutes(attempt) * 60_000).toISOString();
    await supabase.from("email_outbox").update({
      status: terminal ? "failed" : "pending", retry_count: attempt,
      next_retry_at: nextRetry, last_error: message, locked_at: null
    }).eq("id", outbox.id);
    await supabase.from("attendance_report_runs").update({
      status: terminal ? "failed" : "queued", error_message: message
    }).eq("id", outbox.report_run_id);
    await supabase.from("email_delivery_logs").insert({
      outbox_id: outbox.id, report_run_id: outbox.report_run_id, attempt,
      status: terminal ? "failed" : "retry_scheduled", provider: "resend",
      http_status: error instanceof DeliveryError ? error.status : null,
      error_message: message,
      metadata: terminal ? {} : { next_retry_at: nextRetry }
    });
    return { outbox_id: outbox.id, status: terminal ? "failed" : "retry_scheduled", error: message };
  }
}

class DeliveryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function retryDelayMinutes(attempt: number) {
  return [5, 15, 60, 180][Math.min(Math.max(attempt - 1, 0), 3)];
}

function safeMessage(value: any) {
  return String(value?.message ?? value?.name ?? "respuesta no especificada").slice(0, 500);
}

function sanitizeError(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/re_[A-Za-z0-9_]+/g, "[redacted]").replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 1000);
}
