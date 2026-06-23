# Hikvision Attendance Control

Sistema monorepo para control de asistencia con dispositivos Hikvision DS-K1T321MFWX y DS-K1T320MFWX.

Arquitectura principal:

```text
Hikvision device
  -> ISUP/EHome, ISAPI o adaptador mock
  -> Device Gateway Node.js
  -> Supabase Postgres / Edge Functions
  -> React Web App
```

## Regla critica de produccion

No crear datos demo en Supabase productivo. Solo crear estructura, roles base, RLS, buckets y configuracion minima. Los datos de prueba deben ir en scripts separados dentro de `/scripts/dev` y nunca ejecutarse automaticamente.

El repositorio incluye `scripts/dev/seed-demo.sql` y `scripts/dev/mock-events.ts` solo para ambiente local. Si `APP_ENV=production`, esos scripts se bloquean.

## Estructura

- `apps/web`: React + Vite + TypeScript + Material UI.
- `services/device-gateway`: gateway Node.js + TypeScript para eventos, comandos y sincronizacion historica.
- `supabase/migrations`: estructura SQL, RLS, roles base, buckets y funciones.
- `supabase/functions`: Edge Functions.
- `packages/shared`: tipos y validaciones compartidas.
- `docs`: arquitectura, despliegue Linux y configuracion de dispositivos.
- `scripts/dev`: datos y eventos de prueba solo para local.

## Inicio local

```bash
npm install
cp .env.example .env
npm run dev
```

Configura las variables de Supabase antes de ejecutar web, gateway o Edge Functions.

Para este despliegue: el frontend puede correr localmente en `apps/web`, la base y las Edge Functions viven en Supabase, y el Device Gateway debe levantarse en un VPS Linux con PM2. No es necesario correr el gateway en la maquina local si el VPS sera el listener real.

## Scripts principales

- `npm run dev`
- `npm run dev:web`
- `npm run dev:gateway`
- `npm run build`
- `npm run lint`
- `npm run typecheck`
- `npm run gateway:start`
- `npm run gateway:pm2`
- `npm run supabase:push`
- `npm run supabase:functions:deploy`

## Produccion

En produccion usa `APP_ENV=production`, HTTPS, `GATEWAY_API_SECRET` fuerte, service role solo en gateway/Edge Functions y anon key solo en frontend. El modo mock queda deshabilitado por defecto.
