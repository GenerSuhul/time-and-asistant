import { createDecipheriv, createHash } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";
import { HikDeviceGatewayClient } from "../adapters/HikDeviceGatewayClient.js";

const intervalMs = 30_000;
let running = false;

export function startDeviceRegistrationWorker() {
  void processRegistrations();
  setInterval(() => void processRegistrations(), intervalMs);
}

async function processRegistrations() {
  if (running || !config.GATEWAY_API_SECRET) return;
  running = true;
  try {
    await refreshDeviceStatuses();
    await recoverInterruptedJobs();
    const { data, error } = await supabase
      .from("device_registration_requests")
      .select("id,device_id,encrypted_key,iv,attempts,status,devices:device_id(name,device_identifier)")
      .in("status", ["pending", "failed"])
      .lte("next_attempt_at", new Date().toISOString())
      .lt("attempts", 10)
      .order("created_at", { ascending: true })
      .limit(10);
    if (error) throw error;

    for (const request of data ?? []) {
      const relation = Array.isArray(request.devices) ? request.devices[0] : request.devices;
      if (!relation?.device_identifier || !relation?.name) continue;
      let plaintext: Buffer | undefined;
      try {
        if (!request.encrypted_key || !request.iv) throw new Error("Provisioning job has no encrypted key");
        const { error: claimError } = await supabase.from("device_registration_requests").update({
          status: "processing",
          attempts: Number(request.attempts ?? 0) + 1,
          updated_at: new Date().toISOString()
        }).eq("id", request.id).in("status", ["pending", "failed"]);
        if (claimError) throw claimError;
        plaintext = decrypt(request.encrypted_key, request.iv, config.GATEWAY_API_SECRET);
        const response = await fetch(`http://${config.HOST}:${config.PORT}/gateway/register-device`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gateway-secret": config.GATEWAY_API_SECRET },
          body: JSON.stringify({ device_id: relation.device_identifier, device_name: relation.name, key: plaintext.toString("utf8") }),
          signal: AbortSignal.timeout(config.DEVICE_GATEWAY_TIMEOUT_MS * 2)
        });
        if (!response.ok) throw new Error(`Internal device registration failed with HTTP ${response.status}`);
        const { error: successError } = await supabase.from("device_registration_requests").update({
          status: "success",
          encrypted_key: null,
          iv: null,
          last_error: null,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).eq("id", request.id);
        if (successError) throw successError;
        logger.info({ deviceId: request.device_id }, "DeviceGateway registration completed");
      } catch (error) {
        const message = sanitizeError(error);
        const attempts = Number(request.attempts ?? 0) + 1;
        const retrySeconds = Math.min(300, 15 * (2 ** Math.min(attempts - 1, 4)));
        await supabase.from("device_registration_requests").update({
          status: "failed",
          attempts,
          last_error: message,
          next_attempt_at: new Date(Date.now() + retrySeconds * 1000).toISOString(),
          updated_at: new Date().toISOString()
        }).eq("id", request.id);
        logger.error({ err: error, deviceId: request.device_id }, "DeviceGateway registration failed");
      } finally {
        plaintext?.fill(0);
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Device registration queue failed");
  } finally {
    running = false;
  }
}

async function recoverInterruptedJobs() {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { error } = await supabase.from("device_registration_requests").update({
    status: "failed",
    last_error: "Provisioning worker was interrupted",
    next_attempt_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("status", "processing").lt("updated_at", staleBefore);
  if (error) throw error;
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Device registration failed";
  return message
    .replace(/(key|password|secret|token)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

async function refreshDeviceStatuses() {
  if (!config.DEVICE_GATEWAY_PASSWORD) return;
  const client = new HikDeviceGatewayClient(
    config.DEVICE_GATEWAY_BASE_URL,
    config.DEVICE_GATEWAY_USERNAME,
    config.DEVICE_GATEWAY_PASSWORD,
    config.DEVICE_GATEWAY_TIMEOUT_MS
  );
  const response = await client.listAccessControlDevices() as Record<string, any>;
  const gatewayDevices = (response?.SearchResult?.MatchList ?? []).map((match: any) => match?.Device ?? match);
  if (!gatewayDevices.length) return;

  const identifiers = gatewayDevices
    .map((device: any) => String(device?.EhomeParams?.EhomeID ?? device?.deviceID ?? device?.deviceId ?? ""))
    .filter(Boolean);
  const { data: storedDevices, error } = await supabase
    .from("devices")
    .select("id,device_identifier,status,last_seen_at")
    .in("device_identifier", identifiers);
  if (error) throw error;

  const storedByIdentifier = new Map((storedDevices ?? []).map((device) => [device.device_identifier, device]));
  const now = new Date().toISOString();
  for (const gatewayDevice of gatewayDevices) {
    const identifier = String(gatewayDevice?.EhomeParams?.EhomeID ?? gatewayDevice?.deviceID ?? gatewayDevice?.deviceId ?? "");
    const stored = storedByIdentifier.get(identifier);
    if (!stored || !gatewayDevice.devIndex) continue;
    const online = gatewayDevice.devStatus === "online";
    const status = online ? "online" : "offline";
    const { error: updateError } = await supabase.from("devices").update({
      dev_index: String(gatewayDevice.devIndex),
      protocol: "hik_devicegateway",
      connection_mode: "devicegateway",
      status,
      status_reason: online ? "devicegateway_online" : String(gatewayDevice.offlineHint ?? "devicegateway_offline"),
      last_seen_at: online ? now : stored.last_seen_at
    }).eq("id", stored.id);
    if (updateError) throw updateError;
    if (stored.status !== status) {
      await supabase.from("device_status_logs").insert({
        device_id: stored.id,
        status,
        message: online ? "DeviceGateway reports online" : "DeviceGateway reports offline",
        metadata: { source: "devicegateway_poll" }
      });
    }
  }
}

function decrypt(ciphertextBase64: string, ivBase64: string, secret: string) {
  const encrypted = Buffer.from(ciphertextBase64, "base64");
  if (encrypted.length < 17) throw new Error("Invalid encrypted registration key");
  const authTag = encrypted.subarray(encrypted.length - 16);
  const ciphertext = encrypted.subarray(0, encrypted.length - 16);
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
