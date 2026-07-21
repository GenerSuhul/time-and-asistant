type SupabaseClientLike = any;

type CalculateParams = {
  date: string;
  company_id?: string;
  branch_id?: string;
  employee_id?: string;
};

type EventRow = {
  event_type: string;
  occurred_at: string;
  source?: string;
  device_id?: string | null;
};

const GUATEMALA_OFFSET = "-06:00";

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function minutesBetween(start?: Date | null, end?: Date | null) {
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function timeOnDate(date: string, time?: string | null) {
  if (!time) return null;
  return new Date(`${date}T${time}${GUATEMALA_OFFSET}`);
}

function firstByType(events: EventRow[], type: string) {
  const match = events.find((event) => event.event_type === type);
  return match ? new Date(match.occurred_at) : null;
}

function lastByType(events: EventRow[], type: string) {
  const match = [...events].reverse().find((event) => event.event_type === type);
  return match ? new Date(match.occurred_at) : null;
}

function pairBreaks(events: EventRow[]) {
  const records: { out: string; in: string | null; minutes: number }[] = [];
  let open: EventRow | null = null;
  for (const event of events.filter((item) => ["lunch_out", "lunch_in", "break_out", "break_in"].includes(item.event_type))) {
    if (["lunch_out", "break_out"].includes(event.event_type)) {
      if (open) records.push({ out: open.occurred_at, in: null, minutes: 0 });
      open = event;
    } else if (open) {
      records.push({ out: open.occurred_at, in: event.occurred_at, minutes: minutesBetween(new Date(open.occurred_at), new Date(event.occurred_at)) });
      open = null;
    }
  }
  if (open) records.push({ out: open.occurred_at, in: null, minutes: 0 });
  return records;
}

function dayOfWeek(date: string) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export async function calculateAttendanceForDate(supabase: SupabaseClientLike, params: CalculateParams) {
  let employeesQuery = supabase
    .from("employees")
    .select("id, company_id, branch_id, attendance_group_id, status")
    .eq("status", "active");

  if (params.employee_id) employeesQuery = employeesQuery.eq("id", params.employee_id);
  if (params.company_id) employeesQuery = employeesQuery.eq("company_id", params.company_id);
  if (params.branch_id) employeesQuery = employeesQuery.eq("branch_id", params.branch_id);

  const { data: employees, error: employeesError } = await employeesQuery;
  if (employeesError) throw employeesError;

  const employeeRows = employees ?? [];
  if (employeeRows.length === 0) return { processed_count: 0, employee_ids: [] };

  const employeeIds = employeeRows.map((employee: any) => employee.id as string);
  const groupIds = [...new Set(employeeRows.map((employee: any) => employee.attendance_group_id).filter(Boolean))];
  const companyIds = [...new Set(employeeRows.map((employee: any) => employee.company_id).filter(Boolean))];

  const schedulesRequest = groupIds.length
    ? supabase.from("work_schedules")
        .select("id,attendance_group_id,default_check_in,default_check_out,tolerance_minutes")
        .in("attendance_group_id", groupIds).eq("is_active", true)
    : Promise.resolve({ data: [], error: null });
  const eventsRequest = supabase.from("attendance_events")
    .select("employee_id,event_type,occurred_at,source,device_id")
    .in("employee_id", employeeIds).eq("event_date_local", params.date)
    .order("occurred_at", { ascending: true });
  const adjustmentsRequest = supabase.from("manual_adjustments")
    .select("employee_id,event_type,occurred_at")
    .in("employee_id", employeeIds).eq("attendance_date", params.date).eq("status", "approved")
    .order("occurred_at", { ascending: true });
  const holidaysRequest = companyIds.length
    ? supabase.from("holidays").select("id,company_id,branch_id")
        .in("company_id", companyIds).eq("holiday_date", params.date)
    : Promise.resolve({ data: [], error: null });
  const leavesRequest = supabase.from("leave_requests").select("id,employee_id")
    .in("employee_id", employeeIds).eq("status", "approved")
    .lte("start_date", params.date).gte("end_date", params.date);

  const [schedulesResult, eventsResult, adjustmentsResult, holidaysResult, leavesResult] = await Promise.all([
    schedulesRequest, eventsRequest, adjustmentsRequest, holidaysRequest, leavesRequest
  ]);
  for (const result of [schedulesResult, eventsResult, adjustmentsResult, holidaysResult, leavesResult]) {
    if (result.error) throw result.error;
  }

  const schedules = schedulesResult.data ?? [];
  const scheduleIds = schedules.map((schedule: any) => schedule.id as string);
  const rulesResult = scheduleIds.length
    ? await supabase.from("schedule_rules")
        .select("schedule_id,is_workday,expected_check_in,expected_check_out,tolerance_minutes")
        .in("schedule_id", scheduleIds).eq("day_of_week", dayOfWeek(params.date))
    : { data: [], error: null };
  if (rulesResult.error) throw rulesResult.error;

  const scheduleByGroup = new Map(schedules.map((schedule: any) => [schedule.attendance_group_id, schedule]));
  const ruleBySchedule = new Map((rulesResult.data ?? []).map((rule: any) => [rule.schedule_id, rule]));
  const eventsByEmployee = groupByEmployee(eventsResult.data ?? []);
  const adjustmentsByEmployee = groupByEmployee(adjustmentsResult.data ?? []);
  const leaveEmployeeIds = new Set((leavesResult.data ?? []).map((leave: any) => leave.employee_id));
  const holidays = holidaysResult.data ?? [];
  const dailyRows = [];

  for (const employee of employeeRows) {
    const schedule: any = scheduleByGroup.get(employee.attendance_group_id);
    const scheduleRule: any = schedule?.id ? ruleBySchedule.get(schedule.id) : null;
    const expectedCheckIn = scheduleRule?.expected_check_in ?? schedule?.default_check_in ?? null;
    const expectedCheckOut = scheduleRule?.expected_check_out ?? schedule?.default_check_out ?? null;
    const tolerance = scheduleRule?.tolerance_minutes ?? schedule?.tolerance_minutes ?? 5;
    const isWorkday = scheduleRule?.is_workday ?? Boolean(schedule);
    const holiday = holidays.some((item: any) => item.company_id === employee.company_id &&
      (item.branch_id === null || item.branch_id === employee.branch_id));
    const leave = leaveEmployeeIds.has(employee.id);
    const events: EventRow[] = [
      ...((eventsByEmployee.get(employee.id) ?? []) as EventRow[]),
      ...((adjustmentsByEmployee.get(employee.id) ?? []).map((event: any) => ({ ...event, source: "manual" })) as EventRow[])
    ].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

    const actualCheckIn = firstByType(events, "check_in");
    const lunchOut = firstByType(events, "lunch_out");
    const lunchIn = firstByType(events, "lunch_in");
    const actualCheckOut = lastByType(events, "check_out");
    const breakRecords = pairBreaks(events);

    const expectedInDate = timeOnDate(params.date, expectedCheckIn);
    const expectedOutDate = timeOnDate(params.date, expectedCheckOut);

    const warnings: string[] = [];
    let status = "complete";

    if (holiday) status = "holiday";
    else if (leave) status = "leave";
    else if (!isWorkday) status = events.length > 0 ? "complete" : "day_off";
    else if (events.length === 0) status = "absent";
    else if (actualCheckIn && !actualCheckOut) status = "incomplete";

    if (!["holiday", "leave", "absent", "day_off"].includes(status) && (Boolean(actualCheckIn) !== Boolean(actualCheckOut))) {
      status = "incomplete";
      warnings.push(actualCheckIn ? "Registro de salida faltante." : "Registro de entrada faltante.");
    }

    if (lunchOut && !lunchIn) {
      warnings.push("Salida de almuerzo sin entrada de almuerzo.");
      status = "incomplete";
    }
    if (lunchIn && !lunchOut) {
      warnings.push("Entrada de almuerzo sin salida de almuerzo.");
      status = "incomplete";
    }

    const lateMinutes =
      actualCheckIn && expectedInDate
        ? Math.max(0, minutesBetween(expectedInDate, actualCheckIn) - tolerance)
        : 0;
    const earlyLeaveMinutes =
      actualCheckOut && expectedOutDate
        ? Math.max(0, minutesBetween(actualCheckOut, expectedOutDate) - tolerance)
        : 0;
    const overtimeMinutes =
      actualCheckOut && expectedOutDate ? Math.max(0, minutesBetween(expectedOutDate, actualCheckOut)) : 0;
    const lunchMinutes = breakRecords.reduce((total, item) => total + item.minutes, 0);
    const workedMinutes = actualCheckIn && actualCheckOut ? Math.max(0, minutesBetween(actualCheckIn, actualCheckOut) - lunchMinutes) : 0;

    if (status === "complete" && lateMinutes > 0) status = "late";
    if (status === "complete" && earlyLeaveMinutes > 0) status = "early_leave";

    dailyRows.push({
        employee_id: employee.id,
        branch_id: employee.branch_id,
        attendance_date: params.date,
        schedule_id: schedule?.id ?? null,
        expected_check_in: expectedCheckIn,
        actual_check_in: actualCheckIn?.toISOString() ?? null,
        lunch_out: lunchOut?.toISOString() ?? null,
        lunch_in: lunchIn?.toISOString() ?? null,
        expected_check_out: expectedCheckOut,
        actual_check_out: actualCheckOut?.toISOString() ?? null,
        worked_minutes: workedMinutes,
        lunch_minutes: lunchMinutes,
        break_records: breakRecords,
        device_ids: [...new Set(events.map((event) => event.device_id).filter(Boolean))],
        late_minutes: lateMinutes,
        early_leave_minutes: earlyLeaveMinutes,
        overtime_minutes: overtimeMinutes,
        status,
        warnings,
        calculated_at: new Date().toISOString()
      });
  }

  const { error: upsertError } = await supabase.from("daily_attendance")
    .upsert(dailyRows, { onConflict: "employee_id,attendance_date" });
  if (upsertError) throw upsertError;
  return { processed_count: employeeIds.length, employee_ids: employeeIds };
}

function groupByEmployee(rows: any[]) {
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    const current = grouped.get(row.employee_id) ?? [];
    current.push(row);
    grouped.set(row.employee_id, current);
  }
  return grouped;
}
