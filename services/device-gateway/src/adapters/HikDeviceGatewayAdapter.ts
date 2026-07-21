import { randomUUID } from "node:crypto";
import type { GatewayEventPayload } from "@attendance/shared";
import { config } from "../config.js";
import type { DeviceAdapter, DeviceCommand, DeviceRecord, HistoryFetchOptions } from "./DeviceAdapter.js";
import { HikDeviceGatewayClient } from "./HikDeviceGatewayClient.js";

export class HikDeviceGatewayAdapter implements DeviceAdapter {
  private readonly client: HikDeviceGatewayClient;
  private devIndex = "";

  constructor(private readonly device: DeviceRecord) {
    if (!config.DEVICE_GATEWAY_PASSWORD) throw new Error("DEVICE_GATEWAY_PASSWORD is required for hik_devicegateway devices");
    this.client = new HikDeviceGatewayClient(config.DEVICE_GATEWAY_BASE_URL, config.DEVICE_GATEWAY_USERNAME, config.DEVICE_GATEWAY_PASSWORD, config.DEVICE_GATEWAY_TIMEOUT_MS);
  }

  async connect() {
    this.devIndex = this.device.dev_index || String(this.device.metadata?.dev_index ?? "");
    if (!this.devIndex) throw new Error("Device dev_index is required for DeviceGateway operations");
  }
  async disconnect() {}

  async syncPerson(command: DeviceCommand) {
    const employeeNo = required(command, "employee_no");
    const body = { UserInfo: { employeeNo, name: required(command, "name"), Valid: validity(command) } };
    const modify = command.command_type === "update_person";
    await this.call(modify ? "/ISAPI/AccessControl/UserInfo/Modify" : "/ISAPI/AccessControl/UserInfo/Record", modify ? "PUT" : "POST", modify ? body : { UserInfo: [body.UserInfo] });
  }

  async deletePerson(command: DeviceCommand) {
    await this.call("/ISAPI/AccessControl/UserInfoDetail/Delete", "PUT", { UserInfoDetail: { mode: "byEmployeeNo", EmployeeNoList: [{ employeeNo: required(command, "employee_no") }] } });
  }

  async syncCard(command: DeviceCommand) {
    await this.call("/ISAPI/AccessControl/CardInfo/Record", "POST", { CardInfo: { employeeNo: required(command, "employee_no"), cardNo: required(command, "card_no") } });
  }

  async searchPeople() {
    const people: Record<string, unknown>[] = [];
    const searchID = randomUUID();
    let position = 0;
    while (true) {
      const response = await this.call("/ISAPI/AccessControl/UserInfo/Search", "POST", {
        UserInfoSearchCond: { searchID, searchResultPosition: position, maxResults: 30 }
      }) as Record<string, any>;
      const root = response.UserInfoSearch ?? response.UserInfoSearchResult ?? response;
      const list = root.UserInfo ?? root.MatchList ?? [];
      const records = (Array.isArray(list) ? list : [list])
        .map((item) => item?.UserInfo ?? item).filter(Boolean);
      people.push(...records.map(sanitizePerson));
      position += records.length;
      const total = Number(root.totalMatches);
      if (!records.length || records.length < 30 || (Number.isFinite(total) && position >= total)) break;
    }
    return people;
  }

  async deleteCard(command: DeviceCommand) {
    await this.call("/ISAPI/AccessControl/CardInfo/Delete", "PUT", { CardInfoDelCond: { CardNoList: [{ cardNo: required(command, "card_no") }] } });
  }

  async syncFace(_command: DeviceCommand) { throw new Error("Face upload is disabled until private Storage, retention and encrypted transfer are approved"); }
  async requestFaceEnrollment(_command: DeviceCommand) { throw new Error("Face enrollment is disabled by biometric handling policy"); }
  async uploadFaceTemplate(_command: DeviceCommand) { throw new Error("Raw face templates are not accepted by this gateway"); }
  async deleteFace(command: DeviceCommand) {
    await this.call("/ISAPI/Intelligent/FDLib/FDSearch/Delete", "PUT", { FaceInfoDelCond: { EmployeeNoList: [{ employeeNo: required(command, "employee_no") }] } });
  }

  async requestFingerprintEnrollment(command: DeviceCommand) {
    const employeeNo = required(command, "employee_no");
    const fingerNo = Number(command.payload.finger_no ?? 1);
    if (!Number.isInteger(fingerNo) || fingerNo < 1 || fingerNo > 10) throw new Error("finger_no must be between 1 and 10");
    const captured = await this.call("/ISAPI/AccessControl/CaptureFingerPrint", "POST", {
      CaptureFingerPrintCond: { fingerNo }
    }) as Record<string, any>;
    const fingerData = findFingerData(captured);
    if (!fingerData) throw new Error("DeviceGateway did not return a fingerprint template");
    try {
      await this.call("/ISAPI/AccessControl/FingerPrintDownload", "POST", {
        FingerPrintCfg: { employeeNo, fingerPrintID: fingerNo, fingerData }
      });
    } finally {
      // The template is never persisted or logged and becomes unreachable here.
    }
  }
  async uploadFingerprintTemplate(_command: DeviceCommand) { throw new Error("Raw fingerprint templates are not accepted by this gateway"); }
  async deleteFingerprint(command: DeviceCommand) {
    const ids = Array.isArray(command.payload.fingerprint_ids) ? command.payload.fingerprint_ids : [1];
    await this.call("/ISAPI/AccessControl/FingerPrint/Delete", "PUT", { FingerPrintDelete: { EmployeeNoDetail: { employeeNo: required(command, "employee_no"), fingerPrintID: ids } } });
  }
  async assignCard(command: DeviceCommand) { await this.syncCard(command); }
  async assignPin(_command: DeviceCommand) { throw new Error("PIN synchronization is not exposed by the installed DeviceGateway API catalog"); }

