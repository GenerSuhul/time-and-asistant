import type { DeviceAdapter, DeviceCommand, DeviceRecord, HistoryFetchOptions } from "./DeviceAdapter.js";
import type { GatewayEventPayload } from "@attendance/shared";
import { logger } from "../logger.js";

export class IsapiHikvisionAdapter implements DeviceAdapter {
  constructor(private readonly device: DeviceRecord) {}

  async connect() {
    logger.info({ deviceId: this.device.id }, "ISAPI adapter ready. Device must be reachable by LAN, VPN or public IP.");
  }

  async disconnect() {
    logger.info({ deviceId: this.device.id }, "ISAPI adapter disconnected");
  }

  async syncPerson(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI syncPerson placeholder");
  }

  async deletePerson(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI deletePerson placeholder");
  }

  async syncCard(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI syncCard placeholder");
  }

  async syncFace(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI syncFace placeholder");
  }

  async requestFaceEnrollment(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI requestFaceEnrollment placeholder");
  }

  async uploadFaceTemplate(command: DeviceCommand) {
    throw new Error("ISAPI face template upload must be implemented from official Hikvision firmware documentation.");
  }

  async requestFingerprintEnrollment(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI requestFingerprintEnrollment placeholder");
  }

  async uploadFingerprintTemplate(command: DeviceCommand) {
    throw new Error("ISAPI fingerprint template upload must be implemented from official Hikvision firmware documentation.");
  }

  async assignCard(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI assignCard placeholder");
  }

  async assignPin(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI assignPin placeholder without logging PIN");
  }

  async fetchHistoricalEvents(options: DeviceCommand | HistoryFetchOptions): Promise<GatewayEventPayload[]> {
    logger.info({ deviceId: this.device.id, options }, "ISAPI historical fetch placeholder");
    return [];
  }

  async rebootDevice(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI reboot placeholder");
  }

  async syncTime(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "ISAPI syncTime placeholder");
  }
}
