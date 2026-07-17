type SupabaseClientLike = any;

type CalculateParams = {
  date: string;
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
  if (params.branch_id) employeesQuery = employeesQuery.eq("branch_id", params.branch_id);

  const { data: employees, error: employeesError } = await employeesQuery;
  if (employeesError) throw employeesError;

  const processed: string[] = [];
  const dateEnd = nextDate(params.date);

  for (const employee of employees ?? []) {
    const { data: schedule } = await supabase
      .from("work_schedules")
      .select("id, default_check_in, default_lunch_out, default_lunch_in, default_check_out, tolerance_minutes")
      .eq("attendance_group_id", employee.attendance_group_id)
      .eq("is_active", true)
      .maybeSingle();

    const { data: scheduleRule } = schedule?.id
      ? await supabase
          .from("schedule_rules")
          .select("is_workday, expected_check_in, lunch_out, lunch_in, expected_check_out, tolerance_minutes")
          .eq("schedule_id", schedule.id)
          .eq("day_of_week", dayOfWeek(params.date))
          .maybeSingle()
      : { data: null };

    const expectedCheckIn = scheduleRule?.expected_check_in ?? schedule?.default_check_in ?? null;
    const expectedLunchOut = scheduleRule?.lunch_out ?? schedule?.default_lunch_out ?? null;
    const expectedLunchIn = scheduleRule?.lunch_in ?? schedule?.default_lunch_in ?? null;
    const expectedCheckOut = scheduleRule?.expected_check_out ?? schedule?.default_check_out ?? null;
    const tolerance = scheduleRule?.tolerance_minutes ?? schedule?.tolerance_minutes ?? 5;
    const isWorkday = scheduleRule?.is_workday ?? Boolean(schedule);

    const holidayRequest = supabase
      .from("holidays")
      .select("id")
      .eq("holiday_date", params.date)
      .limit(1)
      .maybeSingle();

    const scopedHolidayRequest = employee.branch_id
      ? holidayRequest.or(`branch_id.is.null,branch_id.eq.${employee.branch_id}`)
      : holidayRequest.is("branch_id", null);

    const [{ data: deviceEvents }, { data: manualAdjustments }, { data: holiday }, { data: leave }] =
      await Promise.all([
        supabase
          .from("attendance_events")
          .select("event_type, occurred_at, source, device_id")
          .eq("employee_id", employee.id)
          .gte("occurred_at", `${params.date}T00:00:00${GUATEMALA_OFFSET}`)
          .lt("occurred_at", `${dateEnd}T00:00:00${GUATEMALA_OFFSET}`)
          .order("occurred_at", { ascending: true }),
        supabase
          .from("manual_adjustments")
          .select("event_type, occurred_at")
          .eq("employee_id", employee.id)
          .eq("attendance_date", params.date)
          .eq("status", "approved")
          .order("occurred_at", { ascending: true }),
        scopedHolidayRequest,
        supabase
          .from("leave_requests")
          .select("id")
          .eq("employee_id", employee.id)
          .eq("status", "approved")
          .lte("start_date", params.date)
          .gte("end_date", params.date)
          .limit(1)
          .maybeSingle()
      ]);

    const events: EventRow[] = [
      ...((deviceEvents ?? []) as EventRow[]),
      ...((manualAdjustments ?? []).map((event) => ({ ...event, source: "manual" })) as EventRow[])
    ].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());

    const actualCheckIn = firstByType(events, "check_in") ?? firstByType(events, "unknown");
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

    const { error: upsertError } = await supabase.from("daily_attendance").upsert(
      {
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
      },
      { onConflict: "employee_id,attendance_date" }
    );

    if (upsertError) throw upsertError;
    processed.push(employee.id);
  }

  return { processed_count: processed.length, employee_ids: processed };
}
