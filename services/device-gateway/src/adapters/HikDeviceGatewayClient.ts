import { createHash, randomBytes } from "node:crypto";

export class HikDeviceGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly timeoutMs: number
  ) {}

  async request(path: string, method = "GET", body?: unknown) {
    const url = new URL(path, `${this.baseUrl.replace(/\/$/, "")}/`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload) headers["Content-Type"] = "application/json";
    headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;

    let response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (response.status === 401 && /^Digest /i.test(challenge)) {
      headers.Authorization = digestHeader(challenge, method, url, this.username, this.password);
      response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
    }

    const text = await response.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* DeviceGateway can return XML errors. */ }
    if (!response.ok) throw new Error(`DeviceGateway ${method} ${url.pathname} failed with HTTP ${response.status}`);
    return data;
  }

  async listAccessControlDevices() {
    return this.request("/ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json", "POST", {
      SearchDescription: {
        position: 0,
        maxResult: 100,
        Filter: {
          key: "",
          devType: "AccessControl",
          protocolType: ["ehomeV5"],
          devStatus: ["online", "offline"]
        }
      }
    });
  }

  async findAccessControlDevice(ehomeId: string) {
    const response = await this.listAccessControlDevices() as Record<string, any>;
    const matches = response?.SearchResult?.MatchList ?? [];
    return matches
      .map((match: any) => match?.Device ?? match)
      .find((device: any) => String(device?.EhomeParams?.EhomeID ?? device?.deviceID ?? device?.deviceId ?? "") === ehomeId) ?? null;
  }

  async addAccessControlDevice(device: { ehomeId: string; ehomeKey: string; name: string }) {
    return this.request("/ISAPI/ContentMgmt/DeviceMgmt/addDevice?format=json", "POST", {
      DeviceInList: [{
        Device: {
          protocolType: "ehomeV5",
          EhomeParams: { EhomeID: device.ehomeId, EhomeKey: device.ehomeKey },
          devName: device.name,
          devType: "AccessControl"
        }
      }]
    });
  }
}

function digestHeader(challenge: string, method: string, url: URL, username: string, password: string) {
  const params = Object.fromEntries([...challenge.replace(/^Digest\s+/i, "").matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)]
    .map((match) => [match[1], match[2] ?? match[3]]));
  const algorithm = (params.algorithm || "MD5").toUpperCase();
  if (!["MD5", "MD5-SESS"].includes(algorithm)) throw new Error("Unsupported DeviceGateway digest algorithm");
  const uri = `${url.pathname}${url.search}`;
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const qop = (params.qop || "").split(",").map((value) => value.trim()).find((value) => value === "auth");
  let ha1 = md5(`${username}:${params.realm}:${password}`);
  if (algorithm === "MD5-SESS") ha1 = md5(`${ha1}:${params.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${params.nonce}:${ha2}`);
  const fields = [`username="${username}"`, `realm="${params.realm}"`, `nonce="${params.nonce}"`, `uri="${uri}"`, `response="${response}"`, `algorithm=${params.algorithm || "MD5"}`];
  if (params.opaque) fields.push(`opaque="${params.opaque}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(", ")}`;
}

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
