#!/usr/bin/env bash
set -euo pipefail

echo "[PM2]"
pm2 status || true

echo
echo "[Healthcheck]"
curl --silent --show-error http://127.0.0.1:8799/health || true
echo

echo
echo "[Ports]"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep -E ':(8799|7660|80|443)\b' || true
else
  netstat -ltnp 2>/dev/null | grep -E ':(8799|7660|80|443)\b' || true
fi

echo
echo "[Nginx]"
sudo systemctl status nginx --no-pager || true

echo
echo "[UFW]"
sudo ufw status verbose || true

echo
echo "[Logs]"
pm2 logs hikvision-device-gateway --lines 50 --nostream || true
