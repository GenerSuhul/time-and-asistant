export type AppPermission =
  | "lateness_history"
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
  | "late_arrivals_report"
  | "attendance_report_automation"
  | "manual_adjustments"
  | "audit"
  | "users"
  | "settings";

// Legacy aliases keep rolling deploys safe until the role-removal migration
// runs. After it runs, the database no longer retains or assigns these roles.
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
  if (permission === "lateness_history") return isRegionalLatenessViewer(roleKeys);
  if (roleKeys.some((role) => itRoles.has(role))) return true;
  if (isRegionalLatenessViewer(roleKeys)) return ["dashboard", "settings", "lateness_history"].includes(permission);
  if (!roleKeys.some((role) => hrRoles.has(role))) return false;
  return !itOnlyPermissions.has(permission);
}

export function isRegionalLatenessViewer(roleKeys: string[]) {
  return roleKeys.includes("regional_lateness_viewer") && !roleKeys.some((role) => ["super_admin", "it_admin", "hr_admin"].includes(role));
}

export function operationalRoleLabel(roleKey: string) {
  if (roleKey === "regional_lateness_viewer") return "Supervisor regional de tardanzas";
  if (itRoles.has(roleKey)) return "IT";
  if (hrRoles.has(roleKey)) return "RRHH";
  return "Sin acceso operativo";
}
