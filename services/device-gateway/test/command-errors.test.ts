import assert from "node:assert/strict";
import test from "node:test";
import {
  commandErrorCode, isDeterministicFingerprintFailure, sanitizeCommandError
} from "../src/services/command-errors.js";

test("classifies an offline device without exposing the vendor body", () => {
  const message = sanitizeCommandError(new Error(
    'HTTP 403 {"errorMsg":"The device is offline.","subStatusCode":"theDeviceIsOffline"}'
  ));
  assert.equal(commandErrorCode(message), "HIKVISION_DEVICE_OFFLINE");
  assert.equal(message.includes("errorMsg"), false);
});

test("classifies a fingerprint hardware failure with its operation", () => {
  const message = sanitizeCommandError(new Error(
    'CaptureFingerPrint HTTP 403 {"errorMsg":"Device hardware error.","subStatusCode":"deviceError"}'
  ));
  assert.equal(commandErrorCode(message), "HIKVISION_DEVICE_HARDWARE_ERROR");
  assert.match(message, /CaptureFingerPrint/);
});

test("redacts biometric template material", () => {
  const message = sanitizeCommandError(new Error('fingerData="raw-biometric-value"'));
  assert.equal(message.includes("raw-biometric-value"), false);
});

test("does not retry a deterministic partial replication", () => {
  assert.equal(isDeterministicFingerprintFailure("HIKVISION_FINGERPRINT_REPLICATION_PARTIAL"), true);
  assert.equal(isDeterministicFingerprintFailure("DEVICEGATEWAY_TIMEOUT"), false);
});
