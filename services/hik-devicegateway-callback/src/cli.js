import { config } from './config.js';
import { IsapiClient, extractDevices } from './isapi-client.js';
import { fetchAcsEventHistory } from './history-worker.js';

const settings = config();
const client = new IsapiClient({ baseUrl: settings.gatewayUrl, username: settings.username, password: settings.password });
const [command, argument] = process.argv.slice(2);

try {
  if (command === 'devices') {
    console.log(JSON.stringify(extractDevices(await client.listDevices()), null, 2));
  } else if (command === 'resolve-device') {
    const id = argument || settings.deviceId;
    const device = await client.findDeviceById(id);
    if (!device) throw new Error(`No se encontró el Device ID ${id}`);
    console.log(JSON.stringify({ deviceId: id, devIndex: device.devIndex, devName: device.devName, status: device.devStatus, protocol: device.protocolType }, null, 2));
  } else if (command === 'history') {
    let devIndex = settings.devIndex;
    if (!devIndex) devIndex = (await client.findDeviceById(settings.deviceId))?.devIndex;
    if (!devIndex) throw new Error(`No se pudo resolver devIndex para ${settings.deviceId}`);
    const events = await fetchAcsEventHistory(client, {
      devIndex, startTime: settings.historyStartTime, endTime: settings.historyEndTime, pageSize: settings.historyPageSize
    });
    const timestamps = events.map((event) => event.occurred_at).filter(Boolean).sort();
    const fields = [...new Set(events.flatMap((event) => Object.keys(event.raw_event || {})))].sort();
    const latestEvents = events
      .map((event) => ({ timestamp: event.occurred_at, major: event.major, minor: event.minor, eventType: event.event_type }))
      .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
      .slice(-10);
    console.log(JSON.stringify({
      count: events.length,
      firstTimestamp: timestamps[0] || null,
      lastTimestamp: timestamps.at(-1) || null,
      availableFields: fields,
      containsEmployeeData: events.some((event) => Boolean(event.employee_no)),
      containsCardData: events.some((event) => Boolean(event.card_no)),
      eventTypes: [...new Set(events.map((event) => event.event_type).filter(Boolean))],
      latestEvents
    }, null, 2));
  } else if (command === 'http-host') {
    let devIndex = settings.devIndex;
    if (!devIndex) devIndex = (await client.findDeviceById(settings.deviceId))?.devIndex;
    if (!devIndex) throw new Error(`No se pudo resolver devIndex para ${settings.deviceId}`);
    if (argument === 'get') {
      console.log(JSON.stringify(await client.getHttpHosts(devIndex), null, 2));
    } else if (argument === 'set') {
      const desired = { HttpHostNotification: {
        id: '1', protocolType: 'HTTP', addressingFormatType: 'ipaddress',
        ipAddress: '127.0.0.1', portNo: 7000,
        url: '/ISAPI/Event/notification/uploadEvent?format=json'
      }};
      const body = { HttpHostNotificationList: [desired] };
      console.log(JSON.stringify(await client.setHttpHosts(devIndex, body), null, 2));
    } else {
      throw new Error('Uso: node src/cli.js http-host get | set');
    }
  } else if (command === 'diagnose-forwarding') {
    let devIndex = settings.devIndex;
    if (!devIndex) devIndex = (await client.findDeviceById(settings.deviceId))?.devIndex;
    const endpoints = [
      ['gatewayHttpHosts', '/ISAPI/Event/notification/httpHosts?format=json', true],
      ['httpHosts', `/ISAPI/Event/notification/httpHosts?format=json&devIndex=${encodeURIComponent(devIndex || '')}`, true],
      ['isupListenCfg', '/ISAPI/ContentMgmt/DeviceMgmt/isupListenCfg?format=json', true],
      ['eventSubCfg', '/ISAPI/ContentMgmt/DeviceMgmt/eventSubCfg?format=json', true],
      ['alarmMonitor', '/ISAPI/System/AlarmMonitor?format=json', true],
      ['subscribeEvent', '/ISAPI/Event/notification/subscribeEvent?format=json', false],
      ['alertStream', '/ISAPI/Event/notification/alertStream', false]
    ];
    const results = {};
    for (const [name, path, includeBody] of endpoints) {
      try {
        const data = await client.request(path);
        results[name] = includeBody ? { ok: true, data: redact(data) } : { ok: true, responseType: typeof data };
      } catch (error) {
        results[name] = { ok: false, status: error.status || null, error: error.name, message: error.message };
      }
    }
    console.log(JSON.stringify(results, null, 2));
  } else if (command === 'enable-forwarding') {
    const alarmForwarding = await client.request('/ISAPI/ContentMgmt/DeviceMgmt/isupListenCfg?format=json', {
      method: 'PUT', body: { ISUPListenCfg: { enable: true } }
    });
    const eventSubscription = await client.request('/ISAPI/ContentMgmt/DeviceMgmt/eventSubCfg?format=json', {
      method: 'PUT', body: { EventSubscription: { enable: true } }
    });
    console.log(JSON.stringify({ alarmForwarding: redact(alarmForwarding), eventSubscription: redact(eventSubscription) }, null, 2));
  } else if (command === 'enable-gateway-callback') {
    const body = { HttpHostNotificationList: [{ HttpHostNotification: {
      enable: true,
      ipAddress: '127.0.0.1',
      portNo: 7000,
      url: '/ISAPI/Event/notification/uploadEvent?format=json'
    }}] };
    console.log(JSON.stringify(await client.request('/ISAPI/Event/notification/httpHosts?format=json', { method: 'PUT', body }), null, 2));
  } else {
    throw new Error('Uso: node src/cli.js devices | resolve-device [DEVICE_ID] | history | http-host get|set | diagnose-forwarding | enable-forwarding | enable-gateway-callback');
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.name || 'Error', message: error.message, status: error.status || null }));
  if (error.body) console.error(JSON.stringify(error.body));
  process.exitCode = 1;
}

function redact(value) {
  if (typeof value === 'string') return value.replace(/([?&]token=)[^&]*/ig, '$1<redacted>');
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [/password/i, /token/i, /authorization/i, /cookie/i].some((pattern) => pattern.test(key))
      ? [key, '<redacted>'] : [key, redact(child)]));
}
