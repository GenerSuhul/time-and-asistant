# Arquitectura

El sistema esta disenado para asistencia laboral con dispositivos Hikvision DS-K1T321MFWX y DS-K1T320MFWX.

```text
Dispositivo Hikvision
  -> ISUP/EHome, ISAPI o manual/mock
  -> Device Gateway Linux Node.js
  -> Supabase Postgres / Edge Functions
  -> React Web App
```

## Por que existe Device Gateway

Supabase no debe recibir ISUP/EHome directamente. ISUP requiere un listener persistente y, para produccion real, integracion con SDK oficial de Hikvision. Edge Functions son HTTP efimero y sirven para calculos, exportes, acciones internas y endpoints seguros, no para mantener sesiones propietarias de dispositivos.

El Device Gateway recibe eventos, normaliza payloads, deduplica, inserta `raw_access_events`, genera `attendance_events`, invoca recalculo y procesa comandos pendientes.

## ISUP, ISAPI y mock

- `isup`: modo principal de produccion para tiendas sin IP publica. El dispositivo llama al servidor central.
- `isapi`: modo secundario si el equipo es accesible por LAN, VPN o IP publica.
- `manual`: carga o ajuste controlado desde sistema.
- `mock`: pruebas locales sin equipo real. No usar para datos reales.

## Recuperacion historica

El sistema no depende solo de eventos en vivo. Usa:

- `device_sync_state`
- `device_event_cursors`
- `device_history_sync_runs`
- `event_ingestion_queue`
- `failed_event_ingestions`

Al iniciar el gateway, al reconectar un dispositivo y periodicamente, se ejecuta reconciliacion historica. Si el dispositivo no soporta cursor exacto, se consulta una ventana de seguridad configurable y se deduplica por `event_hash` o `device_id + external_event_id`.

## Seguridad

- Frontend: solo `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
- Gateway y Edge Functions: service role.
- `GATEWAY_API_SECRET` obligatorio en produccion.
- RLS activo en tablas.
- `raw_access_events` es inmutable para usuarios normales.
- Huellas crudas y plantillas biometricas no se guardan en Supabase.
- Datos demo no se crean en produccion.

## Biometria

El sistema guarda estados: `face_status`, `fingerprint_status`, `fingerprint_count`, tarjeta y metadata minima. Subida de plantillas reales queda preparada en adapters, pero depende de SDK/ISAPI oficial y del firmware. Si se maneja payload sensible, debe ir cifrado y nunca visible en frontend.
