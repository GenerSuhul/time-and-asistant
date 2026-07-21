# Reportes automáticos diarios de asistencia

## Flujo operativo

1. El scheduler del Device Gateway invoca `schedule-daily-attendance-reports` cada minuto.
2. La función usa `America/Guatemala`, toma el día anterior y busca configuraciones activas cuya hora ya venció.
3. Por cada sucursal crea o reutiliza un `attendance_sync_jobs` de sistema con `force=true`.
4. El reporte no se genera hasta que el job de DeviceGateway termina (`complete`, `partial` o `failed`).
5. `generate-attendance-report` recalcula `daily_attendance`, aplica la regla configurable, resuelve destinatarios, genera HTML/Excel y crea `email_outbox`.
6. `send-attendance-report-emails` reclama filas de la cola de forma atómica, envía mediante Resend y registra cada intento.
7. Un fallo se reintenta a los 5, 15, 60 y 180 minutos. Después del máximo configurado queda visible como `failed`.

Las restricciones únicas de `attendance_report_runs` y `email_outbox` evitan duplicar un reporte o correo para la misma configuración y fecha.

## Configuración desde el frontend

Abrir **Reportes automáticos** en el menú lateral.

### Contactos

Crear contactos corporativos, por sucursal, región o departamento. Los roles disponibles son:

- Destinatario principal (`custom_to`).
- Copia personalizada (`custom_cc`).
- Gerente de tienda (`branch_manager`).
- Supervisor regional (`regional_supervisor`).
- Asistente RRHH (`hr_assistant`).
- Gerente RRHH (`hr_manager`).
- Gerente comercial (`commercial_manager`).
- Encargado de departamento (`department_head`).

Los contactos pueden limitarse a reportes de tienda, reportes administrativos o únicamente reportes con infracciones. No se envía nada si la resolución final no contiene destinatarios `TO`.

### Reglas

La migración crea dos reglas técnicas iniciales:

- `stores_default`: entrada 06:50, salida 17:00, pausa máxima 60 minutos.
- `administration_default`: entrada 07:00, salida 17:00, pausa máxima 90 minutos.

Estas reglas pueden editarse o complementarse desde la pestaña **Reglas**.

### Configuraciones

Crear una configuración por sucursal comercial o por departamento administrativo. Definir:

- sucursal, departamento, región y tipo de unidad;
- hora de envío en Guatemala;
- regla asignada;
- HTML y/o Excel;
- copias condicionales a gerente RRHH y gerente comercial.

Las configuraciones nuevas nacen inactivas. Se recomienda usar **Vista previa** y activar el envío únicamente después de verificar destinatarios y clasificación.

### Ejecuciones

La pestaña **Ejecuciones** muestra fecha, unidad, estado, conteos, errores y permite:

- reintentar o reenviar un correo ya generado;
- descargar el Excel privado mediante URL firmada;
- generar una vista previa sin crear outbox ni enviar correo.

## Endpoints

Todos requieren JWT de `super_admin`, `it_admin` o `hr_admin`; los procesos del VPS usan `service_role` exclusivamente en backend.

### Vista previa

`POST /functions/v1/preview-attendance-report`

```json
{
  "report_date": "2026-07-20",
  "branch_id": "uuid",
  "department_id": "uuid opcional"
}
```

### Generación manual

`POST /functions/v1/generate-attendance-report`

```json
{
  "report_date": "2026-07-20",
  "branch_id": "uuid",
  "department_id": "uuid opcional",
  "dry_run": false
}
```

La generación crea el outbox, pero la entrega la realiza la función de envío.

### Procesar cola o reenviar

`POST /functions/v1/send-attendance-report-emails`

```json
{ "limit": 10 }
```

Para reenvío explícito:

```json
{ "outbox_id": "uuid", "force": true }
```

### Scheduler manual

`POST /functions/v1/schedule-daily-attendance-reports` con cuerpo `{}`. Es idempotente.

## Variables y secretos

Edge Functions:

- `EMAIL_PROVIDER=RESEND`
- `RESEND_API_KEY`
- `ATTENDANCE_REPORT_FROM_EMAIL=reportes@renovagt.com`
- `ATTENDANCE_REPORT_FROM_NAME=Renova Guatemala`
- `REPORTS_TIMEZONE=America/Guatemala`
- `ATTENDANCE_REPORT_SEND_HOUR=06:00`

Device Gateway:

- `ATTENDANCE_REPORTS_ENABLED=true`
- `REPORTS_TIMEZONE=America/Guatemala`
- `ATTENDANCE_REPORT_SEND_HOUR=06:00`
- `ATTENDANCE_REPORT_SCHEDULER_INTERVAL_SECONDS=60`

La clave de Resend solo vive en los secretos de Supabase. No se guarda en Postgres, frontend, logs ni repositorio.

## Diseño pendiente

El HTML actual es deliberadamente básico y funcional. El rediseño futuro puede cambiar tipografía, cabecera, componentes y branding sin modificar reglas, destinatarios, scheduling, auditoría ni generación del Excel.
