import Fastify from "fastify";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { registerRoutes } from "./routes/http.js";
import { startCommandWorker } from "./workers/command-worker.js";
import { startEventQueueWorker } from "./workers/event-queue-worker.js";
import { startHistorySyncWorker } from "./workers/history-sync-worker.js";
import { supabase } from "./supabase.js";
import { startDeviceRegistrationWorker } from "./workers/device-registration-worker.js";

async function main() {
  const app = Fastify({ logger: false });
  await registerRoutes(app);

  app.setErrorHandler((error, _req, reply) => {
    logger.error({ err: error }, "HTTP request failed");
    reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  });

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ host: config.HOST, port: config.PORT, appEnv: config.APP_ENV }, "Device Gateway started");

  startEventQueueWorker();
  startCommandWorker();
  startHistorySyncWorker();
  startDeviceRegistrationWorker();
  const updateConnectivity = () => supabase.rpc("mark_stale_devices_offline").then(({ error }) => {
    if (error) logger.error({ err: error }, "Device connectivity sweep failed");
  });
  void updateConnectivity();
  setInterval(() => void updateConnectivity(), 30000);
}

main().catch((error) => {
  logger.fatal({ err: error }, "Device Gateway failed to start");
  process.exit(1);
});
