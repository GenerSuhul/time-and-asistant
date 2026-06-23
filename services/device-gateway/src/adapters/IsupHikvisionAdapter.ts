import type { DeviceAdapter, DeviceCommand, DeviceRecord, HistoryFetchOptions } from "./DeviceAdapter.js";
import type { GatewayEventPayload } from "@attendance/shared";
import { config } from "../config.js";
import { logger } from "../logger.js";

export class IsupHikvisionAdapter implements DeviceAdapter {
  constructor(private readonly device: DeviceRecord) {}

  async connect() {
    logger.info(
      {
        deviceId: this.device.id,
        sdkPathConfigured: Boolean(config.HIK_ISUP_SDK_PATH),
        listenPort: config.ISUP_LISTEN_PORT
      },
      "ISUP adapter ready for official Hikvision SDK integration"
    );
  }

  async disconnect() {
    logger.info({ deviceId: this.device.id }, "ISUP adapter disconnected");
  }

  async syncPerson(command: DeviceCommand) {
    this.sdkRequired(command, "syncPerson");
  }

  async deletePerson(command: DeviceCommand) {
    this.sdkRequired(command, "deletePerson");
  }

  async syncCard(command: DeviceCommand) {
    this.sdkRequired(command, "syncCard");
  }

  async syncFace(command: DeviceCommand) {
    this.sdkRequired(command, "syncFace");
  }

  async requestFaceEnrollment(command: DeviceCommand) {
    this.sdkRequired(command, "requestFaceEnrollment");
  }

  async uploadFaceTemplate(command: DeviceCommand) {
    this.sdkRequired(command, "uploadFaceTemplate");
  }

  async requestFingerprintEnrollment(command: DeviceCommand) {
    this.sdkRequired(command, "requestFingerprintEnrollment");
  }

  async uploadFingerprintTemplate(command: DeviceCommand) {
    this.sdkRequired(command, "uploadFingerprintTemplate");
  }

  async assignCard(command: DeviceCommand) {
    this.sdkRequired(command, "assignCard");
  }

  async assignPin(command: DeviceCommand) {
    this.sdkRequired(command, "assignPin");
  }

  async fetchHistoricalEvents(options: DeviceCommand | HistoryFetchOptions): Promise<GatewayEventPayload[]> {
    logger.info({ deviceId: this.device.id, options }, "ISUP historical fetch requires official SDK callback/query integration");
    return [];
  }

  async rebootDevice(command: DeviceCommand) {
    this.sdkRequired(command, "rebootDevice");
  }

  async syncTime(command: DeviceCommand) {
    this.sdkRequired(command, "syncTime");
  }

  private sdkRequired(command: DeviceCommand, operation: string): never {
    logger.warn({ commandId: command.id, deviceId: this.device.id, operation }, "ISUP operation needs official Hikvision SDK binding");
    throw new Error(`ISUP ${operation} requires official Hikvision SDK integration via node-ffi-napi, N-API addon, or sidecar process.`);
  }
}
