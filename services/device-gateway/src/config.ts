import "dotenv/config";
import { appEnvSchema } from "@attendance/shared";
import { z } from "zod";

// DeviceGateway UI credentials live outside the application .env so they can be
// rotated independently and are never copied into the repository or build.
try {
  process.loadEnvFile(process.env.DEVICE_GATEWAY_CREDENTIALS_FILE ?? "/home/gsuhul/secrets/devicegateway.env");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const envSchema = z.object({
  APP_ENV: appEnvSchema.default("local"),
  NODE_ENV: z.string().default("development"),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  GATEWAY_API_SECRET: z.string().min(16).optional(),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8799),
  ISUP_LISTEN_PORT: z.coerce.number().int().positive().default(7660),
  HIK_ISUP_SDK_PATH: z.string().optional(),
  HISTORY_SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  HISTORY_SYNC_LOOKBACK_HOURS: z.coerce.number().int().positive().default(72),
  DEVICE_GATEWAY_BASE_URL: z.string().url().default("http://127.0.0.1:18080"),
  DEVICE_GATEWAY_USERNAME: z.string().default("admin"),
  DEVICE_GATEWAY_PASSWORD: z.string().min(1).optional(),
  DEVICE_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(15000)
});

export const config = envSchema.parse(process.env);

if (config.APP_ENV === "production") {
  if (!config.GATEWAY_API_SECRET) {
    throw new Error("GATEWAY_API_SECRET is required when APP_ENV=production");
  }

}

export const isProduction = config.APP_ENV === "production";