  async fetchHistoricalEvents(commandOrOptions: DeviceCommand | HistoryFetchOptions): Promise<GatewayEventPayload[]> {
    const range = "payload" in commandOrOptions ? commandOrOptions.payload : commandOrOptions;
    const onPage = "payload" in commandOrOptions ? undefined : commandOrOptions.onPage;
    const from = new Date(String(range.from));
    const to = new Date(String(range.to));
    if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf())) throw new Error("A valid history range is required");
    const searchID = randomUUID();
    const events: GatewayEventPayload[] = [];
    let position = 0;
    let page = 0;
    while (true) {
      page += 1;
      if (page === 1) await onPage?.({
        phase: "request", at: new Date().toISOString(), page, position
      });
      const response = await this.call("/ISAPI/AccessControl/AcsEvent", "POST", {
        AcsEventCond: {
          searchID,
          searchResultPosition: position,
          maxResults: 30,
          major: 0,
          minor: 0,
          startTime: formatGatewayDate(from),
          endTime: formatGatewayDate(to)
        }
      }) as Record<string, any>;
      const root = response.AcsEvent ?? response.AcsEventSearchResult ?? response;
      const list = root.InfoList ?? root.MatchList ?? root.AcsEventInfo ?? [];
      const records = (Array.isArray(list) ? list : [list]).map((item) => item?.AcsEventInfo ?? item).filter(Boolean);
      for (const event of records) events.push(normalizeHistoryEvent(this.device, event));
      position += records.length;
      const isLast = !records.length || records.length < 30 ||
        (Number.isFinite(Number(root.totalMatches)) && position >= Number(root.totalMatches));
      if (page === 1 || isLast) await onPage?.({
        phase: "received", at: new Date().toISOString(), page, position,
        records: records.length, isLast
      });
      if (isLast) break;
      if (position > 1_000_000) throw new Error("DeviceGateway history pagination exceeded the safety limit");
    }
    return events;
  }

  async remoteDoor(command: DeviceCommand) {
    const doorId = encodeURIComponent(String(command.payload.door_id ?? 1));
    const action = String(command.payload.action ?? "open");
    if (!["open", "close", "alwaysOpen", "alwaysClose"].includes(action)) throw new Error("Unsupported door action");
    await this.call(`/ISAPI/AccessControl/RemoteControl/door/${doorId}`, "PUT", { RemoteControlDoor: { cmd: action } });
  }

  async syncPermissionSchedule(command: DeviceCommand) {
    const templateId = encodeURIComponent(required(command, "template_id"));
    const template = command.payload.template;
    if (!template || typeof template !== "object") throw new Error("Permission schedule template is required");
    await this.call(`/ISAPI/AccessControl/UserRightPlanTemplate/${templateId}`, "PUT", { UserRightPlanTemplate: template });
  }

  async rebootDevice(_command: DeviceCommand) { await this.call("/ISAPI/System/reboot", "PUT"); }
  async syncTime(command: DeviceCommand) {
    const localTime = required(command, "local_time");
    await this.call("/ISAPI/System/time", "PUT", { Time: { localTime, timeMode: String(command.payload.time_mode ?? "manual") } });
  }

  private call(path: string, method: string, body?: unknown) {
    return this.client.request(`${path}?format=json&devIndex=${encodeURIComponent(this.devIndex)}`, method, body);
  }
}

function formatGatewayDate(date: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guatemala", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-06:00`;
}

function sanitizePerson(person: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(person).filter(([key]) =>
    !/fingerData|faceData|photoData|pictureData|imageData|template/i.test(key)));
}

function findFingerData(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "fingerData" && typeof item === "string" && item.length > 0) return item;
    const nested = findFingerData(item);
    if (nested) return nested;
  }
  return null;
}

function required(command: DeviceCommand, key: string) {
  const value = command.payload[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}
function validity(command: DeviceCommand) {
  return { beginTime: String(command.payload.valid_from ?? "2020-01-01T00:00:00"), endTime: String(command.payload.valid_to ?? "2037-12-31T23:59:59") };
}
function normalizeHistoryEvent(device: DeviceRecord, event: Record<string, unknown>): GatewayEventPayload {
  const occurredAt = String(event.time ?? event.dateTime ?? event.occurred_at ?? "");
  const parsedTime = new Date(occurredAt);
  if (!occurredAt || !Number.isFinite(parsedTime.valueOf())) throw new Error("DeviceGateway returned a history event without a valid time");
  const externalId = event.serialNo ?? event.eventID ?? event.serialNumber;
  return {
    device_identifier: device.device_identifier ?? device.serial_number ?? undefined,
    serial_number: device.serial_number ?? undefined,
    external_event_id: externalId == null ? undefined : String(externalId),
    employee_external_id: event.employeeNoString == null ? undefined : String(event.employeeNoString),
    occurred_at: parsedTime.toISOString(), raw_event_type: `hikvision:${String(event.major ?? "unknown")}:${String(event.minor ?? "unknown")}`,
    auth_method: "unknown", access_result: "unknown",
    payload: Object.fromEntries(Object.entries(event).filter(([key]) => !/face|finger|picture|image|photo|template/i.test(key)))
  };
}
