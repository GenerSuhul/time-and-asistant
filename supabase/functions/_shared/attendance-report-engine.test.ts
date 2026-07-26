import assert from "node:assert/strict";
import test from "node:test";
import {
  attendanceRuleForDate,
  classifyAttendance,
  contactCoversOutput,
  normalizeReportColumns,
  resolveReportOutputs,
  resolveReportRecipients,
  type AttendanceRule,
  type ReportContact
} from "./attendance-report-engine.ts";

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

test("Saturday keeps the regular entry and requires check-out at 13:00 or later", () => {
  const storeSaturday = attendanceRuleForDate(
    { ...stores, saturday_expected_check_out: "13:00" },
    "2026-07-25"
  );
  const administrationSaturday = attendanceRuleForDate(
    { ...administration, saturday_expected_check_out: "13:00" },
    "2026-07-25"
  );
  assert.equal(storeSaturday.expected_check_in, "06:50");
  assert.equal(administrationSaturday.expected_check_in, "07:00");
  assert.equal(storeSaturday.expected_check_out, "13:00");
  assert.equal(administrationSaturday.expected_check_out, "13:00");
  assert.equal(classifyAttendance({
    actual_check_in: gt("06:50"), actual_check_out: gt("12:59"), lunch_minutes: 0
  }, storeSaturday).check_out_status, "violation");
  assert.equal(classifyAttendance({
    actual_check_in: gt("06:50"), actual_check_out: gt("13:00"), lunch_minutes: 0
  }, storeSaturday).check_out_status, "ok");
  assert.equal(classifyAttendance({
    actual_check_in: gt("07:00"), actual_check_out: gt("13:01"), lunch_minutes: 0
  }, administrationSaturday).check_out_status, "ok");
  assert.equal(attendanceRuleForDate(
    { ...stores, saturday_expected_check_out: "13:00" },
    "2026-07-24"
  ).expected_check_out, "17:00");
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

test("explicit scopes cover only complete outputs", () => {
  const base = {
    email: "scope@renovagt.com", role: "custom_to", company_id: "renova",
    is_active: true, receives_store_reports: true, receives_administration_reports: true,
    only_on_violation: false
  };
  const output = {
    ...context("store", false),
    companyIds: ["renova"],
    branchIds: ["south-1", "south-2"],
    regionIds: ["south"]
  };
  assert.equal(contactCoversOutput({ ...base, scope_type: "global", company_id: null }, output), true);
  assert.equal(contactCoversOutput({ ...base, scope_type: "company" }, output), true);
  assert.equal(contactCoversOutput({ ...base, scope_type: "region", region_id: "south" }, output), true);
  assert.equal(contactCoversOutput({ ...base, scope_type: "region", region_id: "north" }, output), false);
  assert.equal(contactCoversOutput({ ...base, scope_type: "branches", branch_ids: ["south-1"] }, output), false);
  assert.equal(contactCoversOutput({ ...base, scope_type: "branches", branch_ids: ["south-1", "south-2"] }, output), true);
});

test("global HR is a safe primary-recipient fallback and emails stay deduplicated", () => {
  const globalHr = {
    ...contact("hr@renovagt.com", "hr_assistant"),
    company_id: null,
    scope_type: "global" as const
  };
  const result = resolveReportRecipients([globalHr, globalHr], {
    ...context("store", false),
    companyIds: ["renova"],
    branchIds: ["branch"]
  });
  assert.deepEqual(result.to, ["hr@renovagt.com"]);
  assert.deepEqual(result.cc, []);
});

test("regional supervisor receives only the selected region", () => {
  const supervisor: ReportContact = {
    ...contact("south-supervisor@renovagt.com", "regional_supervisor"),
    company_id: "renova", scope_type: "region", region_id: "south"
  };
  const south = resolveReportRecipients([supervisor], {
    ...context("store", false), companyIds: ["renova"], branchIds: ["south-1"], regionIds: ["south"]
  });
  const north = resolveReportRecipients([supervisor], {
    ...context("store", false), companyIds: ["renova"], branchIds: ["north-1"], regionIds: ["north"]
  });
  assert.ok(south.cc.includes("south-supervisor@renovagt.com"));
  assert.ok(!north.cc.includes("south-supervisor@renovagt.com"));
});

test("regional supervisor can cover an explicit store selection without branch regions", () => {
  const supervisor: ReportContact = {
    ...contact("north-supervisor@renovagt.com", "regional_supervisor"),
    company_id: "renova", scope_type: "branches", branch_ids: ["north-1", "north-2"]
  };
  const covered = resolveReportRecipients([supervisor], {
    ...context("store", false), companyIds: ["renova"], branchIds: ["north-2"], regionIds: []
  });
  const outsideCoverage = resolveReportRecipients([supervisor], {
    ...context("store", false), companyIds: ["renova"], branchIds: ["south-1"], regionIds: []
  });
  assert.ok(covered.cc.includes("north-supervisor@renovagt.com"));
  assert.ok(!outsideCoverage.cc.includes("north-supervisor@renovagt.com"));
});

test("multi-branch primary contact covers selected branches without leaking broader outputs", () => {
  const multi: ReportContact = {
    ...contact("multi@renovagt.com", "custom_to"),
    company_id: "renova", scope_type: "branches", branch_ids: ["b1", "b2"]
  };
  const covered = resolveReportRecipients([multi], {
    ...context("store", false), companyIds: ["renova"], branchIds: ["b1", "b2"]
  });
  const broader = resolveReportRecipients([multi], {
    ...context("store", false), companyIds: ["renova"], branchIds: ["b1", "b2", "b3"]
  });
  assert.deepEqual(covered.to, ["multi@renovagt.com"]);
  assert.deepEqual(broader.to, []);
});

test("output planning is deterministic for consolidated and branch-separated reports", () => {
  const branches = [
    { id: "b2", company_id: "renova", region_id: "south" },
    { id: "b1", company_id: "renova", region_id: "south" }
  ];
  assert.deepEqual(resolveReportOutputs(branches, "consolidated"), [{
    outputKey: "consolidated",
    branchIds: ["b1", "b2"],
    companyIds: ["renova"],
    regionIds: ["south"],
    primaryBranchId: null
  }]);
  assert.deepEqual(resolveReportOutputs(branches, "separate_by_branch").map((item) => item.outputKey), ["b1", "b2"]);
});

test("HTML column selection respects order and never produces an empty table", () => {
  assert.deepEqual(normalizeReportColumns(
    { name: true, department: false, actual_check_in: true },
    ["actual_check_in", "name", "unknown"]
  ).slice(0, 2), ["actual_check_in", "name"]);
  const allDisabled = Object.fromEntries([
    "name","department","schedule","actual_check_in","actual_check_out","attendance_log",
    "break_duration","break_records","worked_period","status","events"
  ].map((key) => [key, false]));
  assert.deepEqual(normalizeReportColumns(allDisabled, []), ["name"]);
  assert.ok(normalizeReportColumns(
    { name: true },
    ["name", "department", "schedule"]
  ).includes("worked_period"));
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
