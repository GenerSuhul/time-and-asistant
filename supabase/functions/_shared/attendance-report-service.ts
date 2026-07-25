import ExcelJS from "npm:exceljs@4.4.0";
import { calculateAttendanceForDate } from "./attendance.ts";
import {
  classifyAttendance,
  normalizeReportColumns,
  resolveReportRecipients,
  resolveReportOutputs,
  type AttendanceClassification,
  type ReportBranchTarget,
  type ReportColumnKey,
  type ReportContact,
  type ReportOutput,
  type UnitType
} from "./attendance-report-engine.ts";

export type GenerateInput = {
  report_date: string;
  config_id?: string;
  output_key?: string;
  branch_id?: string;
  department_id?: string;
  dry_run?: boolean;
  run_id?: string;
  html_columns?: Partial<Record<ReportColumnKey, boolean>>;
  column_order?: string[];
};

export async function generateAttendanceReport(supabase: any, input: GenerateInput) {
  const reportDate = input.report_date;
  const dryRun = Boolean(input.dry_run);
  let run = input.run_id ? await loadRun(supabase, input.run_id) : null;
  const config = await loadConfig(supabase, input, run);
  const branches = await resolveConfigBranches(supabase, config, run?.branch_ids);
  const availableOutputs = resolveReportOutputs(branches, config.output_mode ?? "consolidated");
  const output = selectOutput(availableOutputs, input.output_key ?? run?.output_key);

  if (!dryRun) {
    run = await ensureRun(supabase, run, config, reportDate, output, branches);
    await transitionRun(supabase, run.id, "generating", "Generando reporte con datos de asistencia", {
      error_message: null,
      skipped_reason: null
    });
  }

  const selectedBranches = branches.filter((branch) => output.branchIds.includes(branch.id));
  for (const branch of selectedBranches) {
    await calculateAttendanceForDate(supabase, {
      date: reportDate,
      company_id: branch.company_id,
      branch_id: branch.id
    });
  }

  const rows = await loadAttendanceRows(supabase, reportDate, output.branchIds, config.department_id);
  const fallbackRule = one(config.attendance_report_rules);
  if (!fallbackRule) throw new Error("La configuración no tiene una regla de asistencia válida");
  const items: ReturnType<typeof toReportItem>[] = rows.map((row: any) =>
    toReportItem(row, one(row.attendance_report_rule_detail) ?? fallbackRule)
  );
  const counts = {
    total: items.length,
    ok: items.filter((item) => item.classification.severity === "ok").length,
    warnings: items.filter((item) => item.classification.severity === "warning").length,
    violations: items.filter((item) => item.classification.severity === "violation").length
  };
  const contacts = await loadContacts(supabase);
  const outputUnitType = reportUnitType(selectedBranches, config.unit_type);
  const recipients = resolveReportRecipients(contacts, {
    unitType: outputUnitType,
    companyIds: output.companyIds,
    branchIds: output.branchIds,
    regionIds: output.regionIds,
    branchId: output.primaryBranchId,
    departmentId: config.department_id,
    regionId: output.regionIds.length === 1 ? output.regionIds[0] : null,
    region: config.region,
    hasViolations: counts.violations > 0,
    hasWarnings: counts.warnings > 0,
    copyHrManagerOnlyOnViolation: config.copy_hr_manager_only_on_violation,
    warningsTriggerHrCopy: config.warnings_trigger_hr_copy || fallbackRule.warnings_trigger_hr_copy,
    copyCommercialManager: config.copy_commercial_manager && outputUnitType === "store"
  });
  const targetName = targetLabel(config, selectedBranches);
  const syncStatus = run?.sync_status ?? null;
  const partialSync = Boolean(syncStatus && syncStatus !== "complete");
  const subject = `Reporte de asistencia${partialSync ? " parcial" : ""} - ${targetName} - ${reportDate}`;
  const selectedColumns = normalizeReportColumns(
    dryRun && input.html_columns ? input.html_columns : config.html_columns,
    dryRun && input.column_order ? input.column_order : config.column_order
  );
  const html = buildReportEmailHtml({
    targetName, reportDate, counts, items, hasViolations: counts.violations > 0,
    syncStatus, columns: selectedColumns
  });

  const result = {
    report_date: reportDate,
    config_id: config.id,
    target: targetName,
    scope_type: config.scope_type,
    output_key: output.outputKey,
    output_mode: config.output_mode,
    branch_ids: output.branchIds,
    unit_type: outputUnitType,
    recipients,
    counts,
    has_violations: counts.violations > 0,
    ready_to_send: recipients.to.length > 0,
    columns: selectedColumns,
    html,
    items
  };
  if (dryRun) return result;
  if (!run) throw new Error("No fue posible crear la ejecución del reporte");
  if (recipients.to.length === 0) {
    const reason = "No hay destinatarios principales cuyo alcance cubra completamente esta salida";
    await transitionRun(supabase, run.id, "skipped", reason, {
      error_message: null,
      skipped_reason: reason,
      recipients_snapshot: recipients,
      ...countColumns(counts),
      subject,
      summary: { ...counts, sync_status: syncStatus, output_key: output.outputKey },
      generated_at: new Date().toISOString(),
      columns_snapshot: { enabled: config.html_columns, order: selectedColumns }
    });
    return { ...result, run_id: run.id, skipped: true, skipped_reason: reason };
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

  await transitionRun(supabase, run.id, "queued", "Reporte generado y agregado a la cola de correo", {
    has_violations: counts.violations > 0,
    ...countColumns(counts),
    recipients_snapshot: recipients,
    subject,
    summary: { ...counts, sync_status: syncStatus, output_key: output.outputKey },
    excel_path: excelPath,
    generated_at: new Date().toISOString(),
    error_message: null,
    columns_snapshot: { enabled: config.html_columns, order: selectedColumns },
    scope_snapshot: scopeSnapshot(config, output, selectedBranches)
  });
  return { ...result, run_id: run.id, outbox_id: outbox.id, excel_path: excelPath };
}

async function loadConfig(supabase: any, input: GenerateInput, run?: any) {
  if (run || input.config_id) {
    const { data, error } = await configQuery(supabase).eq("id", run?.config_id ?? input.config_id).single();
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
    companies:company_id(name),
    branches:branch_id(name),
    departments:department_id(name),
    attendance_report_regions:region_id(name),
    attendance_report_rules:rule_id(*),
    attendance_report_config_branches(branch_id)
  `);
}

export async function loadAttendanceReportConfig(supabase: any, id: string) {
  const { data, error } = await configQuery(supabase).eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function resolveConfigBranches(supabase: any, config: any, restrictedIds?: string[] | null): Promise<ReportBranchTarget[]> {
  let query = supabase.from("branches").select("id,company_id,region_id,name,unit_type").eq("is_active", true);
  const linkedIds = (config.attendance_report_config_branches ?? []).map((link: any) => link.branch_id);
  if (restrictedIds?.length) query = query.in("id", restrictedIds);
  else if (config.scope_type === "global") {
    // No additional filter.
  } else if (config.scope_type === "company") query = query.eq("company_id", config.company_id);
  else if (config.scope_type === "region") query = query.eq("company_id", config.company_id).eq("region_id", config.region_id);
  else if (config.scope_type === "branch") query = query.eq("id", config.branch_id);
  else if (config.scope_type === "branches") {
    if (!linkedIds.length) return [];
    query = query.in("id", linkedIds);
  } else if (config.scope_type === "department") {
    let departmentBranchIds = linkedIds;
    if (!departmentBranchIds.length) {
      const { data, error } = await supabase.from("department_branches").select("branch_id").eq("department_id", config.department_id);
      if (error) throw error;
      departmentBranchIds = (data ?? []).map((link: any) => link.branch_id);
    }
    if (!departmentBranchIds.length) return [];
    query = query.in("id", departmentBranchIds);
  } else if (config.branch_id) query = query.eq("id", config.branch_id);
  const { data, error } = await query.order("name");
  if (error) throw error;
  return data ?? [];
}

export async function resolveConfigOutputs(supabase: any, config: any) {
  const branches = await resolveConfigBranches(supabase, config);
  return { branches, outputs: resolveReportOutputs(branches, config.output_mode ?? "consolidated") };
}

async function loadRun(supabase: any, id: string) {
  const { data, error } = await supabase.from("attendance_report_runs").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function ensureRun(
  supabase: any,
  run: any,
  config: any,
  reportDate: string,
  output: ReportOutput,
  branches: ReportBranchTarget[]
) {
  if (run) return run;
  const { data: existing, error: existingError } = await supabase.from("attendance_report_runs")
    .select("*").eq("config_id", config.id).eq("report_date", reportDate).eq("output_key", output.outputKey).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;
  const { data, error } = await supabase.from("attendance_report_runs").insert({
    config_id: config.id,
    report_date: reportDate,
    company_id: output.companyIds.length === 1 ? output.companyIds[0] : null,
    branch_id: output.primaryBranchId,
    branch_ids: output.branchIds,
    output_key: output.outputKey,
    department_id: config.department_id,
    status: "pending",
    status_detail: "Ejecución creada",
    scope_snapshot: scopeSnapshot(config, output, branches.filter((branch) => output.branchIds.includes(branch.id))),
    columns_snapshot: { enabled: config.html_columns, order: normalizeReportColumns(config.html_columns, config.column_order) },
    audit_log: [{ status: "pending", at: new Date().toISOString(), detail: "Ejecución creada" }]
  }).select("*").single();
  if (error) throw error;
  return data;
}

async function loadAttendanceRows(supabase: any, date: string, branchIds: string[], departmentId?: string | null) {
  if (!branchIds.length) return [];
  const { data, error } = await supabase.from("daily_attendance").select(`
    *,
    employees:employee_id(
      full_name,employee_code,department_id,
      departments:department_id(name)
    ),
    branches:branch_id(name),
    attendance_report_rules:rule_id(name),
    attendance_report_rule_detail:rule_id(*)
  `).eq("attendance_date", date).in("branch_id", branchIds).order("actual_check_in", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []).filter((row: any) => !departmentId || one(row.employees)?.department_id === departmentId);
}

async function loadContacts(supabase: any): Promise<ReportContact[]> {
  const { data, error } = await supabase.from("attendance_report_contacts")
    .select("*,attendance_report_contact_branches(branch_id)").eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((contact: any) => ({
    ...contact,
    branch_ids: (contact.attendance_report_contact_branches ?? []).map((link: any) => link.branch_id)
  }));
}

function toReportItem(row: any, rule: any) {
  const employee = one(row.employees) ?? {};
  const classification = classifyAttendance(row, rule);
  return {
    id: row.id,
    department: one(employee.departments)?.name ?? "",
    branch: one(row.branches)?.name ?? "",
    employee_name: employee.full_name ?? "",
    employee_code: employee.employee_code ?? "",
    date: row.attendance_date,
    schedule: one(row.attendance_report_rules)?.name ?? "",
    expected_check_in: rule.expected_check_in,
    actual_check_in: row.actual_check_in,
    lunch_out: row.lunch_out,
    lunch_in: row.lunch_in,
    lunch_minutes: row.lunch_minutes ?? 0,
    break_records: Array.isArray(row.break_records) ? row.break_records : [],
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

export async function transitionRun(
  supabase: any,
  id: string,
  status: string,
  detail: string,
  values: Record<string, unknown> = {}
) {
  const { data: current, error: readError } = await supabase.from("attendance_report_runs").select("audit_log").eq("id", id).single();
  if (readError) throw readError;
  const audit = Array.isArray(current.audit_log) ? current.audit_log : [];
  const { error } = await supabase.from("attendance_report_runs").update({
    ...values,
    status,
    status_detail: detail,
    audit_log: [...audit, { status, detail, at: new Date().toISOString() }]
  }).eq("id", id);
  if (error) throw error;
}

function selectOutput(outputs: ReportOutput[], requested?: string | null) {
  if (!outputs.length) throw new Error("El alcance configurado no resuelve ninguna sucursal activa");
  if (!requested) return outputs[0];
  const output = outputs.find((item) => item.outputKey === requested);
  if (!output) throw new Error("La salida solicitada no pertenece al alcance actual de la configuración");
  return output;
}

function reportUnitType(branches: ReportBranchTarget[], configured: string): UnitType | "mixed" {
  if (configured === "department") return "department";
  const values = [...new Set(branches.map((branch) => branch.unit_type).filter(Boolean))];
  return values.length === 1 ? values[0] as UnitType : "mixed";
}

function scopeSnapshot(config: any, output: ReportOutput, branches: ReportBranchTarget[]) {
  return {
    scope_type: config.scope_type,
    output_mode: config.output_mode,
    output_key: output.outputKey,
    company_ids: output.companyIds,
    branch_ids: output.branchIds,
    branch_names: branches.map((branch) => branch.name).filter(Boolean),
    region_ids: output.regionIds,
    department_id: config.department_id ?? null
  };
}

async function buildWorkbook(items: any[], target: string, reportDate: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Hikvision Attendance";
  const sheet = workbook.addWorksheet("Asistencia", { views: [{ state: "frozen", ySplit: 1 }] });
  const columns: Array<[string, string, number]> = [
    ["Departamento", "department", 22], ["Sucursal", "branch", 24],
    ["Nombre", "employee_name", 28], ["Código empleado", "employee_code", 16], ["Fecha", "date", 14],
    ["Horario", "schedule", 20], ["Entrada esperada", "expected_check_in", 18], ["Entrada real", "actual_check_in", 18],
    ["Estado entrada", "check_in_status", 18], ["Salida almuerzo", "lunch_out", 18], ["Entrada almuerzo", "lunch_in", 18],
    ["Duración pausa", "lunch_minutes", 16], ["Estado pausa", "break_status", 16], ["Salida esperada", "expected_check_out", 18],
    ["Salida real", "actual_check_out", 18], ["Estado salida", "check_out_status", 16], ["Estado general", "general_status", 18],
    ["Observaciones", "observations", 44]
  ];
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
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

function buildReportEmailHtml(input: {
  targetName: string;
  reportDate: string;
  counts: any;
  items: any[];
  hasViolations: boolean;
  syncStatus?: string | null;
  columns: ReportColumnKey[];
}) {
  const scope = reportEmailScope(input);
  const schedule = reportEmailSchedule(input.items);
  const rows = input.items.map((item) => reportEmailRowHtml(item, input.columns)).join("");
  const headers = input.columns.map((column) => reportEmailHeaderHtml(column)).join("");
  const emptyRows = input.items.length === 0 ? `<tr><td colspan="${input.columns.length}" style="padding:28px;text-align:center;color:#8b94a7;border-top:1px solid #edf0f7">No hay registros de asistencia para este reporte.</td></tr>` : "";
  const syncMessage = input.syncStatus && input.syncStatus !== "complete" ? `<div style="margin:0 30px 18px 30px;padding:14px 16px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:14px;line-height:1.45">
    <strong>Reporte parcial:</strong> algunos dispositivos no respondieron correctamente. El reporte contiene la informacion disponible.
  </div>` : "";
  const violationMessage = input.hasViolations ? `<div style="margin:0 30px 18px 30px;padding:14px 16px;border-radius:12px;background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;font-size:14px;line-height:1.45">
    <strong>Se detectaron alertas de asistencia.</strong> Por favor revisar los colaboradores marcados y responder con la justificacion correspondiente cuando aplique.
  </div>` : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    @media only screen and (max-width: 720px) {
      .email-shell { padding: 14px !important; }
      .hero-cell { display: block !important; width: 100% !important; }
      .hero-title { font-size: 22px !important; line-height: 1.2 !important; margin-top: 14px !important; }
      .meta-cell { display: block !important; width: 100% !important; padding: 0 0 10px 0 !important; }
      .table-wrap { overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; }
      .report-table { min-width: ${Math.max(620, input.columns.length * 145)}px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#f7f8ff;color:#111936;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif">
  <div class="email-shell" style="padding:24px">
    <div style="max-width:1480px;margin:0 auto">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#ffffff;border-radius:16px;box-shadow:0 14px 36px rgba(17,25,54,.08);overflow:hidden">
        <tr>
          <td style="padding:28px 34px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td class="hero-cell" style="width:96px;vertical-align:middle">
                  <div style="font-size:44px;line-height:38px;font-weight:900;letter-spacing:-3px;color:#071039">ac</div>
                  <div style="width:56px;height:4px;background:#4f46ff;border-radius:8px;margin-top:9px"></div>
                </td>
                <td class="hero-cell" style="width:1px;background:#d9deed"></td>
                <td class="hero-cell" style="vertical-align:middle;padding-left:30px">
                  <h1 class="hero-title" style="margin:0;font-size:27px;line-height:1.18;color:#111936;font-weight:800;letter-spacing:-.4px">Reporte de Asistencia - ${escapeHtml(input.targetName)}</h1>
                  <div style="margin-top:10px;font-size:14px;color:#626b82">Bloque: ${escapeHtml(scope.label)}: <span style="color:#4f46ff;font-weight:800">${escapeHtml(scope.value)}</span></div>
                </td>
                <td class="hero-cell" align="right" style="width:84px;vertical-align:middle">
                  <div style="display:inline-block;width:60px;height:60px;border-radius:12px;background:#f1efff;text-align:center;color:#4f46ff;font-size:32px;line-height:60px;font-weight:800">&#10003;</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <div style="padding:26px 22px 12px 22px">
        <p style="margin:0 0 14px 0;font-size:16px;color:#111936;font-weight:800">Hola equipo,</p>
        <p style="margin:0 0 22px 0;font-size:14px;color:#111936;line-height:1.5">Adjunto encontraran el reporte de asistencia correspondiente a la sucursal.</p>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="meta-cell" style="padding-right:14px;vertical-align:top;width:250px">${reportMetaPill("&#9635;", "Fecha del reporte:", formatReportEmailDate(input.reportDate))}</td>
            <td class="meta-cell" style="padding-right:14px;vertical-align:top;width:320px">${reportMetaPill("&#9637;", `${scope.label}:`, scope.value)}</td>
            <td class="meta-cell" style="vertical-align:top;width:230px">${reportMetaPill("&#9719;", "Horario:", schedule)}</td>
            <td class="meta-cell" align="right" style="vertical-align:top">${reportLegendHtml()}</td>
          </tr>
        </table>
      </div>

      ${syncMessage}
      ${violationMessage}

      <div style="background:#ffffff;border:1px solid #e8ebf4;border-radius:18px;box-shadow:0 16px 40px rgba(17,25,54,.08);padding:14px;margin-top:12px">
        <div class="table-wrap" style="width:100%;overflow-x:auto">
          <table class="report-table" role="table" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;min-width:${Math.max(620, input.columns.length * 145)}px;font-size:14px;color:#202847">
            <thead>
              <tr>${headers}</tr>
            </thead>
            <tbody>${rows}${emptyRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function reportEmailHeaderHtml(column: ReportColumnKey) {
  const labels: Record<ReportColumnKey, string> = {
    name: "Nombre",
    department: "Departamento",
    schedule: "Grupo / horario",
    actual_check_in: "Entrada real",
    actual_check_out: "Salida real",
    attendance_log: "Grabación de asistencia",
    break_duration: "Duración de pausa",
    break_records: "Registros de descansos",
    status: "Estado / observación",
    events: "Eventos / detalle"
  };
  return `<th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:${column === "name" || column === "department" ? "left" : "center"}">${escapeHtml(labels[column])}</th>`;
}

function reportEmailRowHtml(item: any, columns: ReportColumnKey[]) {
  const checkIn = formatReportEmailTime(item.actual_check_in);
  const checkOut = formatReportEmailTime(item.actual_check_out);
  const attendanceLog = `${checkIn === "-" ? "Ninguno" : checkIn} / ${checkOut === "-" ? "Ninguno" : checkOut}`;
  const breakMinutes = Number(item.lunch_minutes ?? 0);
  const breakDuration = breakMinutes > 0 ? minutesToDuration(breakMinutes) : "-";
  const breaks = reportBreakRecordsHtml(item, breakMinutes);
  const cells: Record<ReportColumnKey, string> = {
    name: `<span style="color:#202847;font-weight:600">${escapeHtml(item.employee_name)}</span>`,
    department: escapeHtml(item.department || "-"),
    schedule: escapeHtml(item.schedule || "-"),
    actual_check_in: reportTimeCell(checkIn, item.classification.check_in_status),
    actual_check_out: reportTimeCell(checkOut, item.classification.check_out_status),
    attendance_log: escapeHtml(attendanceLog),
    break_duration: reportDurationPill(breakDuration, item.classification.break_status),
    break_records: breaks,
    status: reportStatusPill(item),
    events: escapeHtml(item.observations || "Sin observaciones")
  };
  return `<tr>${columns.map((column) =>
    `<td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:${column === "name" || column === "department" ? "left" : "center"}">${cells[column]}</td>`
  ).join("")}</tr>`;
}

function reportBreakRecordsHtml(item: any, totalMinutes: number) {
  const records = Array.isArray(item.break_records) ? item.break_records : [];
  if (records.length > 0) {
    return records.map((record: any) => {
      const out = formatReportEmailTime(record?.out);
      const back = formatReportEmailTime(record?.in);
      const minutes = Number(record?.minutes ?? 0);
      const duration = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
      const detail = duration > 0 ? `<br><span style="color:#626b82">(${duration} min)</span>` : "";
      return `${out} - ${back}${detail}`;
    }).join("<br>");
  }
  if (item.lunch_out || item.lunch_in) {
    const detail = totalMinutes > 0 ? `<br><span style="color:#626b82">(${totalMinutes} min)</span>` : "";
    return `${formatReportEmailTime(item.lunch_out)} - ${formatReportEmailTime(item.lunch_in)}${detail}`;
  }
  return "-";
}

function reportMetaPill(icon: string, label: string, value: string) {
  return `<div style="display:inline-block;width:100%;box-sizing:border-box;padding:13px 16px;border:1px solid #e4e6f2;background:#fbfbff;border-radius:8px;color:#111936;font-size:14px;line-height:1.2">
    <span style="color:#4f46ff;font-size:18px;font-weight:800;vertical-align:middle">${icon}</span>
    <span style="color:#4f46ff;font-weight:800;margin-left:8px">${escapeHtml(label)}</span>
    <span style="margin-left:4px">${escapeHtml(value)}</span>
  </div>`;
}

function reportLegendHtml() {
  return `<div style="display:inline-block;padding:13px 18px;border:1px solid #e4e6f2;background:#fbfbff;border-radius:8px;color:#111936;font-size:14px;white-space:nowrap">
    <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:#26bf3f;margin-right:7px"></span>OK
    <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:#ff244e;margin:0 7px 0 24px"></span>Alerta
    <span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:#aeb4c1;margin:0 7px 0 24px"></span>Sin dato
  </div>`;
}

function reportTimeCell(value: string, severity: string) {
  if (value === "-") return `<span style="color:#202847">-</span>`;
  if (severity === "violation") return `<span style="display:inline-block;padding:7px 14px;border-radius:7px;background:#fff1f2;color:#ff244e;font-weight:800;letter-spacing:.4px">${escapeHtml(value)}</span>`;
  return `<span>${escapeHtml(value)}</span>`;
}

function reportDurationPill(value: string, severity: string) {
  if (value === "-") return `<span style="color:#202847">-</span>`;
  const isBad = severity === "violation";
  return `<span style="display:inline-block;padding:7px 14px;border-radius:7px;border:1px solid ${isBad ? "#fecdd3" : "#d7f8dc"};background:${isBad ? "#fff1f2" : "#f0fff3"};color:${isBad ? "#ff244e" : "#11a739"};font-weight:700">${escapeHtml(value)}</span>`;
}

