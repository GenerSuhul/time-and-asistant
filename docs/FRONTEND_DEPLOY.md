# Despliegue frontend en Vercel o Netlify

El frontend es una app Vite en:

```text
apps/web
```

La base de datos y backend HTTP viven en Supabase. El Device Gateway vive en el VPS.

## Variables requeridas

Configurar en el panel de Vercel o Netlify:

```bash
VITE_SUPABASE_URL=https://oazdxvawzcasmhsoxvfh.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-o-publishable-key-de-Supabase>
```

No configurar `SUPABASE_SERVICE_ROLE_KEY` en frontend.

## Vercel

Configuracion recomendada:

- Framework preset: Vite.
- Root directory: raiz del repo.
- Install command: `pnpm install --frozen-lockfile`.
- Build command: `pnpm --filter @attendance/web run build`.
- Output directory: `apps/web/dist`.

## Netlify

Configuracion recomendada:

- Base directory: raiz del repo.
- Build command: `pnpm --filter @attendance/web run build`.
- Publish directory: `apps/web/dist`.

## Supabase Auth

Despues de desplegar, entrar a Supabase Dashboard y agregar la URL publica en:

- Authentication -> URL Configuration -> Site URL.
- Authentication -> URL Configuration -> Redirect URLs.

Ejemplos:

```text
https://tu-app.vercel.app
https://tu-app.netlify.app
```

## Produccion

- El frontend solo usa anon/publishable key.
- El gateway del VPS usa service role.
- Las Edge Functions protegidas requieren usuario autenticado y roles.
- `ingest-device-event` acepta solo `x-gateway-secret` desde el gateway.
- No ejecutar scripts demo contra produccion.
