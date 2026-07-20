# Servidor Linux

## Base recomendada

- Ubuntu Server LTS.
- Node.js LTS.
- PM2.
- Nginx como reverse proxy.
- Certbot para HTTPS.
- UFW y Fail2ban.

## Paquetes

```bash
sudo apt update
sudo apt install -y nginx ufw fail2ban
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## Puertos

- `8799`: HTTP interno del gateway, limitado a `127.0.0.1`.
- `7660`: listener ISUP/EHome configurable.
- `80/443`: Nginx y certificados.

## Variables

Configura en el entorno del servicio:

```bash
APP_ENV=production
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GATEWAY_API_SECRET=
PORT=8799
ISUP_LISTEN_PORT=7660
HIK_ISUP_SDK_PATH=/opt/hikvision-isup-sdk
LD_LIBRARY_PATH=/opt/hikvision-isup-sdk
```

El valor de `GATEWAY_API_SECRET` debe ser identico al configurado en Supabase:

```bash
npx supabase secrets set GATEWAY_API_SECRET=<mismo-secreto-del-vps>
```

No uses el access token de Supabase, la database password ni ninguna clave de usuario como `GATEWAY_API_SECRET`. Genera un secreto independiente.

## Despliegue gateway

```bash
npm install
npm run build --workspace packages/shared
npm run build --workspace services/device-gateway
npm run gateway:pm2
pm2 save
pm2 startup
```

## Logs

```bash
pm2 logs attendance-device-gateway
pm2 status
```

## Red

No publiques ni proxies el puerto `8799`. Las Edge Functions encolan comandos
en Supabase y el worker privado del VPS los consume. DeviceGateway de Hikvision
usa `127.0.0.1:18080` desde el VPS y `185.182.187.75:18080` solo para acceso
externo a su UI/API vendor.

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 7660/tcp
sudo ufw enable
```