function reportStatusPill(item: any) {
  const severity = item.classification.severity;
  const label = reportStatusObservation(item);
  const colors = severity === "violation"
    ? { bg: "#fff1f2", fg: "#ff244e", dot: "#ff244e", border: "#ffe1e7" }
    : severity === "warning"
      ? { bg: "#f6f7fa", fg: "#545d70", dot: "#aeb4c1", border: "#eceff5" }
      : { bg: "#ecfff0", fg: "#15803d", dot: "#26bf3f", border: "#d7f8dc" };
  return `<span style="display:inline-block;min-width:98px;padding:8px 12px;border-radius:7px;border:1px solid ${colors.border};background:${colors.bg};color:${colors.fg};font-weight:800">
    <span style="display:inline-block;width:9px;height:9px;border-radius:999px;background:${colors.dot};margin-right:8px"></span>${escapeHtml(label)}
  </span>`;
}

function reportStatusObservation(item: any) {
  const codes = new Set(item.classification.codes ?? []);
  if (item.classification.severity === "ok") return "A tiempo";
  if (codes.has("late_check_in")) return "Tardia";
  if (codes.has("early_check_out")) return "Salida temp.";
  if (codes.has("lunch_exceeded")) return "Pausa alta";
  if (codes.has("absent_or_no_mark") || codes.has("missing_check_in") || codes.has("missing_check_out")) return "Sin marca";
  return severityLabel(item.classification.severity);
}

