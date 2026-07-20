import { normalizeAccessEvent } from './normalize-event.js';
import { config } from './config.js';

export async function handleUploadEvent(request, response, { onEvent = defaultSink } = {}) {
  try {
    const body = await readBody(request);
    console.log(JSON.stringify({ request_body_at: new Date().toISOString(), method: request.method, url: request.url, body_size: body.length }));
    const payloads = parsePayloads(body, request.headers['content-type'] || '');
    const events = payloads.map((payload) => normalizeAccessEvent(payload));
    for (const event of events) await onEvent(event);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ statusCode: 1, statusString: 'OK', received: events.length }));
  } catch (error) {
    console.error('Callback inválido:', error.message);
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ statusCode: 4, statusString: 'Invalid Request' }));
  }
}

async function readBody(request, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('El cuerpo supera 10 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parsePayloads(body, contentType) {
  if (/application\/json/i.test(contentType)) return [JSON.parse(body.toString('utf8'))];
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (/multipart\/form-data/i.test(contentType) && boundary) {
    const parts = body.toString('latin1').split(`--${boundary}`);
    const json = [];
    for (const part of parts) {
      const separator = part.indexOf('\r\n\r\n');
      if (separator < 0) continue;
      const headers = part.slice(0, separator);
      if (!/application\/json|name="?(?:event|json|EventNotificationAlert)/i.test(headers)) continue;
      const value = Buffer.from(part.slice(separator + 4).replace(/\r\n$/, ''), 'latin1').toString('utf8');
      try { json.push(JSON.parse(value)); } catch { /* Ignore non-JSON multipart fields. */ }
    }
    if (json.length) return json;
  }
  throw new Error(`Content-Type no soportado: ${contentType || '(vacío)'}`);
}

async function defaultSink(event) {
  const settings = config();
  if (!settings.mainGatewaySecret) throw new Error('MAIN_GATEWAY_API_SECRET no está configurado');
  const payload = {
    device_identifier: event.device_id || settings.deviceId,
    serial_number: event.device_id || settings.deviceId,
    external_event_id: event.serial_no ? String(event.serial_no) : stableExternalId(event),
    employee_external_id: event.employee_no ? String(event.employee_no) : undefined,
    occurred_at: event.occurred_at || event.received_at,
    raw_event_type: `hikvision:${event.major ?? 'unknown'}:${event.minor ?? 'unknown'}`,
    auth_method: authMethod(event.verify_mode),
    access_result: 'unknown',
    payload: {
      ...event.raw_event,
      major: event.major,
      minor: event.minor,
      attendanceStatus: event.attendance_status,
      currentVerifyMode: event.verify_mode,
      callback_received_at: event.received_at
    }
  };
  const forwardingStartedAt = new Date().toISOString();
  const response = await fetch(new URL('/gateway/ingest-event', settings.mainGatewayUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-secret': settings.mainGatewaySecret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(settings.mainGatewayTimeoutMs)
  });
  if (!response.ok) throw new Error(`Gateway principal rechazó evento con HTTP ${response.status}`);
  const result = await response.json().catch(() => ({}));
  const forwardedAt = new Date().toISOString();
  console.log(JSON.stringify({
    device_time: event.occurred_at,
    callback_received_at: event.received_at,
    forwarding_started_at: forwardingStartedAt,
    gateway_ingested_at: result.ingested_at ?? null,
    forwarded_at: forwardedAt,
    forward_latency_ms: new Date(forwardedAt).getTime() - new Date(event.received_at).getTime(),
    device_id: event.device_id,
    event_type: event.event_type,
    major: event.major,
    minor: event.minor,
    inserted: Boolean(result.inserted),
    duplicated: Boolean(result.duplicated),
    forwarded: true
  }));
}

function authMethod(value) {
  const text = String(value || '').toLowerCase();
  if (/finger/.test(text)) return 'fingerprint';
  if (/face/.test(text)) return 'face';
  if (/card/.test(text)) return 'card';
  if (/pin|password/.test(text)) return 'pin';
  return 'unknown';
}

function stableExternalId(event) {
  return [event.device_id, event.occurred_at, event.major, event.minor, event.employee_no || event.card_no || 'anonymous'].map(String).join(':');
}
