import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePayloads } from '../src/callback.js';
import { normalizeAccessEvent } from '../src/normalize-event.js';

test('normaliza un evento sin conservar datos biométricos', () => {
  const result = normalizeAccessEvent({ AccessControllerEvent: {
    deviceID: 'TEST-DEVICE', dateTime: '2026-01-01T08:00:00+01:00', major: 5, minor: 75,
    employeeNoString: 'TEST-ONLY', faceData: 'not-real-biometric'
  }});
  assert.equal(result.device_id, 'TEST-DEVICE');
  assert.equal(result.employee_no, 'TEST-ONLY');
  assert.equal(result.raw_event.faceData, undefined);
});

test('extrae la parte JSON de multipart sin procesar el binario', () => {
  const boundary = 'boundary-test';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="event"\r\nContent-Type: application/json\r\n\r\n{"eventType":"test"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="x.jpg"\r\nContent-Type: image/jpeg\r\n\r\nBINARY\r\n--${boundary}--\r\n`);
  assert.deepEqual(parsePayloads(body, `multipart/form-data; boundary=${boundary}`), [{ eventType: 'test' }]);
});

test('normaliza el evento anidado y el reloj físico como America/Guatemala', () => {
  const result = normalizeAccessEvent({ EventNotificationAlert: {
    deviceID: 'TEST-DEVICE', dateTime: '2026-07-20T17:08:44+02:00', eventType: 'AccessControllerEvent',
    AccessControllerEvent: {
      serialNo: 123, majorEventType: 5, subEventType: 1,
      employeeNo: 'TEST-ONLY', attendanceStatus: 'checkIn'
    }
  }});
  assert.equal(result.occurred_at, '2026-07-20T17:08:44-06:00');
  assert.equal(result.serial_no, 123);
  assert.equal(result.major, 5);
  assert.equal(result.minor, 1);
  assert.equal(result.employee_no, 'TEST-ONLY');
  assert.equal(result.attendance_status, 'checkIn');
});
