import { canAccess, isRegionalLatenessViewer, type AppPermission } from "../src/lib/accessControl.ts";

const restricted: AppPermission[] = ["companies", "branches", "departments", "work_schedules", "employees", "devices", "device_admin", "employee_devices", "commands", "live_events", "daily_report", "range_report", "late_arrivals_report", "attendance_report_automation", "manual_adjustments", "audit", "users"];
const regional = "regional_lateness_viewer";
const assert = (value: boolean, message: string) => { if (!value) throw new Error(message); };

Deno.test("regional supervisor has exactly the three requested permissions", () => {
  for (const permission of ["dashboard", "settings", "lateness_history"] as AppPermission[]) assert(canAccess([regional], permission), permission);
  for (const permission of restricted) assert(!canAccess([regional], permission), `Unexpected access to ${permission}`);
  assert(isRegionalLatenessViewer([regional]), "effective regional role");
  assert(!canAccess([], "lateness_history"), "unassigned user must be denied");
});
Deno.test("additional administrator role preserves existing permissions", () => {
  for (const role of ["it_admin", "super_admin", "hr_admin"]) {
    assert(!isRegionalLatenessViewer([regional, role]), `${role} must remain administrator`);
    for (const permission of restricted) assert(canAccess([role, regional], permission) === canAccess([role], permission), `${role}: ${permission}`);
  }
});
