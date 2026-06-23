import type { AttendanceEventType } from "@attendance/shared";

const DEFAULT_EVENT_MAP: Record<string, AttendanceEventType> = {
  check_in: "check_in",
  entrada: "check_in",
  in: "check_in",
  lunch_out: "lunch_out",
  salida_almuerzo: "lunch_out",
  break_lunch_out: "lunch_out",
  lunch_in: "lunch_in",
  entrada_almuerzo: "lunch_in",
  break_lunch_in: "lunch_in",
  check_out: "check_out",
  salida: "check_out",
  out: "check_out",
  break_out: "break_out",
  descanso_salida: "break_out",
  break_in: "break_in",
  descanso_entrada: "break_in"
};

export function normalizeEventType(rawEventType: string, payload?: Record<string, unknown>): AttendanceEventType {
  const raw = rawEventType.trim().toLowerCase();
  if (DEFAULT_EVENT_MAP[raw]) return DEFAULT_EVENT_MAP[raw];

  const attendanceStatus = String(payload?.attendance_status ?? payload?.attendanceStatus ?? "").trim().toLowerCase();
  if (attendanceStatus && DEFAULT_EVENT_MAP[attendanceStatus]) return DEFAULT_EVENT_MAP[attendanceStatus];

  return "unknown";
}
