# Prompt para Codex en el VPS

Copia este prompt y pegalo en el Codex que estara corriendo dentro del VPS Linux.

No pegues claves reales en el prompt. Las claves deben estar en `services/device-gateway/.env` o en variables de entorno del VPS.

---

Actua como DevOps senior y backend engineer. Estas ejecutandote dentro de un VPS Linux donde se va a desplegar el Device Gateway del sistema de asistencia Hikvision.

## Objetivo

Configurar y dejar operativo en produccion el servicio:

```text
services/device-gateway
```

Este gateway debe quedar listo para:

- Recibir eventos desde dispositivos Hikvision por ISUP/EHome cuando se integre el SDK oficial.
- Recibir eventos internos HTTP seguros.
- Procesar cola de comandos.
- Recuperar eventos historicos rezagados cuando el gateway reinicie o un dispositivo se reconecte.
- Conectarse a Supabase usando `service_role`.
- Ejecutarse con PM2.
- Reiniciarse automaticamente si falla.
- Tener logs persistentes.
- Tener Nginx como reverse proxy para endpoints HTTP.
- Mantener abierto el puerto ISUP/EHome `7660`.
- No usar datos mock/demo en produccion.

## Contexto de arquitectura

- Frontend: se desplegara despues en Vercel o Netlify.
- Base de datos: Supabase Postgres.
- Backend HTTP: Supabase Edge Functions.
- Gateway de dispositivos: este VPS.
- Dominio gateway: `gateway.kyrosoftgs.com`.
- Puerto HTTP interno del gateway: `8799`.
- Puerto ISUP/EHome: `7660`.

## Reglas estrictas

- No ejecutar `scripts/dev`.
- No ejecutar seeds demo.
- No insertar datos mock, demo, fake o de prueba.
- No imprimir secretos en consola.
- No escribir secretos en archivos versionados.
- No hacer commit de `.env`.
- No borrar migraciones ni codigo existente.
- No modificar la base productiva salvo que se pida explicitamente.
- Si falta una variable critica, detenerte y explicar que falta sin mostrar valores secretos.
- Si `APP_ENV=production`, bloquear endpoints mock.
- Si `APP_ENV=production`, bloquear scripts/dev.
- Si `APP_ENV=production`, bloquear cualquier seed demo.
- Si `APP_ENV=production`, no insertar datos falsos.
- El gateway debe rechazar el arranque en produccion si faltan `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GATEWAY_API_SECRET` o `APP_ENV=production`.
- El gateway no debe imprimir variables de entorno sensibles ni en consola ni en logs PM2.

## Antes de modificar

1. Confirmar que estas en la raiz del proyecto, por ejemplo:

```bash
pwd
ls
```

2. Revisar estructura:

```bash
ls services/device-gateway
cat package.json
cat services/device-gateway/package.json
cat .env.example
```

3. Leer docs existentes:

```bash
ls docs
cat docs/SERVER_LINUX.md
cat docs/ARCHITECTURE.md
```

Si `docs/SERVER_LINUX.md` o `docs/ARCHITECTURE.md` no existen, no fallar. Solo indicarlo y continuar creando `docs/GATEWAY_PRODUCTION_DEPLOY.md`.

## Archivo de entorno requerido

Debe existir:

```text
services/device-gateway/.env
```

Contenido esperado:

```bash
APP_ENV=production
SUPABASE_URL=https://oazdxvawzcasmhsoxvfh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<llenar-manualmente-service-role>
GATEWAY_API_SECRET=<clave-larga-segura>
PORT=8799
DEVICE_GATEWAY_PUBLIC_URL=https://gateway.kyrosoftgs.com
ISUP_LISTEN_PORT=7660
HIK_ISUP_SDK_PATH=/opt/hikvision-isup-sdk
LD_LIBRARY_PATH=/opt/hikvision-isup-sdk
```

Si el archivo no existe, crealo con placeholders seguros. Nunca inventes `SUPABASE_SERVICE_ROLE_KEY`.

Para generar `GATEWAY_API_SECRET` si falta:

```bash
openssl rand -hex 32
```

El mismo valor debe configurarse tambien en Supabase Edge Functions como secret:

```bash
npx supabase secrets set GATEWAY_API_SECRET=<mismo-valor-del-vps>
```

Si el CLI de Supabase no esta autenticado en el VPS, indicame que debo configurarlo desde el dashboard o con `SUPABASE_ACCESS_TOKEN`, pero no pidas pegar secretos en el chat.

## Configurar servidor Linux

Detectar sistema operativo:

```bash
cat /etc/os-release
```

