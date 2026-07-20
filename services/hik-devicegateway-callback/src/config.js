export function config(env = process.env) {
  if (env === process.env && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return {
    callbackHost: env.CALLBACK_HOST || '127.0.0.1',
    callbackPort: number(env.CALLBACK_PORT, 7000),
    callbackPath: env.CALLBACK_PATH || '/ISAPI/Event/notification/uploadEvent',
    gatewayUrl: env.DEVICE_GATEWAY_BASE_URL || env.DEVICE_GATEWAY_URL || 'http://127.0.0.1:18080',
    username: env.DEVICE_GATEWAY_USERNAME || '',
    password: env.DEVICE_GATEWAY_PASSWORD || '',
    deviceId: env.DEVICE_ID || 'AD4776127',
    devIndex: env.DEV_INDEX || '',
    historyStartTime: env.HISTORY_START_TIME || '',
    historyEndTime: env.HISTORY_END_TIME || '',
    historyPageSize: number(env.HISTORY_PAGE_SIZE, 30),
    mainGatewayUrl: env.MAIN_GATEWAY_URL || 'http://127.0.0.1:8799',
    mainGatewaySecret: env.MAIN_GATEWAY_API_SECRET || '',
    mainGatewayTimeoutMs: number(env.MAIN_GATEWAY_TIMEOUT_MS, 10000)
  };
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
