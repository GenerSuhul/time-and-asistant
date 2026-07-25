# Auditoría de reportes automáticos — 2026-07-25

## Alcance y seguridad

La auditoría se realizó antes de modificar esquema o datos. Se consultaron
metadatos y agregados de producción sin exponer direcciones de correo,
credenciales ni contenido de asistencia. No se enviaron correos, no se
crearon datos de prueba y no se alteraron registros productivos.

## Estado productivo encontrado

- Las migraciones `202606220001` a `202607250034` están aplicadas.
- La migración `202607250035_remove_legacy_platform_roles.sql` está en el
  repositorio pero aún no estaba aplicada al iniciar esta auditoría.
- Las cuatro funciones del flujo están activas:
  `generate-attendance-report`, `preview-attendance-report`,
  `schedule-daily-attendance-reports` y
  `send-attendance-report-emails`.
- Los secretos requeridos por el backend están configurados por nombre:
  URL/service role de Supabase, Resend y remitente de reportes.
- Existen 2 reglas activas, 1 contacto activo, 1 configuración activa,
  1 ejecución, 0 filas de outbox y 0 intentos de entrega.
- La configuración activa corresponde a una sola sucursal de Renova,
  tipo tienda, envío a las 06:00, HTML y Excel habilitados.
- El contacto activo es corporativo de Renova, rol `hr_assistant`, sin
  sucursal, departamento ni región, habilitado para tiendas y
  administración.
- Ninguna sucursal productiva tiene una región en columna o metadata.
  Tampoco existen valores de región en contactos o configuraciones.

## Modelo actual y limitaciones

### Contactos

`attendance_report_contacts.company_id` es obligatorio. La fila admite una
sola `branch_id`, un solo `department_id` y una `region` de texto libre. La
ausencia de sucursal se interpreta implícitamente como corporativo, pero no
existe un `scope_type` que permita distinguir global, empresa, región o una
selección de sucursales. La restricción única tampoco contempla región.

### Configuraciones

`attendance_report_configs.company_id` y `branch_id` son obligatorios. La
configuración solo puede generar una unidad por sucursal/departamento. La
unicidad por `branch_id + department_id` impide varios reportes con
variantes distintas y la ejecución es única por `config_id + report_date`.

### Regiones

`region` es texto libre en contactos y configuraciones. `branches` no tiene
región y no existe catálogo ni relación normalizada. No es posible resolver
de forma confiable todas las sucursales de una región.

### Destinatarios

El motor filtra por igualdad de sucursal, departamento y región. Para
tiendas usa `custom_to` o, como fallback, `branch_manager` como TO; RRHH se
agrega a CC. Esto explica el fallo productivo: el contacto corporativo
`hr_assistant` fue resuelto como CC, pero no había ningún TO.

La deduplicación de correos entre TO/CC sí existe en memoria, pero el modelo
no puede expresar cobertura global, regional o multi-sucursal.

### Preview y generación

El preview llama al mismo `generateAttendanceReport` con `dry_run`, por lo
que comparte cálculo, clasificación y destinatarios. Sin embargo:

- exige una sucursal;
- no devuelve el HTML generado;
- no permite seleccionar columnas;
- no crea outbox ni envía correo, lo cual es correcto.

### Scheduler, sync y entrega

El scheduler crea una ejecución por configuración/fecha, solicita sync por
sucursal y espera estados terminales. El flujo productivo auditado:

1. creó la ejecución;
2. sincronizó dos dispositivos;
3. terminó sync parcial porque un dispositivo estaba offline;
4. generó los datos disponibles;
5. bloqueó el correo por falta de TO;
6. registró el run como fallido y el error en schedule logs.

La cola de correo es reintentable y registra intentos en
`email_delivery_logs`. La acción actual de reintento desde UI usa `force`
y sí puede enviar por Resend; no debe utilizarse en pruebas sin destinatario
de test explícito.

## Diseño de compatibilidad

- Introducir `scope_type` explícito:
  `global`, `company`, `region`, `branches`, `branch`, `department`.
- Normalizar regiones en catálogo y asociarlas a sucursales.
- Usar tablas puente para sucursales de contactos y configuraciones.
- Mantener temporalmente `branch_id` y `region` como columnas legacy para
  consumidores anteriores.
- Backfill de contactos:
  departamento → `department`; sucursal → `branch`; región → `region`;
  de lo contrario → `company`.
- Backfill de configuraciones existentes como `branch`, `consolidated`,
  copiando `branch_id` a su tabla puente.
- Permitir `company_id` nulo únicamente para alcance `global`.
- Crear una salida por configuración/fecha/`output_key`, de modo que
  `separate_by_branch` sea idempotente sin duplicar consolidaciones.
- Guardar snapshot de scope, columnas y HTML en la ejecución/outbox.
- Resolver contactos solo si su alcance cubre completamente la salida,
  evitando que un contacto de una sucursal reciba un consolidado con datos
  de otras sucursales.
- Mantener el Excel completo por compatibilidad; la selección de columnas
  afecta el HTML y el preview, y esto debe mostrarse explícitamente en UI.

