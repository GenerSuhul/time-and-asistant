# Gateway production deploy

Device Gateway runs on the VPS. Supabase hosts Postgres and Edge Functions. The frontend can be deployed separately to Vercel or Netlify.

## Required environment

Create `services/device-gateway/.env` on the VPS:

```bash
APP_ENV=production
SUPABASE_URL=https://oazdxvawzcasmhsoxvfh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
GATEWAY_API_SECRET=<openssl-rand-hex-32>
HOST=127.0.0.1
PORT=8799
DEVICE_GATEWAY_PUBLIC_URL=https://185.182.187.75
ISUP_LISTEN_PORT=7660
HIK_ISUP_SDK_PATH=/opt/hikvision-isup-sdk
LD_LIBRARY_PATH=/opt/hikvision-isup-sdk
```

Never put service role keys in frontend hosting.

## Install

```bash
sudo apt update
sudo apt install -y curl git unzip build-essential cmake g++ make python3 ufw fail2ban nginx certbot python3-certbot-nginx
sudo npm install -g pm2
```

Install dependencies and build:

```bash
./scripts/ops/deploy-gateway.sh
```

## PM2

```bash
pm2 status
pm2 logs hikvision-device-gateway
pm2 restart hikvision-device-gateway --update-env
pm2 save
pm2 startup
```

Logs are written to `/var/log/hikvision-gateway`.

## Nginx

Proxy public HTTPS to local gateway:

```nginx
server {
    listen 80;
    server_name 185.182.187.75;

    location / {
        proxy_pass http://127.0.0.1:8799;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Only run Certbot after DNS points to this VPS:

```bash
No se usa un dominio para este gateway; validar directamente la IP 185.182.187.75.
curl -4 ifconfig.me
No ejecutar Certbot por dominio. El TLS por IP requiere un certificado que incluya la IP como SAN.
```

## Firewall

Before enabling UFW, ensure SSH is allowed:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7660/tcp
sudo ufw enable
```

Port `8799` should stay local on `127.0.0.1` when Nginx is active.

## Hikvision SDK

Do not download SDKs from GitHub or unofficial ZIPs.

Create:

```bash
sudo mkdir -p /opt/hikvision-isup-sdk
```

Request the official SDK from Hikvision, Hikvision TPP, or an authorized distributor:

- HCISUP SDK Linux 64-bit
- ISUP 5.0 SDK Linux x86_64
- EHome / ISUP SDK for Linux64
- Access Control ISUP SDK

Ask for compatibility with DS-K1T321MFWX / DS-K1T320MFWX and Access Control ISUP 5.0. The gateway must compile and run HTTP/base mode even before the ISUP SDK is installed.

## Device setup

- Platform Access / ISUP: enabled.
- Server Address: `185.182.187.75`.
- Port: `7660`.
- Device ID example: `RNV-POPTUN1-AC01`.
- ISUP Key: strong unique key per device.
- Timezone: Guatemala UTC-6.
- NTP: enabled.

## Validation

```bash
./scripts/ops/check-gateway.sh
curl http://127.0.0.1:8799/health
curl https://185.182.187.75/health
```

Production rules:

- No demo seeds.
- No `scripts/dev`.
- Mock endpoints disabled.
- Missing critical secrets fail startup.
