import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { deviceStatusSchema } from "@attendance/shared";
import { config, isProduction } from "../config.js";
import { processGatewayEvent } from "../services/event-ingestion.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";
import { syncDeviceHistory } from "../workers/history-sync-worker.js";
import { HikDeviceGatewayClient } from "../adapters/HikDeviceGatewayClient.js";

async function assertGatewaySecret(req: FastifyRequest, reply: FastifyReply) {
  if (!config.GATEWAY_API_SECRET) return;
  if (req.headers["x-gateway-secret"] !== config.GATEWAY_API_SECRET) {
    return reply.code(401).send({ error: "Unauthorized gateway" });
  }
}

const deviceStatusPayload = z.object({
  device_identifier: z.string().optional(),
  serial_number: z.string().optional(),
  status: deviceStatusSchema,
  ip: z.string().optional(),
  message: z.string().optional(),
  metadata: z.record(z.unknown()).default({})
}).refine((value) => value.device_identifier || value.serial_number, {
  message: "device_identifier or serial_number is required"
});

const registerDevicePayload = z.object({
  device_id: z.string().trim().min(1).max(120),
  device_name: z.string().trim().min(1).max(120),
  key: z.string().min(1).max(256).optional()
}).strict();

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({
    ok: true,
    app_env: config.APP_ENV,
    isup_listen_port: config.ISUP_LISTEN_PORT,
    now: new Date().toISOString()
  }));

  app.post("/mock/device-event", async (req, reply) => {
    if (isProduction) {
      return reply.code(403).send({ error: "Mock endpoints are disabled in production" });
    }
    const result = await processGatewayEvent(req.body, { source: "realtime" });
    return reply.code(result.inserted ? 201 : 200).send(result);
  });

  app.post("/gateway/ingest-event", { preHandler: assertGatewaySecret }, async (req, reply) => {
    const result = await processGatewayEvent(req.body, { source: "realtime" });
    return reply.code(result.inserted ? 201 : 200).send(result);
  });

  app.post("/gateway/device-status", { preHandler: assertGatewaySecret }, async (req, reply) => {
    const payload = deviceStatusPayload.parse(req.body);
    const query = payload.device_identifier
      ? supabase.from("devices").select("*").eq("device_identifier", payload.device_identifier).maybeSingle()
      : supabase.from("devices").select("*").eq("serial_number", payload.serial_number).maybeSingle();

    const { data: device, error: findError } = await query;
    if (findError) throw findError;
    if (!device) return reply.code(404).send({ error: "Device not registered" });

    const wasOffline = device.status !== "online" && payload.status === "online";

    const { error } = await supabase
      .from("devices")
      .update({
        status: payload.status,
        status_reason: payload.status === "online" ? "heartbeat" : (payload.message ?? "gateway_reported"),
        last_seen_at: payload.status === "online" ? new Date().toISOString() : device.last_seen_at,
        last_ip: payload.ip ?? device.last_ip
      })
      .eq("id", device.id);
    if (error) throw error;

    if (device.status !== payload.status) {
      await supabase.from("device_status_logs").insert({
        device_id: device.id, status: payload.status, ip: payload.ip ?? null,
        message: payload.message ?? null, metadata: payload.metadata
      });
    }

    await supabase.from("device_sync_state").upsert(
      {
        device_id: device.id,
        last_seen_at: new Date().toISOString(),
        is_online: payload.status === "online",
        sync_status: "idle",
        sync_error: null
      },
      { onConflict: "device_id" }
    );

    if (wasOffline) {
      void syncDeviceHistory(device.id).catch((syncError) => {
        logger.error({ err: syncError, deviceId: device.id }, "Historical sync after reconnect failed");
      });
    }

    return { ok: true, device_id: device.id, history_sync_started: wasOffline };
  });

  app.post("/gateway/register-device", { preHandler: assertGatewaySecret }, async (req, reply) => {
    const payload = registerDevicePayload.parse(req.body);
    const keyBytes = payload.key ? Buffer.from(payload.key, "utf8") : undefined;
    // Do not retain the plaintext in Fastify's parsed body beyond this request.
    (req.body as Record<string, unknown>).key = "";

    try {
      if (!config.DEVICE_GATEWAY_PASSWORD) {
        return reply.code(503).send({ error: "DeviceGateway credentials are not configured" });
      }

      const client = new HikDeviceGatewayClient(
        config.DEVICE_GATEWAY_BASE_URL,
        config.DEVICE_GATEWAY_USERNAME,
        config.DEVICE_GATEWAY_PASSWORD,
        config.DEVICE_GATEWAY_TIMEOUT_MS
      );

      let device = await client.findAccessControlDevice(payload.device_id);
      const created = !device;
      if (!device) {
        if (!keyBytes) return reply.code(400).send({ error: "EHome key is required for a new DeviceGateway device" });
        await client.addAccessControlDevice({
          ehomeId: payload.device_id,
          ehomeKey: keyBytes.toString("utf8"),
          name: payload.device_name
        });
        device = await client.findAccessControlDevice(payload.device_id);
      }
      if (!device?.devIndex) throw new Error("DeviceGateway did not return a devIndex after registration");

      const online = device.devStatus === "online";
      const { data: stored, error: findError } = await supabase
        .from("devices")
        .select("id,status,last_seen_at")
        .eq("device_identifier", payload.device_id)
        .maybeSingle();
      if (findError) throw findError;
      if (!stored) return reply.code(404).send({ error: "Device is not registered in Supabase" });

      const now = new Date().toISOString();
      const { error: updateError } = await supabase.from("devices").update({
        dev_index: String(device.devIndex),
        protocol: "hik_devicegateway",
        connection_mode: "devicegateway",
        status: online ? "online" : "offline",
        status_reason: online ? "devicegateway_online" : String(device.offlineHint ?? "devicegateway_offline"),
        last_seen_at: online ? now : stored.last_seen_at
      }).eq("id", stored.id);
      if (updateError) throw updateError;

      if (stored.status !== (online ? "online" : "offline")) {
        await supabase.from("device_status_logs").insert({
          device_id: stored.id,
          status: online ? "online" : "offline",
          message: online ? "DeviceGateway reports online" : "DeviceGateway reports offline",
          metadata: { source: "devicegateway_registration" }
        });
      }

      return reply.code(created ? 201 : 200).send({
        ok: true,
        created,
        device_id: payload.device_id,
        dev_index: String(device.devIndex),
        status: online ? "online" : "offline",
        protocol_type: device.protocolType ?? "ehomeV5"
      });
    } finally {
      keyBytes?.fill(0);
    }
  });

  app.get("/gateway/devices", { preHandler: assertGatewaySecret }, async () => {
    const { data, error } = await supabase.from("devices").select("*").order("name");
    if (error) throw error;
    return { devices: data };
  });

  app.get("/gateway/commands/pending", { preHandler: assertGatewaySecret }, async () => {
    const { data, error } = await supabase
      .from("device_commands")
      .select("*")
      .eq("status", "pending")
      .lte("next_run_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(50);
    if (error) throw error;
    return { commands: data };
  });
}
