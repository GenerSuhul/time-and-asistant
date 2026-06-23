import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "SUPABASE_SERVICE_ROLE_KEY",
      "GATEWAY_API_SECRET",
      "*.SUPABASE_SERVICE_ROLE_KEY",
      "*.GATEWAY_API_SECRET",
      "*.payload.biometric_template",
      "*.payload.pin",
      "*.payload.password"
    ],
    censor: "[redacted]"
  }
});
