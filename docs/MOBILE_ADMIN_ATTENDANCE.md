# Marcación móvil administrativa

La ruta móvil es `/mobile-attendance`. Solo permite registrar una entrada o
salida para el usuario autenticado `it.agrisystem@gmail.com` que además tenga
el rol global `it_admin` y un perfil activo.

La Edge Function valida esas tres condiciones en el servidor. La tabla privada
`mobile_attendance_authorizations` enlaza ese correo exclusivamente con el
empleado de producción verificado; no recibe ni un empleado ni un dispositivo
desde el navegador.

Cada marcación crea, de forma atómica:

1. Un `raw_access_events` con el dispositivo virtual `mobile-admin-web`.
2. Un `attendance_events` con `source=manual` y `raw_event_type=mobile_web:*`.
3. Un registro privado en `mobile_attendance_marks` y una fila de auditoría.
4. El recálculo de `daily_attendance` de esa fecha.

## Límite de Hikvision

El DeviceGateway instalado permite consultar eventos físicos de control de
acceso, pero no tiene un endpoint para crear un evento biométrico/tarjeta desde
un teléfono. Por eso una marca móvil se declara como virtual y manual: nunca
se hace pasar por un evento físico de Hikvision ni abre una puerta.

## Publicación

Desde la raíz del repositorio, con una sesión de Supabase autorizada:

```bash
npx supabase login
npx supabase db push
npx supabase functions deploy mobile-attendance-mark
```

Desde `apps/web`, con una sesión de Vercel autorizada:

```bash
npx vercel login
npx vercel --prod
```

Después de publicar, añade la URL de Vercel a las URLs permitidas de Supabase
Auth. El enlace que se comparte con el administrador es:

```text
https://<tu-dominio-vercel>/mobile-attendance
```
