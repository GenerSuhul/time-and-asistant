export type UnitType = "store" | "administration" | "department";
export type ReportSeverity = "ok" | "warning" | "violation";

export type AttendanceRule = {
  expected_check_in: string;
  expected_check_out: string;
  max_break_minutes: number;
};

export type AttendanceInput = {
  actual_check_in?: string | null;
  actual_check_out?: string | null;
  lunch_minutes?: number | null;
};

export type AttendanceClassification = {
  severity: ReportSeverity;
  codes: string[];
  check_in_status: ReportSeverity;
  break_status: ReportSeverity;
  check_out_status: ReportSeverity;
};

export type ReportContact = {
  email: string;
  role: string;
  branch_id?: string | null;
  department_id?: string | null;
  region?: string | null;
  is_active: boolean;
  receives_store_reports: boolean;
  receives_administration_reports: boolean;
  only_on_violation: boolean;
};

export type RecipientContext = {
  unitType: UnitType;
  branchId: string;
  departmentId?: string | null;
  region?: string | null;
  hasViolations: boolean;
  hasWarnings: boolean;
  copyHrManagerOnlyOnViolation: boolean;
  warningsTriggerHrCopy: boolean;
  copyCommercialManager: boolean;
};

export type ResolvedRecipients = { to: string[]; cc: string[] };

export function classifyAttendance(input: AttendanceInput, rule: AttendanceRule): AttendanceClassification {
  const codes: string[] = [];
  let checkInStatus: ReportSeverity = "ok";
  let breakStatus: ReportSeverity = "ok";
  let checkOutStatus: ReportSeverity = "ok";

  if (!input.actual_check_in && !input.actual_check_out) {
    return {
      severity: "warning",
      codes: ["absent_or_no_mark"],
      check_in_status: "warning",
      break_status: "warning",
      check_out_status: "warning"
    };
  }

  if (!input.actual_check_in) {
    codes.push("missing_check_in", "incomplete_marks");
    checkInStatus = "warning";
  }
  if (!input.actual_check_out) {
    codes.push("missing_check_out", "incomplete_marks");
    checkOutStatus = "warning";
  }

  if (!input.actual_check_in || !input.actual_check_out) {
    return {
      severity: "warning",
      codes: [...new Set(codes)],
      check_in_status: checkInStatus,
      break_status: "warning",
      check_out_status: checkOutStatus
    };
  }

  if (localMinutes(input.actual_check_in) > timeMinutes(rule.expected_check_in)) {
    codes.push("late_check_in");
    checkInStatus = "violation";
  }
  if (localMinutes(input.actual_check_out) < timeMinutes(rule.expected_check_out)) {
    codes.push("early_check_out");
    checkOutStatus = "violation";
  }
  if (input.lunch_minutes != null && input.lunch_minutes > rule.max_break_minutes) {
    codes.push("lunch_exceeded");
    breakStatus = "violation";
  }

  const uniqueCodes = [...new Set(codes)];
  const severities = [checkInStatus, breakStatus, checkOutStatus];
  const severity: ReportSeverity = severities.includes("violation")
    ? "violation"
    : severities.includes("warning") ? "warning" : "ok";
  if (severity === "ok") uniqueCodes.push("on_time", "complete");
  return {
    severity,
    codes: uniqueCodes,
    check_in_status: checkInStatus,
    break_status: breakStatus,
    check_out_status: checkOutStatus
  };
}

export function resolveReportRecipients(contacts: ReportContact[], context: RecipientContext): ResolvedRecipients {
  const eligible = contacts.filter((contact) => {
    if (!contact.is_active || !validEmail(contact.email)) return false;
    const warningExplicitlyTriggersHr = contact.role === "hr_manager" && context.hasWarnings && context.warningsTriggerHrCopy;
    if (contact.only_on_violation && !context.hasViolations && !warningExplicitlyTriggersHr) return false;
    if (context.unitType === "store" && !contact.receives_store_reports) return false;
    if (context.unitType !== "store" && !contact.receives_administration_reports) return false;
    if (contact.department_id && contact.department_id !== context.departmentId) return false;
    if (contact.branch_id && contact.branch_id !== context.branchId) return false;
    if (contact.region && normalize(contact.region) !== normalize(context.region)) return false;
    return true;
  });
  const byRole = (role: string) => eligible.filter((contact) => contact.role === role).map((contact) => normalizeEmail(contact.email));
  let to: string[] = [];
  let cc: string[] = [];

  if (context.unitType === "store") {
    to = byRole("custom_to");
    if (to.length === 0) to = byRole("branch_manager");
    cc.push(...byRole("branch_manager"), ...byRole("regional_supervisor"), ...byRole("hr_assistant"), ...byRole("custom_cc"));
    if (context.copyCommercialManager) cc.push(...byRole("commercial_manager"));
  } else {
    to.push(...byRole("department_head"), ...byRole("custom_to"));
    cc.push(...byRole("hr_assistant"), ...byRole("custom_cc"));
  }

  const copyHr = context.copyHrManagerOnlyOnViolation
    ? context.hasViolations || (context.hasWarnings && context.warningsTriggerHrCopy)
    : true;
  if (copyHr) cc.push(...byRole("hr_manager"));

  to = uniqueEmails(to);
  const toSet = new Set(to);
  cc = uniqueEmails(cc).filter((email) => !toSet.has(email));
  return { to, cc };
}

export function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function uniqueEmails(values: string[]) {
  return [...new Set(values.map(normalizeEmail).filter(validEmail))];
}

function normalize(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function timeMinutes(value: string) {
  const [hours, minutes] = value.slice(0, 5).split(":").map(Number);
  return hours * 60 + minutes;
}

function localMinutes(value: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Guatemala",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value));
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minutes = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hours * 60 + minutes;
}
