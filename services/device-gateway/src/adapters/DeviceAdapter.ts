import type { GatewayEventPayload } from "@attendance/shared";

export type DeviceRecord = {
  id: string;
  protocol: "isup" | "isapi" | "hik_devicegateway" | "manual" | "mock";
  name: string;
  device_identifier?: string | null;
  serial_number?: string | null;
  dev_index?: string | null;
  metadata?: Record<string, unknown>;
};

export type DeviceCommand = {
  id: string;
  command_type: string;
  payload: Record<string, unknown>;
};

export type HistoryFetchOptions = {
  from: Date;
  to: Date;
};

export interface DeviceAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  syncPerson(command: DeviceCommand): Promise<void>;
  deletePerson(command: DeviceCommand): Promise<void>;
  syncCard(command: DeviceCommand): Promise<void>;
  syncFace(command: DeviceCommand): Promise<void>;
  requestFaceEnrollment(command: DeviceCommand): Promise<void>;
  uploadFaceTemplate(command: DeviceCommand): Promise<void>;
  requestFingerprintEnrollment(command: DeviceCommand): Promise<void>;
  uploadFingerprintTemplate(command: DeviceCommand): Promise<void>;
  assignCard(command: DeviceCommand): Promise<void>;
  assignPin(command: DeviceCommand): Promise<void>;
  fetchHistoricalEvents(commandOrOptions: DeviceCommand | HistoryFetchOptions): Promise<GatewayEventPayload[]>;
  rebootDevice(command: DeviceCommand): Promise<void>;
  syncTime(command: DeviceCommand): Promise<void>;
}
