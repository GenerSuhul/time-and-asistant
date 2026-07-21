import assert from "node:assert/strict";
import test from "node:test";
import { classifyAttendance, resolveReportRecipients, type AttendanceRule, type ReportContact } from "./attendance-report-engine.ts";

const stores: AttendanceRule = { expected_check_in: "06:50", expected_check_out: "17:00", max_break_minutes: 60 };
const administration: AttendanceRule = { expected_check_in: "07:00", expected_check_out: "17:00", max_break_minutes: 90 };
const gt = (time: string) => `2026-07-20T${time}:00-06:00`;

test("store boundary rules", () => {
  assert.equal(classifyAttendance({ actual_check_in: gt("06:51"), actual_check_out: gt("17:00"), lunch_minutes: 60 }, stores).check_in_status, "violation");
  assert.equal(classifyAttendance({ actual_check_in: gt("06:50"), actual_check_out: gt("17:00"), lunch_minutes: 60 }, stores).check_in_status, "ok");
  assert.equal(classifyAttendance({ actual_check_in: gt("06:50"), actual_check_out: gt("16:59"), lunch_minutes: 60 }, stores).check_out_status, "violation");
  assert.equal(classifyAttendance({ actual_check_in: gt("06:50"), actual_check_out: gt("17:00"), lunch_minutes: 60 }, stores).check_out_status, "ok");
  assert.equal(classifyAttendance({ actual_check_in: gt("06:50"), actual_check_out: gt("17:00"), lunch_minutes: 61 }, stores).break_status, "violation");
  assert.equal(classifyAttendance({ actual_check_in: gt("06:50"), actual_check_out: gt("17:00"), lunch_minutes: 60 }, stores).break_status, "ok");
});

test("administration boundary rules", () => {
  assert.equal(classifyAttendance({ actual_check_in: gt("07:01"), actual_check_out: gt("17:00"), lunch_minutes: 90 }, administration).check_in_status, "violation");
  assert.equal(classifyAttendance({ actual_check_in: gt("07:00"), actual_check_out: gt("17:00"), lunch_minutes: 90 }, administration).check_in_status, "ok");
  assert.equal(classifyAttendance({ actual_check_in: gt("07:00"), actual_check_out: gt("17:00"), lunch_minutes: 91 }, administration).break_status, "violation");
  assert.equal(classifyAttendance({ actual_check_in: gt("07:00"), actual_check_out: gt("17:00"), lunch_minutes: 90 }, administration).break_status, "ok");
});

test("missing marks are warnings, never violations", () => {
  const missing = classifyAttendance({}, stores);
  assert.equal(missing.severity, "warning");
  assert.deepEqual(missing.codes, ["absent_or_no_mark"]);
  const missingCheckInWithEarlyExit = classifyAttendance({ actual_check_out: gt("16:00"), lunch_minutes: 120 }, stores);
  assert.equal(missingCheckInWithEarlyExit.severity, "warning");
  assert.ok(!missingCheckInWithEarlyExit.codes.includes("early_check_out"));
  assert.ok(!missingCheckInWithEarlyExit.codes.includes("lunch_exceeded"));
});

const contacts: ReportContact[] = [
  contact("manager@renovagt.com", "branch_manager"),
  contact("supervisor@renovagt.com", "regional_supervisor"),
  contact("assistant@renovagt.com", "hr_assistant"),
  contact("hrmanager@renovagt.com", "hr_manager", true),
  contact("commercial@renovagt.com", "commercial_manager"),
  contact("department@renovagt.com", "department_head", false, true)
];

test("store recipients include supervisor and conditional HR manager", () => {
  const withViolation = resolveReportRecipients(contacts, context("store", true));
  assert.ok(withViolation.cc.includes("supervisor@renovagt.com"));
  assert.ok(withViolation.cc.includes("hrmanager@renovagt.com"));
  const withoutViolation = resolveReportRecipients(contacts, context("store", false));
  assert.ok(!withoutViolation.cc.includes("hrmanager@renovagt.com"));
  const warningOverride = resolveReportRecipients(contacts, {
    ...context("store", false), hasWarnings: true, warningsTriggerHrCopy: true
  });
  assert.ok(warningOverride.cc.includes("hrmanager@renovagt.com"));
});

test("administration excludes commercial manager and regional supervisor", () => {
  const result = resolveReportRecipients(contacts, context("administration", true));
  assert.ok(result.to.includes("department@renovagt.com"));
  assert.ok(!result.cc.includes("commercial@renovagt.com"));
  assert.ok(!result.cc.includes("supervisor@renovagt.com"));
});

function contact(email: string, role: string, onlyOnViolation = false, administrationOnly = false): ReportContact {
  return {
    email, role, branch_id: null, department_id: null, region: null, is_active: true,
    receives_store_reports: !administrationOnly,
    receives_administration_reports: administrationOnly || ["hr_assistant", "hr_manager"].includes(role),
    only_on_violation: onlyOnViolation
  };
}

function context(unitType: "store" | "administration", hasViolations: boolean) {
  return {
    unitType,
    branchId: "branch",
    departmentId: unitType === "store" ? null : "department",
    region: null,
    hasViolations,
    hasWarnings: false,
    copyHrManagerOnlyOnViolation: true,
    warningsTriggerHrCopy: false,
    copyCommercialManager: true
  } as const;
}