Instalar dependencias si faltan:

```bash
sudo apt update
sudo apt install -y curl git unzip build-essential cmake g++ make python3 ufw fail2ban nginx certbot python3-certbot-nginx
```

Verificar Node.js:

```bash
node -v
npm -v
```

Si Node.js no existe o es menor a 20, instalar Node.js LTS moderno. Preferir Node.js 22 si esta disponible.

Instalar PM2 si falta:

```bash
sudo npm install -g pm2
pm2 -v
```

## Instalar y compilar proyecto

Instalar dependencias:

```bash
npm install
```

Si `npm install` falla por workspaces o lockfile, revisar si existe `pnpm-lock.yaml` y usar:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install --frozen-lockfile
```

Compilar:

```bash
npm run build --workspace packages/shared
npm run build --workspace services/device-gateway
```

Si esos comandos no coinciden con el package real, usa los scripts definidos en los `package.json`.

## PM2

Revisar `services/device-gateway/ecosystem.config.cjs`.

Debe quedar con:

- Nombre: `hikvision-device-gateway`.
- `cwd`: `services/device-gateway`.
- Script apuntando al build real del gateway.
- `APP_ENV=production`.
- `autorestart: true`.
- `max_restarts` razonable.
- `restart_delay`.
- Logs en `/var/log/hikvision-gateway`.
- Sin imprimir secretos.

Crear logs:

```bash
sudo mkdir -p /var/log/hikvision-gateway
sudo chown -R $USER:$USER /var/log/hikvision-gateway
```

Arrancar:

```bash
pm2 start services/device-gateway/ecosystem.config.cjs
pm2 save
pm2 startup
```

Si `pm2 startup` devuelve un comando con `sudo`, muestralo para ejecutarlo manualmente.

## SDK ISUP/EHome

Crear carpeta:

```bash
sudo mkdir -p /opt/hikvision-isup-sdk
sudo chown -R $USER:$USER /opt/hikvision-isup-sdk
```

No descargar SDK propietario. Si ya existen librerias `.so`, validar permisos:

```bash
ls -la /opt/hikvision-isup-sdk
```

No descargar SDK desde GitHub, ZIPs aleatorios ni fuentes no oficiales. Para produccion, el SDK debe obtenerse por canales oficiales.

El SDK correcto para tiendas sin IP publica no es solo el Device Network SDK normal. Ese SDK sirve mas para comunicacion directa con equipos accesibles por IP/ISAPI. Para este proyecto se debe pedir especificamente un SDK ISUP/EHome/HCISUP para Linux 64-bit, por ejemplo:

- `HCISUP SDK Linux 64-bit`.
- `ISUP 5.0 SDK Linux x86_64`.
- `EHome / ISUP SDK for Linux64`.
- `Access Control ISUP SDK`.

Fuentes recomendadas:

- Portal oficial de Hikvision / SDK Download.
- Hikvision TPP / Technology Partner Program.
- Distribuidor Hikvision autorizado.

Pedir literalmente: `HCISUP SDK Linux 64-bit para ISUP 5.0 Access Control compatible con DS-K1T321MFWX / DS-K1T320MFWX`.

Debe incluir librerias `.so`, headers `.h`, demos y manual PDF. El gateway debe compilar y funcionar en modo HTTP/base aunque el SDK ISUP todavia no este instalado.

El modo ISUP real queda marcado como pendiente hasta copiar las librerias oficiales `.so`, headers y documentacion del SDK en `/opt/hikvision-isup-sdk`.

## Nginx

Crear server block para `gateway.kyrosoftgs.com` que proxyee:

```text
https://gateway.kyrosoftgs.com/
-> http://127.0.0.1:8799/
```

Debe incluir headers:

- `Host`
- `X-Real-IP`
- `X-Forwarded-For`
- `X-Forwarded-Proto`

Probar:

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status nginx --no-pager
```

Configurar HTTPS con Certbot solo si el DNS del dominio resuelve hacia este VPS:

```bash
dig +short gateway.kyrosoftgs.com
curl -4 ifconfig.me
sudo certbot --nginx -d gateway.kyrosoftgs.com
```

Si no resuelve, dejar instrucciones exactas y no forzar Certbot.

No ejecutar Certbot si `gateway.kyrosoftgs.com` no apunta realmente a la IP publica del VPS.

No abrir publicamente el puerto `8799` si Nginx ya funciona. El puerto `8799` debe quedar escuchando solo localmente en `127.0.0.1` cuando sea posible.

## Firewall

