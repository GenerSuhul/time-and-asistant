import assert from "node:assert/strict";
import test from "node:test";
import { canAccess } from "../src/lib/accessControl.ts";

test("IT has full platform access", () => {
  for (const permission of [
    "dashboard", "employees", "device_admin", "commands", "live_events",
    "manual_adjustments", "audit", "users", "settings"
  ] as const) {
    assert.equal(canAccess(["it_admin"], permission), true, permission);
  }
});

test("RRHH has the complete employee, schedule and credential workflow", () => {
  for (const permission of [
    "dashboard", "companies", "branches", "departments", "work_schedules",
    "employees", "devices", "employee_devices", "daily_report",
    "range_report", "attendance_report_automation", "settings"
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
