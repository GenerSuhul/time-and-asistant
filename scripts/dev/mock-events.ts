import "dotenv/config";

const appEnv = process.env.APP_ENV ?? "local";
if (appEnv === "production") {
  throw new Error("mock-events.ts is blocked when APP_ENV=production");
}

const gatewayUrl = process.env.DEVICE_GATEWAY_PUBLIC_URL ?? "http://localhost:8799";
const gatewaySecret = process.env.GATEWAY_API_SECRET;

const payload = {
  device_identifier: process.env.MOCK_DEVICE_IDENTIFIER ?? "RNV-POPTUN1-AC01",
  external_event_id: `mock-${Date.now()}`,
  employee_external_id: process.env.MOCK_EMPLOYEE_EXTERNAL_ID ?? "E001",
  occurred_at: new Date().toISOString(),
  raw_event_type: process.env.MOCK_EVENT_TYPE ?? "check_in",
  auth_method: "fingerprint",
  access_result: "granted",
  payload: {
    source: "scripts/dev/mock-events.ts"
  }
};

const response = await fetch(`${gatewayUrl}/mock/device-event`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(gatewaySecret ? { "x-gateway-secret": gatewaySecret } : {})
  },
  body: JSON.stringify(payload)
});

const body = await response.text();
if (!response.ok) {
  throw new Error(`Gateway rejected mock event (${response.status}): ${body}`);
}

console.log(body);
