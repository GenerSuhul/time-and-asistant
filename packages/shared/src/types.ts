export type AppEnv = "local" | "staging" | "production";

export type DeviceProtocol = "isup" | "isapi" | "manual" | "mock";
export type DeviceStatus = "online" | "offline" | "error";

export type AttendanceEventType =
  | "check_in"
  | "lunch_out"
  | "lunch_in"
  | "check_out"
  | "break_out"
  | "break_in"
  | "unknown";

export type AttendanceStatus =
  | "complete"
  | "late"
  | "incomplete"
  | "absent"
  | "early_leave"
  | "day_off"
  | "holiday"
  | "leave"
  | "error";

export type DeviceCommandType =
  | "sync_person"
  | "update_person"
  | "delete_person"
  | "sync_card"
  | "sync_face"
  | "enroll_fingerprint"
  | "fetch_events"
  | "reboot"
  | "sync_time";

export type QueueStatus = "pending" | "processing" | "success" | "failed";

export interface GatewayEventPayload {
  device_identifier?: string;
  serial_number?: string;
  external_event_id?: string;
  employee_external_id?: string;
  occurred_at: string;
  raw_event_type: string;
  auth_method?: "fingerprint" | "face" | "card" | "pin" | "unknown";
  access_result?: "granted" | "denied" | "unknown";
  payload?: Record<string, unknown>;
}
