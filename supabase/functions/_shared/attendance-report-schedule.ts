export const ATTENDANCE_REPORT_DELIVERY_WEEKDAYS = [1, 2, 3, 4, 5, 6] as const;

export function isAttendanceReportDeliveryWeekday(weekday: number) {
  return ATTENDANCE_REPORT_DELIVERY_WEEKDAYS.includes(weekday as 1 | 2 | 3 | 4 | 5 | 6);
}

export function attendanceReportDateForDelivery(localDate: string, deliveryWeekday: number) {
  const value = new Date(`${localDate}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (deliveryWeekday === 1 ? 2 : 1));
  return value.toISOString().slice(0, 10);
}

