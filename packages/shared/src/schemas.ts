import { z } from "zod";

export const appEnvSchema = z.enum(["local", "staging", "production"]);

export const deviceProtocolSchema = z.enum(["isup", "isapi", "manual", "mock"]);
export const deviceStatusSchema = z.enum(["online", "offline", "error"]);

export const attendanceEventTypeSchema = z.enum([
  "check_in",
  "lunch_out",
  "lunch_in",
  "check_out",
  "break_out",
  "break_in",
  "unknown"
]);

export const authMethodSchema = z.enum(["fingerprint", "face", "card", "pin", "unknown"]);
export const accessResultSchema = z.enum(["granted", "denied", "unknown"]);

export const gatewayEventPayloadSchema = z.object({
  device_identifier: z.string().min(1).optional(),
  serial_number: z.string().min(1).optional(),
  external_event_id: z.string().min(1).optional(),
  employee_external_id: z.string().min(1).optional(),
  occurred_at: z.string().datetime(),
  raw_event_type: z.string().min(1),
  auth_method: authMethodSchema.default("unknown"),
  access_result: accessResultSchema.default("unknown"),
  payload: z.record(z.unknown()).default({})
}).refine((value) => value.device_identifier || value.serial_number, {
  message: "device_identifier or serial_number is required"
});

export const createDeviceCommandSchema = z.object({
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

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const calculateDailyAttendanceSchema = z.object({
  date: dateOnlySchema,
  branch_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional()
});

export const recalculateAttendanceRangeSchema = z.object({
  start_date: dateOnlySchema,
  end_date: dateOnlySchema,
  branch_id: z.string().uuid().optional(),
  employee_id: z.string().uuid().optional()
});
