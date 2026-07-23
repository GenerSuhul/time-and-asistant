# Matriz de acceso IT y RRHH

Fecha: 2026-07-23

La plataforma expone dos roles asignables:

- `it_admin` / **IT**: acceso completo.
- `hr_admin` / **RRHH**: operación completa de personas, horarios,
  asignaciones, credenciales, asistencia y reportes.

Los registros de roles antiguos se conservan únicamente por historial. La
interfaz y `admin-users` no permiten volver a asignarlos.

| Módulo o capacidad | IT | RRHH |
|---|---:|---:|
| Dashboard operativo | Sí | Sí, sin paneles técnicos |
| Empresas, sucursales y departamentos | Sí | Sí |
| Horarios | Sí | Sí, lectura y edición |
| Personas | Sí | Sí, flujo completo |
| Asignar dispositivos a personas | Sí | Sí |
| Tarjetas, roles locales y huellas | Sí | Sí |
| Ver estado de dispositivos | Sí | Sí |
| Alta técnica/reprovisión de dispositivos | Sí | No |
| Reporte diario y por rango | Sí | Sí |
| Reportes automáticos | Sí | Sí |
| Usuarios y roles de plataforma | Sí | No |
| Comandos técnicos | Sí | No |
| Eventos en vivo | Sí | No |
| Auditoría general | Sí | No |
| Ajustes manuales | Sí | No |
| Perfil propio | Sí | Sí |

## Aplicación real de permisos

- Las rutas protegidas impiden abrir por URL un módulo no autorizado.
- El menú lateral muestra únicamente módulos permitidos.
- RLS reserva `device_commands`, `device_command_logs`, `attendance_events`,
  `audit_logs` y `manual_adjustments` para IT.
- RRHH consulta los fallos activos de credenciales mediante
  `admin-employees`, que devuelve únicamente comandos ligados a personas y
  datos técnicos sanitizados.
- Los reintentos y resoluciones solicitados desde Personas solo aceptan
  comandos de persona, tarjeta, rostro o huella; nunca comandos arbitrarios.
- RRHH puede consultar equipos, pero `admin-devices` sigue reservado para IT.
- Un usuario RRHH puede leer y actualizar su propio perfil y su propia
  asignación de rol, pero no listar ni modificar otras cuentas.
