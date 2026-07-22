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
  const html = buildReportEmailHtml({ targetName, reportDate, counts, items, hasViolations: counts.violations > 0, syncStatus });

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
      full_name,employee_code,department_id,
      departments:department_id(name)
    ),
    branches:branch_id(name),
    attendance_report_rules:rule_id(name)
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

async function updateRun(supabase: any, id: string, values: Record<string, unknown>) {
  const { error } = await supabase.from("attendance_report_runs").update(values).eq("id", id);
  if (error) throw error;
}

async function buildWorkbook(items: any[], target: string, reportDate: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Hikvision Attendance";
  const sheet = workbook.addWorksheet("Asistencia", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [
    ["Departamento", "department", 22], ["Sucursal", "branch", 24],
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

function buildReportEmailHtml(input: { targetName: string; reportDate: string; counts: any; items: any[]; hasViolations: boolean; syncStatus?: string | null }) {
  const scope = reportEmailScope(input);
  const schedule = reportEmailSchedule(input.items);
  const rows = input.items.map((item) => reportEmailRowHtml(item)).join("");
  const emptyRows = input.items.length === 0 ? `<tr><td colspan="8" style="padding:28px;text-align:center;color:#8b94a7;border-top:1px solid #edf0f7">No hay registros de asistencia para este reporte.</td></tr>` : "";
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
      .report-table { min-width: 980px !important; }
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
          <table class="report-table" role="table" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;min-width:980px;font-size:14px;color:#202847">
            <thead>
              <tr>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;border-top-left-radius:12px;text-align:left;width:42px"></th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:left">Nombre</th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:center">Hora real de<br>registro de entrada</th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:center">Hora real de<br>registro de salida</th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:center">Grabacion de<br>asistencia</th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:center">Duracion de<br>la pausa</th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;text-align:center">Registros de<br>descansos</th>
                <th style="padding:16px 14px;background:#f7f6ff;color:#4f46ff;font-weight:800;border-top-right-radius:12px;text-align:center">Estado / Observacion</th>
              </tr>
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

function reportEmailRowHtml(item: any) {
  const checkIn = formatReportEmailTime(item.actual_check_in);
  const checkOut = formatReportEmailTime(item.actual_check_out);
  const attendanceLog = `${checkIn === "-" ? "Ninguno" : checkIn} / ${checkOut === "-" ? "Ninguno" : checkOut}`;
  const breakMinutes = Number(item.lunch_minutes ?? 0);
  const breakDuration = breakMinutes > 0 ? minutesToDuration(breakMinutes) : "-";
  const breaks = reportBreakRecordsHtml(item, breakMinutes);
  return `<tr>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;color:#4f46ff;font-size:18px;text-align:center">&#9817;</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;color:#202847;font-weight:500">${escapeHtml(item.employee_name)}</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:center">${reportTimeCell(checkIn, item.classification.check_in_status)}</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:center">${reportTimeCell(checkOut, item.classification.check_out_status)}</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:center">${escapeHtml(attendanceLog)}</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:center">${reportDurationPill(breakDuration, item.classification.break_status)}</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:center">${breaks}</td>
    <td style="padding:13px 14px;border-top:1px solid #edf0f7;text-align:center;white-space:nowrap">${reportStatusPill(item)} <span style="display:inline-block;margin-left:10px;padding:8px 18px;border:1px solid #d8d6ff;border-radius:8px;color:#4f46ff;font-weight:700;background:#fff">Ver detalle</span> <span style="display:inline-block;margin-left:10px;color:#111936;font-size:18px;vertical-align:middle">&#8942;</span></td>
  </tr>`;
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
