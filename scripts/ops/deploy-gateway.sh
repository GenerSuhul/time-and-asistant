#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f "services/device-gateway/.env" ]; then
  echo "Missing services/device-gateway/.env"
  exit 1
fi

if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile
  pnpm --filter @attendance/shared run build
  pnpm --filter @attendance/device-gateway run build
else
  npm install
  npm run build --workspace packages/shared
  npm run build --workspace services/device-gateway
fi

mkdir -p /var/log/hikvision-gateway 2>/dev/null || sudo mkdir -p /var/log/hikvision-gateway
pm2 start services/device-gateway/ecosystem.config.cjs --update-env || pm2 restart hikvision-device-gateway --update-env
pm2 save

sleep 2
curl --fail --silent --show-error http://127.0.0.1:8799/health
echo
pm2 logs hikvision-device-gateway --lines 30 --nostream
