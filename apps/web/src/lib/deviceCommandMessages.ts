type CommandLike = {
  command_type?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  payload?: Record<string, unknown> | null;
};

const commandLabels: Record<string, string> = {
  sync_device_people: "Verificación de credenciales",
  sync_person: "Sincronizar persona",
  update_person: "Actualizar persona",
  delete_person: "Eliminar persona",
  sync_card: "Sincronizar tarjeta",
  delete_card: "Eliminar tarjeta",
  enroll_fingerprint: "Sincronizar huella",
  delete_fingerprint: "Eliminar huella",
  sync_face: "Sincronizar rostro",
  delete_face: "Eliminar rostro",
  fetch_events: "Consultar marcajes",
  remote_door: "Control de puerta",
  sync_permission_schedule: "Sincronizar horario",
  reboot: "Reiniciar dispositivo",
  sync_time: "Sincronizar hora"
};

export function deviceCommandLabel(commandType?: string | null) {
  return commandLabels[commandType ?? ""] ?? "Operación del dispositivo";
}

export function deviceCommandErrorMessage(command: CommandLike | string | null | undefined) {
  const input = typeof command === "string"
    ? { error_message: command }
    : command ?? {};
  const code = String(input.error_code ?? extractCode(input.error_message));
  const message = String(input.error_message ?? "");

  if (code === "HIKVISION_FINGERPRINT_REPLICATION_PARTIAL") {
    const requested = message.match(/requested\s+([^;]+)/i)?.[1]?.split(",").filter(Boolean).length;
    const verified = message.match(/verified\s+(.+)$/i)?.[1]?.split(",").filter((value) => value && value !== "none").length;
    return requested
      ? `El dispositivo confirmó ${verified ?? 0} de ${requested} huellas. La credencial quedó incompleta en este equipo.`
      : "El dispositivo no confirmó todas las huellas enviadas.";
  }
  if (code === "HIKVISION_DEVICE_OFFLINE") return "El dispositivo está fuera de línea. Se reintentará automáticamente cuando vuelva a conectarse.";
  if (code === "HIKVISION_DEVICE_HARDWARE_ERROR") return "El lector del dispositivo reportó un problema de hardware durante la captura.";
  if (code === "HIKVISION_FINGERPRINT_CAPTURE_REQUIRED_ON_DEVICE") return "La huella debe capturarse directamente en este dispositivo.";
  if (code === "HIKVISION_FINGERPRINT_REPLICATION_UNSUPPORTED") return "Este dispositivo no permite recibir la huella de forma remota; requiere captura local.";
  if (code === "HIKVISION_FINGERPRINT_REPAIR_BLOCKED") return "La sincronización automática de la huella está pausada porque este dispositivo requiere atención.";
  if (code === "HIKVISION_FINGERPRINT_NOT_FOUND") return "La huella seleccionada ya no está disponible en el dispositivo de origen.";
  if (code === "HIKVISION_FINGERPRINT_COUNT_MISMATCH") return "La cantidad de huellas confirmada por el dispositivo no coincide con la esperada.";
  if (code === "HIKVISION_DEVICE_ROLE_MISMATCH") return "El rol del usuario no coincide con el configurado en este dispositivo.";
  if (code === "HIKVISION_EMPLOYEE_NO_REQUIRED") return "La persona no tiene un identificador Hikvision configurado.";
  if (code === "HIKVISION_EMPLOYEE_NO_INVALID") return "El identificador Hikvision de la persona no es válido.";
  if (code === "HIKVISION_PERSON_NOT_FOUND_ON_DEVICE") return "La persona todavía no existe en este dispositivo.";
  if (/fetch_events requires a valid from\/to range/i.test(message)) return "La consulta de marcajes no tenía un rango de fechas válido.";
  if (/employee_?no is required/i.test(message)) return "La persona no tiene un identificador Hikvision configurado.";
  if (/device is offline/i.test(message)) return "El dispositivo está fuera de línea.";
  if (/hardware error/i.test(message)) return "El dispositivo reportó un problema de hardware.";
  return "No se pudo completar la operación. Use la referencia técnica para solicitar soporte.";
}

export function technicalReference(command: { id?: string; payload?: Record<string, unknown> | null }) {
  const value = String(command.payload?.trace_id ?? command.id ?? "");
  return value ? value.slice(0, 8).toUpperCase() : "SIN-REF";
}

function extractCode(message?: string | null) {
  return String(message ?? "").match(/^([A-Z][A-Z0-9_]+)(?::|$)/)?.[1] ?? "";
}
