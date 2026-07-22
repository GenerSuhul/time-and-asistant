import { supabase } from "./supabase";

export type StructuredFunctionError = {
  code?: string;
  message?: string;
  device?: string;
  details?: string;
  trace_id?: string;
  job_id?: string;
};

export class EdgeFunctionError extends Error {
  constructor(public readonly info: StructuredFunctionError, fallback: string) {
    super(formatFunctionError(info, fallback));
  }
}

export async function invokeEdge<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error && !data?.error) return data as T;
  const fallback = error instanceof Error ? error.message : "La función no pudo completar la operación.";
  let parsed: any = data?.error;
  const context = (error as { context?: Response } | null)?.context;
  if (context) {
    try {
      const payload = await context.clone().json();
      parsed = payload?.error ?? payload;
    } catch { /* Keep the transport fallback. */ }
  }
  if (typeof parsed === "string") parsed = { message: parsed };
  throw new EdgeFunctionError(parsed ?? {}, fallback);
}

export function formatFunctionError(error: StructuredFunctionError, fallback = "La operación falló.") {
  const parts = [error.message || fallback];
  if (error.code) parts.push(`Código: ${error.code}`);
  if (error.device) parts.push(`Dispositivo: ${error.device}`);
  if (error.job_id) parts.push(`Job: ${error.job_id}`);
  if (error.trace_id) parts.push(`Trace: ${error.trace_id}`);
  if (error.details && error.details !== error.message) parts.push(`Detalle: ${error.details}`);
  parts.push(suggestion(error.code));
  return parts.filter(Boolean).join(" · ");
}

function suggestion(code?: string) {
  if (code === "HIKVISION_EMPLOYEE_NO_INVALID") return "Usa únicamente dígitos en employeeNo Hikvision; el código interno sí puede ser alfanumérico.";
  if (code === "HIKVISION_EMPLOYEE_NO_LOCKED") return "Retira primero las asignaciones de dispositivo si necesitas cambiar el employeeNo.";
  if (code === "HIKVISION_IDENTIFIER_MIGRATION_REQUIRES_RECREDENTIAL") return "Conserva la identidad actual y coordina el reenrolamiento de todas sus credenciales antes de retirar el ID anterior.";
  if (code === "DEVICE_OFFLINE") return "Confirma que el dispositivo aparezca online e inténtalo de nuevo.";
  if (code === "HIKVISION_DEVICE_HARDWARE_ERROR") return "Verifica que el lector no esté ocupado, limpia el sensor y vuelve a capturar directamente en ese dispositivo.";
  if (code === "HIKVISION_FINGERPRINT_NOT_VERIFIED") return "Repite la captura: el dispositivo recibió la operación, pero no confirmó la huella.";
  if (code === "HIKVISION_EMPLOYEE_NO_REQUIRED") return "Guarda o genera primero el employeeNo Hikvision numérico antes de sincronizar.";
  if (code === "DEPARTMENT_IN_USE") return "Reasigna las personas/configuraciones o marca el departamento como inactivo.";
  if (code?.includes("SESSION_EXPIRED")) return "Cierra el formulario y comienza una nueva creación.";
  return "Reintenta; si persiste, comparte el trace_id con soporte.";
}
