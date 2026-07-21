import ExcelJS from "npm:exceljs@4.4.0";
import { calculateAttendanceForDate } from "./attendance.ts";
import {
  classifyAttendance,
  resolveReportRecipients,
  type AttendanceClassification,
  type ReportContact,
  type UnitType
} from "./attendance-report-engine.ts";

type GenerateInput = {
  report_date: string;
  branch_id?: string;
  department_id?: string;
  dry_run?: boolean;
  run_id?: string;
};

export async function generateAttendanceReport(supabase: any, input: GenerateInput) {
  const config = await loadConfig(supabase, input);
  const reportDate = input.report_date;
  const dryRun = Boolean(input.dry_run);
  let run = input.run_id ? await loadRun(supabase, input.run_id) : null;

  if (!dryRun) {
    run = await ensureRun(supabase, run, config, reportDate);
    await updateRun(supabase, run.id, { status: "generating", error_message: null });
  }

  await calculateAttendanceForDate(supabase, {
    date: reportDate,
    company_id: config.company_id,
    branch_id: config.branch_id
  });

  const rows = await loadAttendanceRows(supabase, reportDate, config.branch_id, config.department_id);
  const rule = one(config.attendance_report_rules);
  if (!rule) throw new Error("La configuración no tiene una regla de asistencia válida");
  const items = rows.map((row: any) => toReportItem(row, rule));
  const counts = {
    total: items.length,
    ok: items.filter((item) => item.classification.severity === "ok").length,
    warnings: items.filter((item) => item.classification.severity === "warning").length,
    violations: items.filter((item) => item.classification.severity === "violation").length
  };
  const contacts = await loadContacts(supabase, config.company_id);
  const recipients = resolveReportRecipients(contacts, {
    unitType: config.unit_type as UnitType,
    branchId: config.branch_id,
    departmentId: config.department_id,
    region: config.region,
    hasViolations: counts.violations > 0,
    hasWarnings: counts.warnings > 0,
    copyHrManagerOnlyOnViolation: config.copy_hr_manager_only_on_violation,
    warningsTriggerHrCopy: config.warnings_trigger_hr_copy || rule.warnings_trigger_hr_copy,
    copyCommercialManager: config.copy_commercial_manager && config.unit_type === "store"
  });
  const targetName = targetLabel(config);
  const syncStatus = run?.sync_status ?? null;
  const partialSync = Boolean(syncStatus && syncStatus !== "complete");
  const subject = `Reporte de asistencia${partialSync ? " parcial" : ""} - ${targetName} - ${reportDate}`;
  const html = buildBasicHtml({ targetName, reportDate, counts, items, hasViolations: counts.violations > 0, syncStatus });

  const result = {
    report_date: reportDate,
    config_id: config.id,
    target: targetName,
    unit_type: config.unit_type,
    recipients,
    counts,
    has_violations: counts.violations > 0,
    ready_to_send: recipients.to.length > 0,
    items
  };
  if (dryRun) return result;
  if (!run) throw new Error("No fue posible crear la ejecución del reporte");
  if (recipients.to.length === 0) {
    await updateRun(supabase, run.id, {
      status: "failed",
      error_message: "No hay destinatarios TO configurados para esta unidad",
      recipients_snapshot: recipients,
      ...countColumns(counts)
    });
    throw new Error("No hay destinatarios TO configurados para esta unidad");
  }

  let excelPath: string | null = null;
  if (config.include_excel) {
    const workbook = await buildWorkbook(items, targetName, reportDate);
    excelPath = `automatic-reports/${reportDate}/${config.id}-${run.id}.xlsx`;
    const { error: uploadError } = await supabase.storage.from("exports").upload(excelPath, workbook, {
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      upsert: true
    });
    if (uploadError) throw uploadError;
  }

  const fromEmail = Deno.env.get("ATTENDANCE_REPORT_FROM_EMAIL");
  const fromName = Deno.env.get("ATTENDANCE_REPORT_FROM_NAME");
  if (!fromEmail || !fromName) throw new Error("Falta configurar ATTENDANCE_REPORT_FROM_EMAIL o ATTENDANCE_REPORT_FROM_NAME");
  const { data: outbox, error: outboxError } = await supabase.from("email_outbox").upsert({
    report_run_id: run.id,
    provider: "resend",
    from_email: fromEmail,
    from_name: fromName,
    to_emails: recipients.to,
    cc_emails: recipients.cc,
    subject,
    html_body: config.include_html ? html : basicSummaryHtml(targetName, reportDate, counts),
    attachment_path: excelPath,
    attachment_name: excelPath ? `Reporte-asistencia-${safeFilename(targetName)}-${reportDate}.xlsx` : null,
    status: "pending",
    retry_count: 0,
    next_retry_at: new Date().toISOString(),
    locked_at: null,
    provider_message_id: null,
    last_error: null,
    sent_at: null
  }, { onConflict: "report_run_id" }).select("id").single();
  if (outboxError) throw outboxError;

  await updateRun(supabase, run.id, {
    status: "queued",
    has_violations: counts.violations > 0,
    ...countColumns(counts),
    recipients_snapshot: recipients,
    subject,
    summary: { ...counts, sync_status: syncStatus },
    excel_path: excelPath,
    generated_at: new Date().toISOString(),
    error_message: null
  });
  return { ...result, run_id: run.id, outbox_id: outbox.id, excel_path: excelPath };
}

