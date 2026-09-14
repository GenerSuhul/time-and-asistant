import assert from "node:assert/strict";
import test from "node:test";
import { canAccess, isRegionalLatenessViewer, type AppPermission } from "../src/lib/accessControl.ts";

test("IT has full platform access", () => {
  for (const permission of [
    "dashboard", "employees", "device_admin", "commands", "live_events",
    "late_arrivals_report", "manual_adjustments", "audit", "users", "settings"
  ] as const) {
    assert.equal(canAccess(["it_admin"], permission), true, permission);
  }
});

test("RRHH has the complete employee, schedule and credential workflow", () => {
  for (const permission of [
    "dashboard", "companies", "branches", "departments", "work_schedules",
    "employees", "devices", "employee_devices", "daily_report",
    "range_report", "late_arrivals_report", "attendance_report_automation", "settings"
  ] as const) {
    assert.equal(canAccess(["hr_admin"], permission), true, permission);
  }
});

test("RRHH cannot access technical or platform-administration modules", () => {
  for (const permission of [
    "device_admin", "commands", "live_events", "manual_adjustments", "audit", "users"
  ] as const) {
    assert.equal(canAccess(["hr_admin"], permission), false, permission);
  }
});

test("an unrecognized role receives no operational access", () => {
  assert.equal(canAccess(["viewer"], "dashboard"), false);
  assert.equal(canAccess([], "employees"), false);
});

test("regional lateness supervisor sees only dashboard, lateness history and profile", () => {
  const allowed: AppPermission[] = ["dashboard", "lateness_history", "settings"];
  const denied: AppPermission[] = [
    "companies", "branches", "departments", "work_schedules", "employees",
    "devices", "device_admin", "employee_devices", "commands", "live_events",
    "daily_report", "range_report", "late_arrivals_report",
    "attendance_report_automation", "manual_adjustments", "audit", "users"
  ];

  assert.equal(isRegionalLatenessViewer(["regional_lateness_viewer"]), true);
  for (const permission of allowed) assert.equal(canAccess(["regional_lateness_viewer"], permission), true, permission);
  for (const permission of denied) assert.equal(canAccess(["regional_lateness_viewer"], permission), false, permission);
});
