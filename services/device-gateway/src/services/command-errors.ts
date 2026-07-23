export function sanitizeCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/fingerData|finger_data|template|password|secret|service_role|api[_-]?key/i.test(message)) {
    return "Sensitive DeviceGateway operation failed; see sanitized server diagnostics";
  }
  if (/the device is offline|theDeviceIsOffline/i.test(message)) {
    return "HIKVISION_DEVICE_OFFLINE: DeviceGateway confirmó que el dispositivo está fuera de línea";
  }
  if (/device hardware error|subStatusCode["':=\s]+deviceError/i.test(message)) {
    const operation = message.includes("FingerPrintDownload") ? "FingerPrintDownload"
      : message.includes("CaptureFingerPrint") ? "CaptureFingerPrint" : "DeviceGateway";
    return `HIKVISION_DEVICE_HARDWARE_ERROR: ${operation} HTTP 403; el lector reportó deviceError`;
  }
  if (/employee_no is required/i.test(message)) {
    return "HIKVISION_EMPLOYEE_NO_REQUIRED: employee_no is required before DeviceGateway";
  }
  return message.replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted]").slice(0, 500);
}

export function commandErrorCode(message: string) {
  const code = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1];
  if (code) return code;
  if (message.includes("HTTP 403")) return "DEVICEGATEWAY_HTTP_403";
  if (/timeout/i.test(message)) return "DEVICEGATEWAY_TIMEOUT";
  return "DEVICE_COMMAND_FAILED";
}

export function isDeterministicFingerprintFailure(errorCode: string) {
  return [
    "HIKVISION_FINGERPRINT_REPLICATION_PARTIAL",
    "HIKVISION_FINGERPRINT_REPLICATION_UNSUPPORTED",
    "HIKVISION_FINGERPRINT_NOT_FOUND",
    "HIKVISION_FINGERPRINT_POST_VERIFY_UNSUPPORTED"
  ].includes(errorCode);
}