Configurar UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7660/tcp
```

Antes de activar UFW, confirmar que `OpenSSH` queda permitido para no perder acceso remoto.

Produccion recomendada:

- `7660/tcp` abierto para ISUP/EHome.
- `80/443` abiertos para HTTPS.
- `8799/tcp` no expuesto publicamente si Nginx funciona.

No abrir `8799` publico salvo prueba temporal justificada.

Activar UFW:

```bash
sudo ufw enable
sudo ufw status verbose
```

## Healthcheck

Probar local:

```bash
curl http://127.0.0.1:8799/health
```

Probar por Nginx/HTTPS:

```bash
curl https://gateway.kyrosoftgs.com/health
```

Debe responder saludable.

## Validar codigo del gateway

Revisar que al iniciar:

- Registra worker de cola de comandos.
- Registra worker de recuperacion historica.
- Al boot revisa dispositivos activos y programa reconciliacion historica.
- Al reconectar dispositivo ejecuta `fetchHistoricalEvents`.
- Deduplica eventos por `event_hash` o `external_event_id`.
- Si llega evento tardio, recalcula `daily_attendance` de la fecha real del evento.
- Si falla una ingesta, guarda en `failed_event_ingestions` o cola equivalente.
- Usa backoff/retry.
- Bloquea endpoints mock con `APP_ENV=production`.

Si falta parte del codigo para esos workers, implementala.

## Scripts a crear o ajustar

Crear:

```text
scripts/ops/deploy-gateway.sh
scripts/ops/check-gateway.sh
```

`deploy-gateway.sh` debe:

- Iniciar con `set -euo pipefail`.
- Instalar dependencias si hace falta.
- Build de shared y gateway.
- Reiniciar PM2.
- Verificar healthcheck.
- Mostrar logs recientes.
- No contener secretos.

`check-gateway.sh` debe mostrar:

- Iniciar con `set -euo pipefail`.
- Estado PM2.
- Healthcheck local.
- Puertos escuchando.
- Ultimos logs.
- Estado Nginx.
- Estado UFW.

## Documentacion a crear

Crear:

```text
docs/GATEWAY_PRODUCTION_DEPLOY.md
```

Debe incluir:

- Requisitos del servidor.
- Variables de entorno.
- Instalacion.
- PM2.
- Nginx.
- Certbot.
- UFW.
- Logs.
- Comandos de reinicio.
- Healthcheck.
- Puerto ISUP `7660`.
- Donde colocar SDK ISUP/EHome.
- Como configurar `LD_LIBRARY_PATH`.
- Configuracion de dispositivos Hikvision:
  - Platform Access / ISUP.
  - Server Address: `gateway.kyrosoftgs.com`.
  - Port: `7660`.
  - Device ID unico, ejemplo `RNV-POPTUN1-AC01`.
  - ISUP Key fuerte.
  - NTP.
  - Zona horaria Guatemala UTC-6.
- Como verificar eventos.
- Como verificar recuperacion historica.
- Como revisar errores.

## Validaciones finales

Ejecutar lo que exista:

```bash
npm run typecheck
npm run build
npm run build --workspace services/device-gateway
curl http://127.0.0.1:8799/health
pm2 status
sudo systemctl status nginx --no-pager
sudo ufw status verbose
```

## Resumen final esperado

Al terminar, responde brevemente:

- Que se configuro.
- Que archivos se crearon o modificaron.
- Que variables faltan llenar.
- Que comandos debo ejecutar manualmente.
- Estado final del gateway.
- Como ver logs.
- Como reiniciar el servicio.
- Confirmacion explicita: no se ejecutaron datos mock/demo ni `scripts/dev`.

---

# Recordatorio para frontend en Vercel o Netlify

Cuando el gateway del VPS quede listo, el frontend puede desplegarse por separado.

## Variables frontend

Configurar en Vercel/Netlify:

```bash
VITE_SUPABASE_URL=https://oazdxvawzcasmhsoxvfh.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-o-publishable-key-de-Supabase>
```

Nunca configurar `SUPABASE_SERVICE_ROLE_KEY` en Vercel/Netlify.

## Vercel

- Root directory: raiz del repo.
- Install command: `pnpm install --frozen-lockfile`.
- Build command: `pnpm --filter @attendance/web run build`.
- Output directory: `apps/web/dist`.

## Netlify

- Base directory: raiz del repo.
- Build command: `pnpm --filter @attendance/web run build`.
- Publish directory: `apps/web/dist`.

## Despues del deploy frontend

En Supabase Auth, agregar la URL publica del frontend en:

- Site URL.
- Redirect URLs.

Ejemplos:

```text
https://tu-app.vercel.app
https://tu-app.netlify.app
```
