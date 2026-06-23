# Setup local

## Instalacion

```bash
npm install
cp .env.example .env
```

Configura:

- `APP_ENV=local`
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GATEWAY_API_SECRET`

## Supabase local o remoto

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
supabase functions deploy calculate-daily-attendance
supabase functions deploy recalculate-attendance-range
supabase functions deploy export-attendance-excel
supabase functions deploy create-device-command
supabase functions deploy ingest-device-event
```

Tambien puedes ejecutar:

```bash
npm run supabase:functions:deploy
```

## Primer administrador

```bash
FIRST_ADMIN_EMAIL=admin@example.com FIRST_ADMIN_PASSWORD='cambia-esto' node scripts/ops/create-first-admin.mjs
```

Si el usuario ya existe, el script solo asigna `super_admin`.

## Desarrollo

```bash
npm run dev:web
```

En el despliegue previsto, el gateway se levanta en el VPS, no en esta maquina local. Usa `npm run dev:gateway` solo para pruebas tecnicas locales del gateway.

## Prueba mock local

Opcionalmente carga datos demo locales:

```bash
psql "$DATABASE_URL" -f scripts/dev/seed-demo.sql
```

Luego envia un evento mock:

```bash
npx tsx scripts/dev/mock-events.ts
```

Los scripts en `scripts/dev` son solo para local y no se ejecutan automaticamente.