async function loadConfig(supabase: any, input: GenerateInput) {
  if (input.run_id) {
    const run = await loadRun(supabase, input.run_id);
    const { data, error } = await configQuery(supabase).eq("id", run.config_id).single();
    if (error) throw error;
    return data;
  }
  let query = configQuery(supabase);
  if (!input.dry_run) query = query.eq("is_active", true);
  if (input.branch_id) query = query.eq("branch_id", input.branch_id);
  else throw new Error("branch_id es obligatorio cuando no se proporciona run_id");
  if (input.department_id) query = query.eq("department_id", input.department_id);
  else query = query.is("department_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No existe configuración activa para la sucursal/departamento solicitado");
  return data;
}

function configQuery(supabase: any) {
  return supabase.from("attendance_report_configs").select(`
    *,
    branches:branch_id(name),
    departments:department_id(name),
    attendance_report_rules:rule_id(*)
  `);
}

async function loadRun(supabase: any, id: string) {
  const { data, error } = await supabase.from("attendance_report_runs").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function ensureRun(supabase: any, run: any, config: any, reportDate: string) {
  if (run) return run;
  const { data: existing, error: existingError } = await supabase.from("attendance_report_runs")
    .select("*").eq("config_id", config.id).eq("report_date", reportDate).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;
  const { data, error } = await supabase.from("attendance_report_runs").insert({
    config_id: config.id,
    report_date: reportDate,
    company_id: config.company_id,
    branch_id: config.branch_id,
    department_id: config.department_id,
    status: "pending"
  }).select("*").single();
  if (error) throw error;
  return data;
}

async function loadAttendanceRows(supabase: any, date: string, branchId: string, departmentId?: string | null) {
  const { data, error } = await supabase.from("daily_attendance").select(`
    *,
    employees:employee_id(
      full_name,employee_code,department_id,attendance_group_id,
      departments:department_id(name),attendance_groups:attendance_group_id(name)
    ),
    branches:branch_id(name),
    work_schedules:schedule_id(name)
  `).eq("attendance_date", date).eq("branch_id", branchId).order("actual_check_in", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []).filter((row: any) => !departmentId || one(row.employees)?.department_id === departmentId);
}

async function loadContacts(supabase: any, companyId: string): Promise<ReportContact[]> {
  const { data, error } = await supabase.from("attendance_report_contacts").select("*")
    .eq("company_id", companyId).eq("is_active", true);
  if (error) throw error;
  return data ?? [];
}

function toReportItem(row: any, rule: any) {
  const employee = one(row.employees) ?? {};
  const classification = classifyAttendance(row, rule);
  return {
    id: row.id,
    department: one(employee.departments)?.name ?? "",
    attendance_group: one(employee.attendance_groups)?.name ?? "",
    branch: one(row.branches)?.name ?? "",
    employee_name: employee.full_name ?? "",
    employee_code: employee.employee_code ?? "",
    date: row.attendance_date,
    schedule: one(row.work_schedules)?.name ?? "",
    expected_check_in: rule.expected_check_in,
    actual_check_in: row.actual_check_in,
    lunch_out: row.lunch_out,
    lunch_in: row.lunch_in,
    lunch_minutes: row.lunch_minutes ?? 0,
    expected_check_out: rule.expected_check_out,
    actual_check_out: row.actual_check_out,
    classification,
    observations: classification.codes.map(codeLabel).join(", ")
  };
}

function countColumns(counts: any) {
  return {
    total_employees: counts.total,
    ok_count: counts.ok,
    warning_count: counts.warnings,
    violation_count: counts.violations
  };
}

async function updateRun(supabase: any, id: string, values: Record<string, unknown>) {
  const { error } = await supabase.from("attendance_report_runs").update(values).eq("id", id);
  if (error) throw error;
}

async function buildWorkbook(items: any[], target: string, reportDate: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Hikvision Attendance";
  const sheet = workbook.addWorksheet("Asistencia", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    ["Departamento", "department", 22], ["Grupo de asistencia", "attendance_group", 22], ["Sucursal", "branch", 24],
    ["Nombre", "employee_name", 28], ["Código empleado", "employee_code", 16], ["Fecha", "date", 14],
    ["Horario", "schedule", 20], ["Entrada esperada", "expected_check_in", 18], ["Entrada real", "actual_check_in", 18],
    ["Estado entrada", "check_in_status", 18], ["Salida almuerzo", "lunch_out", 18], ["Entrada almuerzo", "lunch_in", 18],
    ["Duración pausa", "lunch_minutes", 16], ["Estado pausa", "break_status", 16], ["Salida esperada", "expected_check_out", 18],
    ["Salida real", "actual_check_out", 18], ["Estado salida", "check_out_status", 16], ["Estado general", "general_status", 18],
    ["Observaciones", "observations", 44]
  ].map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } };
  for (const item of items) {
    const row = sheet.addRow({
      ...item,
      actual_check_in: formatGuatemala(item.actual_check_in),
      lunch_out: formatGuatemala(item.lunch_out),
      lunch_in: formatGuatemala(item.lunch_in),
      actual_check_out: formatGuatemala(item.actual_check_out),
      check_in_status: severityLabel(item.classification.check_in_status),
      break_status: severityLabel(item.classification.break_status),
      check_out_status: severityLabel(item.classification.check_out_status),
      general_status: severityLabel(item.classification.severity)
    });
    applyCellSeverity(row.getCell("check_in_status"), item.classification.check_in_status);
    applyCellSeverity(row.getCell("break_status"), item.classification.break_status);
    applyCellSeverity(row.getCell("check_out_status"), item.classification.check_out_status);
    applyCellSeverity(row.getCell("general_status"), item.classification.severity);
  }
  sheet.autoFilter = { from: "A1", to: "S1" };
  sheet.headerFooter.oddHeader = `&B${target} — ${reportDate}`;
  return await workbook.xlsx.writeBuffer();
}

