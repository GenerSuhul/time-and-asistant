-- Reclassify previously ingested Hikvision events using observed attendanceStatus values.
update public.attendance_events ae
set event_type = case lower(coalesce(rae.raw_payload ->> 'attendanceStatus', rae.raw_payload ->> 'attendance_status'))
  when 'checkin' then 'check_in'::public.attendance_event_type
  when 'checkout' then 'check_out'::public.attendance_event_type
  when 'breakout' then 'break_out'::public.attendance_event_type
  when 'breakin' then 'break_in'::public.attendance_event_type
  else ae.event_type
end,
confidence = case
  when lower(coalesce(rae.raw_payload ->> 'attendanceStatus', rae.raw_payload ->> 'attendance_status')) in ('checkin','checkout','breakout','breakin') then 1
  else ae.confidence
end
from public.raw_access_events rae
where ae.raw_event_id = rae.id
  and lower(coalesce(rae.raw_payload ->> 'attendanceStatus', rae.raw_payload ->> 'attendance_status', '')) in ('checkin','checkout','breakout','breakin');