function reportEmailScope(input: { targetName: string; items: any[] }) {
  const departments = uniqueNonEmpty(input.items.map((item) => item.department));
  if (departments.length === 1) return { label: "Departamento", value: departments[0].toUpperCase() };
  const branches = uniqueNonEmpty(input.items.map((item) => item.branch));
  if (branches.length === 1) return { label: "Sucursal", value: branches[0] };
  return { label: "Unidad", value: input.targetName };
}

function reportEmailSchedule(items: any[]) {
  const first = items.find((item) => item.expected_check_in || item.expected_check_out);
  if (!first) return "-";
  return `${String(first.expected_check_in ?? "").slice(0, 5)} - ${String(first.expected_check_out ?? "").slice(0, 5)}`;
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function formatReportEmailDate(value: string) {
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function formatReportEmailTime(value?: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("es-GT", { timeZone: "America/Guatemala", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function minutesToDuration(value: number) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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

function targetLabel(config: any, branches: ReportBranchTarget[]) {
  const branchNames = branches.map((branch) => branch.name).filter(Boolean);
  const department = one(config.departments)?.name;
  if (config.scope_type === "global") return "Reporte global";
  if (config.scope_type === "company") return one(config.companies)?.name ?? "Empresa completa";
  if (config.scope_type === "region") return `Región ${one(config.attendance_report_regions)?.name ?? ""}`.trim();
  if (config.scope_type === "department") {
    const suffix = branchNames.length === 1 ? ` / ${branchNames[0]}` : "";
    return `${department ?? "Departamento"}${suffix}`;
  }
  if (branchNames.length === 1) return branchNames[0]!;
  if (branchNames.length > 1) return `${branchNames.length} sucursales`;
  return one(config.branches)?.name ?? "Alcance sin sucursales";
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