function applyCellSeverity(cell: any, severity: string) {
  const color = severity === "violation" ? "FFFECACA" : severity === "warning" ? "FFFEF3C7" : "FFDCFCE7";
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  cell.font = { color: { argb: severity === "violation" ? "FF991B1B" : severity === "warning" ? "FF92400E" : "FF166534" } };
}

function buildBasicHtml(input: { targetName: string; reportDate: string; counts: any; items: any[]; hasViolations: boolean; syncStatus?: string | null }) {
  const rows = input.items.map((item) => `<tr>
    <td>${escapeHtml(item.employee_name)}</td><td>${escapeHtml(item.department)}</td>
    <td>${escapeHtml(formatGuatemala(item.actual_check_in))}</td><td>${escapeHtml(formatGuatemala(item.actual_check_out))}</td>
    <td>${item.lunch_minutes} min</td><td style="color:${severityColor(item.classification.severity)}">${severityLabel(item.classification.severity)}</td>
    <td>${escapeHtml(item.observations)}</td></tr>`).join("");
  const violationMessage = input.hasViolations ? `<div style="padding:12px;background:#fee2e2;color:#7f1d1d;margin:16px 0">
    <strong>Se detectaron registros fuera de horario o con pausas no permitidas.</strong>
    <p>Para los colaboradores involucrados, agradeceremos indicar el motivo de la llegada tarde, la salida temprana o la variación en la pausa.</p>
    <p>Si existió una situación excepcional (permiso, comisión, emergencia), por favor responder a este correo adjuntando la justificación correspondiente.</p>
  </div>` : "";
  const syncMessage = input.syncStatus && input.syncStatus !== "complete" ? `<div style="padding:12px;background:#fef3c7;color:#78350f;margin:16px 0">
    <strong>Reporte parcial:</strong> la resincronización de dispositivos finalizó con estado ${escapeHtml(input.syncStatus)}. El reporte contiene la información disponible y el detalle técnico quedó registrado.
  </div>` : "";
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#1f2937">
    <h2>Reporte de asistencia — ${escapeHtml(input.targetName)}</h2><p>Fecha: ${input.reportDate}</p>
    <p><strong>Total:</strong> ${input.counts.total} · <strong>Correctos:</strong> ${input.counts.ok} · <strong>Alertas:</strong> ${input.counts.warnings} · <strong>Infracciones:</strong> ${input.counts.violations}</p>
    ${syncMessage}${violationMessage}<table cellpadding="7" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px">
    <thead><tr><th>Nombre</th><th>Departamento</th><th>Entrada</th><th>Salida</th><th>Pausa</th><th>Estado</th><th>Observaciones</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="color:#6b7280;font-size:12px">Mensaje automático generado por Hikvision Attendance.</p></body></html>`;
}

function basicSummaryHtml(target: string, date: string, counts: any) {
  return `<p>Reporte de asistencia de <strong>${escapeHtml(target)}</strong> para ${date}.</p><p>Total: ${counts.total}. Correctos: ${counts.ok}. Alertas: ${counts.warnings}. Infracciones: ${counts.violations}.</p>`;
}

function targetLabel(config: any) {
  const branch = one(config.branches)?.name ?? "Sucursal";
  const department = one(config.departments)?.name;
  return department ? `${branch} / ${department}` : branch;
}

function one(value: any) {
  return Array.isArray(value) ? value[0] : value;
}

function formatGuatemala(value?: string | null) {
  if (!value) return "Sin marcaje";
  return new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function severityLabel(value: string) {
  return value === "violation" ? "Infracción" : value === "warning" ? "Alerta" : "Correcto";
}

function severityColor(value: string) {
  return value === "violation" ? "#b91c1c" : value === "warning" ? "#a16207" : "#15803d";
}

function codeLabel(code: string) {
  const labels: Record<string, string> = {
    late_check_in: "Llegada tarde", early_check_out: "Salida temprana", lunch_exceeded: "Pausa excedida",
    missing_check_in: "Sin marcaje de entrada", missing_check_out: "Sin marcaje de salida",
    incomplete_marks: "Marcaje incompleto", absent_or_no_mark: "No se registró asistencia",
    on_time: "En horario", complete: "Marcaje completo"
  };
  return labels[code] ?? code;
}

function safeFilename(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]!));
}
