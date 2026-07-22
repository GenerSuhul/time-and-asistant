import { jsonResponse } from "./cors.ts";

export type EdgeErrorShape = {
  code: string;
  message: string;
  device?: string | null;
  details?: string | null;
  trace_id: string;
  job_id?: string | null;
};

export class EdgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly context: Partial<Omit<EdgeErrorShape, "code" | "message">> = {}
  ) { super(message); }
}

export function edgeErrorResponse(error: unknown, traceId = crypto.randomUUID()) {
  const mapped = mapError(error, traceId);
  return jsonResponse({ error: mapped.body }, mapped.status);
}

function mapError(error: unknown, traceId: string) {
  if (error instanceof EdgeError) {
    return { status: error.status, body: clean({ code: error.code, message: error.message, trace_id: traceId, ...error.context }) };
  }
  const raw = error instanceof Error ? error.message : String(error);
  const safe = /fingerData|finger_data|template|password|secret|service_role|api[_-]?key/i.test(raw)
    ? "La operación sensible falló. Consulta el trace_id en los registros del servidor."
    : raw.slice(0, 700);
  const known = knownError(safe);
  return {
    status: known.status,
    body: clean({ code: known.code, message: known.message, device: known.device, details: known.details, trace_id: traceId })
  };
}

function knownError(message: string) {
  const prefix = message.match(/([A-Z][A-Z0-9_]{3,})/)?.[1];
  const mappings: Record<string, [number, string]> = {
    EMPLOYEE_NO_ALREADY_EXISTS: [409, "El ID/employeeNo ya existe en la empresa."],
    EMPLOYEE_NO_CHANGED_AFTER_STAGING: [409, "El ID/employeeNo no puede cambiar después de preparar la captura."],
    EMPLOYEE_CREATION_SESSION_NOT_FOUND: [404, "La sesión de creación ya no existe."],
    EMPLOYEE_CREATION_SESSION_EXPIRED: [410, "La sesión de creación expiró; abre una nueva para continuar."],
    EMPLOYEE_CREATION_SESSION_NOT_COMMITTABLE: [409, "La captura todavía no está lista para confirmar."],
    EMPLOYEE_CREATION_SESSION_OWNER_MISMATCH: [403, "La sesión pertenece a otro usuario."],
    DEPARTMENT_NOT_AVAILABLE_FOR_BRANCH: [409, "El departamento no está asignado a la sucursal seleccionada."],
    DEPARTMENT_DUPLICATE_NAME_SCOPE: [409, "Ya existe un departamento con ese nombre y alcance en la empresa."],
    DEPARTMENT_IN_USE: [409, "El departamento está en uso. Desactívalo o reasigna sus dependencias antes de eliminarlo."],
    DEPARTMENT_NOT_FOUND: [404, "El departamento ya no existe."],
    DEPARTMENT_BRANCH_REQUIRED: [400, "Selecciona al menos una sucursal."],
    DEPARTMENT_BRANCH_SCOPE_REQUIRES_ONE: [400, "Un departamento exclusivo debe tener exactamente una sucursal."],
    DEPARTMENT_BRANCH_COMPANY_MISMATCH: [400, "Todas las sucursales deben pertenecer a la empresa seleccionada."],
    HIKVISION_EMPLOYEE_NO_INVALID: [422, "El dispositivo requiere un employeeNo numérico válido."],
    DEVICE_OFFLINE: [409, "El dispositivo está offline; vuelve a intentarlo cuando esté conectado."],
    DEVICE_NOT_LINKED: [409, "El dispositivo no está enlazado con DeviceGateway."],
    DEVICE_NOT_FOUND: [404, "El dispositivo ya no existe."],
    FINGERPRINT_ENROLLMENT_ALREADY_ACTIVE: [409, "Ya existe una captura activa para ese dedo y dispositivo."],
    FORBIDDEN: [403, "No tienes permisos para realizar esta acción."]
  };
  if (prefix && mappings[prefix]) {
    const [status, translated] = mappings[prefix];
    return { status, code: prefix, message: translated,
      device: prefix.startsWith("DEVICE_") && message.includes(":") ? message.split(":").slice(1).join(":").trim() : null,
      details: message === prefix ? null : message };
  }
  if (/duplicate key|23505/i.test(message)) return { status: 409, code: "CONFLICT", message: "Ya existe un registro con esos datos.", device: null, details: message };
  if (/unauthorized|missing authorization/i.test(message)) return { status: 401, code: "UNAUTHORIZED", message: "La sesión no es válida o expiró.", device: null, details: null };
  if (/forbidden|missing required role/i.test(message)) return { status: 403, code: "FORBIDDEN", message: "No tienes permisos para realizar esta acción.", device: null, details: null };
  return { status: 400, code: "REQUEST_FAILED", message: safeSpanish(message), device: null, details: null };
}

function safeSpanish(message: string) {
  if (/employee not found/i.test(message)) return "La persona ya no existe.";
  if (/already exists|duplicate/i.test(message)) return "La operación duplicaría un registro existente.";
  return message || "La operación no pudo completarse.";
}

function clean(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}
