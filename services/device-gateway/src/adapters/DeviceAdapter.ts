import type { GatewayEventPayload } from "@attendance/shared";

export type DeviceRecord = {
  id: string;
  branch_id?: string | null;
  protocol: "isup" | "isapi" | "hik_devicegateway" | "manual" | "mock";
  name: string;
  device_identifier?: string | null;
  serial_number?: string | null;
  dev_index?: string | null;
  metadata?: Record<string, unknown>;
};

export type DeviceCommand = {
  id: string;
  device_id?: string;
  employee_id?: string | null;
  requested_by?: string | null;
  command_type: string;
  payload: Record<string, unknown>;
};

export type HistoryFetchOptions = {
  from: Date;
  to: Date;
  traceId?: string;
  onPage?: (event: {
    phase: "request" | "received";
    at: string;
    page: number;
    position: number;
    records?: number;
    isLast?: boolean;
  }) => void | Promise<void>;
};

export type FingerprintEnrollmentResult = {
  credentialType: "fingerprint";
  fingerNo: number;
  fingerNos?: number[];
  verifiedFingerNos?: number[];
  verifiedCount: number;
  materialization: "captured" | "synced";
  sourceDeviceId?: string;
  operations: string[];
};

export type EmployeeCredentialSnapshot = {
  person: {
    employeeNo: string;
    name: string;
  } | null;
  cardNumbers: string[];
  fingerprintCount: number;
  faceCount: number;
};

export type FingerprintTemplate = {
  fingerData: string;
  fingerType: string;
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
  requestFingerprintEnrollment(command: DeviceCommand): Promise<void | FingerprintEnrollmentResult>;
  uploadFingerprintTemplate(command: DeviceCommand): Promise<void>;
  assignCard(command: DeviceCommand): Promise<void>;
  assignPin(command: DeviceCommand): Promise<void>;
  fetchHistoricalEvents(commandOrOptions: DeviceCommand | HistoryFetchOptions): Promise<GatewayEventPayload[]>;
  rebootDevice(command: DeviceCommand): Promise<void>;
  syncTime(command: DeviceCommand): Promise<void>;
  inspectEmployeeCredentials?(employeeNo: string): Promise<EmployeeCredentialSnapshot>;
  downloadFingerprintTemplate?(employeeNo: string, fingerNo: number): Promise<FingerprintTemplate>;
  addFingerprintTemplate?(employeeNo: string, fingerNo: number, template: FingerprintTemplate): Promise<number>;
}
