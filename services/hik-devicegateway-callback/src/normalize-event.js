const OMIT_KEYS = /^(?:faceData|fingerPrintData|picture|image|picData|capturePicData)$/i;

export function normalizeAccessEvent(payload, context = {}) {
  const envelope = payload?.EventNotificationAlert || payload?.AcsEvent || payload;
  const event = envelope?.AccessControllerEvent || envelope;
  const timestamp = first(envelope, ['dateTime', 'time', 'eventTime', 'occurTime']) || first(event, ['dateTime', 'time', 'eventTime', 'occurTime']) || null;
  return {
    source: 'hik-devicegateway',
    device_id: first(envelope, ['deviceID', 'deviceId', 'deviceSerial']) || first(event, ['deviceID', 'deviceId']) || context.deviceId || null,
    dev_index: first(envelope, ['devIndex']) || first(event, ['devIndex']) || context.devIndex || null,
    occurred_at: guatemalaDeviceTime(timestamp),
    event_type: first(envelope, ['eventType', 'type']) || first(event, ['eventType', 'type']) || 'access_control',
    major: scalar(event?.major ?? event?.majorEventType),
    minor: scalar(event?.minor ?? event?.subEventType),
    serial_no: first(event, ['serialNo', 'eventSerialNo']) || null,
    employee_no: first(event, ['employeeNoString', 'employeeNo']) || null,
    card_no: first(event, ['cardNo']) || null,
    door_no: first(event, ['doorNo']) || null,
    attendance_status: first(event, ['attendanceStatus', 'label']) || null,
    verify_mode: first(event, ['currentVerifyMode', 'verifyMode']) || null,
    received_at: new Date().toISOString(),
    raw_event: sanitize(envelope)
  };
}

export function extractEventRecords(response) {
  const info = response?.AcsEvent || response?.AcsEventSearchResult || response;
  const records = info?.InfoList || info?.MatchList || info?.AcsEventInfo || [];
  const list = Array.isArray(records) ? records : [records];
  return list.map((item) => item?.AcsEventInfo || item).filter(Boolean);
}

function first(object, keys) {
  for (const key of keys) if (object?.[key] !== undefined && object[key] !== '') return scalar(object[key]);
}

function scalar(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && '#text' in value ? value['#text'] : value;
}

function guatemalaDeviceTime(value) {
  if (!value) return null;
  const text = String(value).trim().replace(' ', 'T');
  const wallClock = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  return wallClock ? `${wallClock[1]}-06:00` : text;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !OMIT_KEYS.test(key))
    .map(([key, child]) => [key, sanitize(child)]));
}
