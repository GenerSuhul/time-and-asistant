import type { DeviceAdapter, DeviceCommand, DeviceRecord, HistoryFetchOptions } from "./DeviceAdapter.js";
import type { GatewayEventPayload } from "@attendance/shared";
import { logger } from "../logger.js";

export class MockHikvisionAdapter implements DeviceAdapter {
  constructor(private readonly device: DeviceRecord) {}

  async connect() {
    logger.info({ deviceId: this.device.id }, "Mock adapter connected");
  }

  async disconnect() {
    logger.info({ deviceId: this.device.id }, "Mock adapter disconnected");
  }

  async syncPerson(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock sync person");
  }

  async deletePerson(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock delete person");
  }

  async syncCard(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock sync card");
  }

  async syncFace(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock sync face");
  }

  async requestFaceEnrollment(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock request face enrollment");
  }

  async uploadFaceTemplate(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock upload face template metadata only");
  }

  async requestFingerprintEnrollment(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock request fingerprint enrollment");
  }

  async uploadFingerprintTemplate(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock upload fingerprint template metadata only");
  }

  async assignCard(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock assign card");
  }

  async assignPin(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock assign PIN without logging sensitive value");
  }

  async fetchHistoricalEvents(commandOrOptions: DeviceCommand | HistoryFetchOptions): Promise<GatewayEventPayload[]> {
    logger.info({ deviceId: this.device.id, commandOrOptions }, "Mock historical fetch returned no automatic demo events");
    return [];
  }

  async rebootDevice(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock reboot");
  }

  async syncTime(command: DeviceCommand) {
    logger.info({ commandId: command.id, deviceId: this.device.id }, "Mock sync time");
  }
}
