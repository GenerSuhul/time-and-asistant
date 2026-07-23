export type AppPermission =
  | "dashboard"
  | "companies"
  | "branches"
  | "departments"
  | "work_schedules"
  | "employees"
  | "devices"
  | "device_admin"
  | "employee_devices"
  | "commands"
  | "live_events"
  | "daily_report"
  | "range_report"
  | "attendance_report_automation"
  | "manual_adjustments"
  | "audit"
  | "users"
  | "settings";

const itRoles = new Set(["it_admin", "super_admin"]);
const hrRoles = new Set(["hr_admin", "branch_manager"]);
const itOnlyPermissions = new Set<AppPermission>([
  "device_admin",
  "commands",
  "live_events",
  "manual_adjustments",
  "audit",
  "users"
]);

export function canAccess(roleKeys: string[], permission: AppPermission) {
  if (roleKeys.some((role) => itRoles.has(role))) return true;
  if (!roleKeys.some((role) => hrRoles.has(role))) return false;
  return !itOnlyPermissions.has(permission);
}

export function operationalRoleLabel(roleKey: string) {
  if (itRoles.has(roleKey)) return "IT";
  if (hrRoles.has(roleKey)) return "RRHH";
  return "Sin acceso operativo";
}
