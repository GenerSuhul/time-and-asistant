export type UnitType = "store" | "administration" | "department";
export type ReportSeverity = "ok" | "warning" | "violation";
export type ReportScopeType = "global" | "company" | "region" | "branches" | "branch" | "department";
export type ReportOutputMode = "consolidated" | "separate_by_branch";
export type ReportColumnKey =
  | "name"
  | "department"
  | "schedule"
  | "actual_check_in"
  | "actual_check_out"
  | "attendance_log"
  | "break_duration"
  | "break_records"
  | "status"
  | "events";

export const REPORT_COLUMN_DEFINITIONS: ReadonlyArray<{ key: ReportColumnKey; label: string }> = [
  { key: "name", label: "Nombre" },
  { key: "department", label: "Departamento" },
  { key: "schedule", label: "Grupo / horario" },
  { key: "actual_check_in", label: "Entrada real" },
  { key: "actual_check_out", label: "Salida real" },
  { key: "attendance_log", label: "Grabación de asistencia" },
  { key: "break_duration", label: "Duración de pausa" },
  { key: "break_records", label: "Registros de descansos" },
  { key: "status", label: "Estado / observación" },
  { key: "events", label: "Eventos / detalle" }
];

export const DEFAULT_REPORT_COLUMNS: Record<ReportColumnKey, boolean> = Object.fromEntries(
  REPORT_COLUMN_DEFINITIONS.map(({ key }) => [key, true])
) as Record<ReportColumnKey, boolean>;

export type AttendanceRule = {
  expected_check_in: string;
  expected_check_out: string;
  max_break_minutes: number;
  check_in_tolerance_minutes?: number;
  check_out_tolerance_minutes?: number;
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
  company_id?: string | null;
  scope_type?: ReportScopeType | null;
  branch_id?: string | null;
  branch_ids?: string[];
  department_id?: string | null;
  region_id?: string | null;
  region?: string | null;
  is_active: boolean;
  receives_store_reports: boolean;
  receives_administration_reports: boolean;
  only_on_violation: boolean;
};

export type RecipientContext = {
  unitType: UnitType | "mixed";
  companyIds?: string[];
  branchIds?: string[];
  regionIds?: string[];
  branchId?: string | null;
  departmentId?: string | null;
  regionId?: string | null;
  region?: string | null;
  hasViolations: boolean;
  hasWarnings: boolean;
  copyHrManagerOnlyOnViolation: boolean;
  warningsTriggerHrCopy: boolean;
  copyCommercialManager: boolean;
};

export type ResolvedRecipients = { to: string[]; cc: string[] };

export type ReportBranchTarget = {
  id: string;
  company_id: string;
  region_id?: string | null;
  name?: string;
  unit_type?: "store" | "administration";
};

export type ReportOutput = {
  outputKey: string;
  branchIds: string[];
  companyIds: string[];
  regionIds: string[];
  primaryBranchId: string | null;
};

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

  if (localMinutes(input.actual_check_in) > timeMinutes(rule.expected_check_in) + Number(rule.check_in_tolerance_minutes ?? 0)) {
    codes.push("late_check_in");
    checkInStatus = "violation";
  }
  if (localMinutes(input.actual_check_out) < timeMinutes(rule.expected_check_out) - Number(rule.check_out_tolerance_minutes ?? 0)) {
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
    if ((context.unitType === "store" || context.unitType === "mixed") && !contact.receives_store_reports) return false;
    if ((context.unitType !== "store") && !contact.receives_administration_reports) return false;
    return contactCoversOutput(contact, context);
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

  // A report must always have a primary recipient. Corporate HR is a safe
  // fallback only when its explicit scope covers the complete output.
  if (to.length === 0) {
    to.push(...byRole("hr_assistant"));
    if (copyHr) to.push(...byRole("hr_manager"));
  }

  to = uniqueEmails(to);
  const toSet = new Set(to);
  cc = uniqueEmails(cc).filter((email) => !toSet.has(email));
  return { to, cc };
}

export function contactCoversOutput(contact: ReportContact, context: RecipientContext) {
  const branchIds = uniqueStrings(context.branchIds ?? (context.branchId ? [context.branchId] : []));
  const companyIds = uniqueStrings(context.companyIds ?? []);
  const regionIds = uniqueStrings(context.regionIds ?? (context.regionId ? [context.regionId] : []));
  const contactBranches = uniqueStrings(contact.branch_ids ?? (contact.branch_id ? [contact.branch_id] : []));
  const scope = contact.scope_type ?? legacyContactScope(contact);

  if (scope === "global") return true;
  if (!contact.company_id || companyIds.length === 0 || companyIds.some((id) => id !== contact.company_id)) return false;
  if (scope === "company") return true;
  if (scope === "region") {
    if (contact.region_id) return regionIds.length === 1 && regionIds[0] === contact.region_id;
    return Boolean(contact.region) && normalize(contact.region) === normalize(context.region);
  }
  if (scope === "branches" || scope === "branch") {
    return branchIds.length > 0 && branchIds.every((id) => contactBranches.includes(id));
  }
  if (scope === "department") {
    if (!contact.department_id || contact.department_id !== context.departmentId) return false;
    return contactBranches.length === 0 || (branchIds.length > 0 && branchIds.every((id) => contactBranches.includes(id)));
  }
  return false;
}

export function resolveReportOutputs(branches: ReportBranchTarget[], mode: ReportOutputMode): ReportOutput[] {
  const uniqueBranches = [...new Map(branches.map((branch) => [branch.id, branch])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  if (mode === "separate_by_branch") {
    return uniqueBranches.map((branch) => ({
      outputKey: branch.id,
      branchIds: [branch.id],
      companyIds: [branch.company_id],
      regionIds: branch.region_id ? [branch.region_id] : [],
      primaryBranchId: branch.id
    }));
  }
  return [{
    outputKey: "consolidated",
    branchIds: uniqueBranches.map((branch) => branch.id),
    companyIds: uniqueStrings(uniqueBranches.map((branch) => branch.company_id)),
    regionIds: uniqueStrings(uniqueBranches.map((branch) => branch.region_id).filter(Boolean) as string[]),
    primaryBranchId: uniqueBranches.length === 1 ? uniqueBranches[0].id : null
  }];
}

export function normalizeReportColumns(
  enabled?: Partial<Record<ReportColumnKey, boolean>> | null,
  requestedOrder?: string[] | null
): ReportColumnKey[] {
  const known = new Set(REPORT_COLUMN_DEFINITIONS.map(({ key }) => key));
  const order = uniqueStrings([
    ...(requestedOrder ?? []),
    ...REPORT_COLUMN_DEFINITIONS.map(({ key }) => key)
  ]).filter((key): key is ReportColumnKey => known.has(key as ReportColumnKey));
  const selected = order.filter((key) => (enabled?.[key] ?? DEFAULT_REPORT_COLUMNS[key]) !== false);
  return selected.length > 0 ? selected : ["name"];
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function legacyContactScope(contact: ReportContact): ReportScopeType {
  if (contact.department_id) return "department";
  if (contact.branch_id) return "branch";
  if (contact.region_id || contact.region) return "region";
  return contact.company_id ? "company" : "global";
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
