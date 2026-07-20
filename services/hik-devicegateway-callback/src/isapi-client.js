import crypto from 'node:crypto';

export class IsapiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'IsapiError';
    this.status = status;
    this.body = body;
  }
}

export class IsapiClient {
  constructor({ baseUrl, username = '', password = '', fetchImpl = fetch, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.username = username;
    this.password = password;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body } = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload) headers['Content-Type'] = 'application/json';
    if (this.username) headers.Authorization = basic(this.username, this.password);

    let response = await this.fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    const challenge = response.headers.get('www-authenticate') || '';
    if (response.status === 401 && /^Digest /i.test(challenge) && this.username) {
      headers.Authorization = digestHeader({ challenge, method, url, username: this.username, password: this.password });
      response = await this.fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    }

    const text = await response.text();
    let data = text;
    if (text) {
      try { data = JSON.parse(text); } catch { /* Some ISAPI errors are XML/text. */ }
    }
    if (!response.ok) {
      throw new IsapiError(`ISAPI ${method} ${url.pathname} respondió HTTP ${response.status}`, { status: response.status, body: data });
    }
    return data;
  }

  listDevices({ position = 0, maxResult = 100 } = {}) {
    return this.request('/ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json', {
      method: 'POST',
      body: { SearchDescription: { position, maxResult, Filter: { key: '', protocolType: [], devStatus: [] } } }
    });
  }

  async findDeviceById(deviceId) {
    const response = await this.listDevices();
    const devices = extractDevices(response);
    return devices.find((device) => deviceIds(device).includes(String(deviceId))) || null;
  }

  searchAcsEvents(devIndex, condition) {
    const query = new URLSearchParams({ format: 'json', devIndex });
    return this.request(`/ISAPI/AccessControl/AcsEvent?${query}`, {
      method: 'POST', body: { AcsEventCond: condition }
    });
  }

  getHttpHosts(devIndex) {
    const query = new URLSearchParams({ format: 'json', devIndex });
    return this.request(`/ISAPI/Event/notification/httpHosts?${query}`);
  }

  setHttpHosts(devIndex, body) {
    const query = new URLSearchParams({ format: 'json', devIndex });
    return this.request(`/ISAPI/Event/notification/httpHosts?${query}`, { method: 'PUT', body });
  }
}

export function extractDevices(response) {
  const matches = response?.SearchResult?.MatchList || [];
  return matches.map((match) => match.Device || match).filter(Boolean);
}

function deviceIds(device) {
  return [device.deviceID, device.deviceId, device.devID, device.EhomeParams?.EhomeID]
    .filter((value) => value !== undefined && value !== null).map(String);
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function digestHeader({ challenge, method, url, username, password }) {
  const params = Object.fromEntries([...challenge.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)]
    .map((match) => [match[1], match[2] ?? match[3]]));
  const algorithm = (params.algorithm || 'MD5').toUpperCase();
  if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') throw new Error(`Digest algorithm no soportado: ${algorithm}`);
  const uri = `${url.pathname}${url.search}`;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const qop = (params.qop || '').split(',').map((v) => v.trim()).find((v) => v === 'auth');
  let ha1 = md5(`${username}:${params.realm}:${password}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${params.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${params.nonce}:${ha2}`);
  const fields = [
    `username="${username}"`, `realm="${params.realm}"`, `nonce="${params.nonce}"`,
    `uri="${uri}"`, `response="${response}"`, `algorithm=${params.algorithm || 'MD5'}`
  ];
  if (params.opaque) fields.push(`opaque="${params.opaque}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(', ')}`;
}

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');
