# Supervisor regional de tardanzas

El rol `regional_lateness_viewer` permite Dashboard regional, Histórico de
tardanzas (`/lateness-history`) y Mi perfil (`/settings`). El control de rutas y
menú comparte `canAccess`; las consultas están protegidas además por RLS. Los
roles adicionales IT/super_admin/RRHH conservan sus permisos existentes.

## Compatibilidad de regiones

`branches.region_id` ya referencia `attendance_report_regions`, catálogo global
utilizado por reportes automáticos. No se cambia esa columna, su FK, sus valores
ni la configuración de los reportes. La nueva tabla `regions` normaliza regiones
por empresa y enlaza el catálogo existente mediante `source_region_id`.

El alcance regional se resuelve con ambos criterios:

```
scope.company_id = branch.company_id = region.company_id
scope.region_id = region.id
region.source_region_id = branch.region_id
```

Un alcance directo usa `scope.branch_id = branch.id` y la misma empresa. Los
alcances y regiones deben estar activos, al igual que las sucursales. El usuario
debe tener el rol regional para la empresa del alcance. Un alcance inactivo o
un usuario sin el rol no concede acceso. No tener asignaciones produce cero
resultados, nunca acceso global.

`allowed_lateness_branch_ids` usa SECURITY DEFINER para evitar recursión en RLS;
valida `auth.uid()` y rechaza consultar otro usuario salvo administradores. Las
vistas y el agregado del dashboard usan SECURITY INVOKER. La vista mantiene
también RLS sobre empleados y departamentos; un traslado de empleado puede
ocultar filas históricas cuyo empleado ya no esté dentro del alcance actual.

## Administración

En Usuarios y roles, IT puede crear o editar supervisores regionales y seleccionar
empresa, regiones y sucursales específicas. El selector usa `regions`, no texto
libre. La función nueva `admin-lateness-users` verifica el token con Auth y el
rol del actor; acepta administradores IT/super_admin/RRHH. La política existente
de navegación de RRHH no se amplía para permitir administración general de
usuarios. Las políticas SQL permiten a los tres roles administrar alcances.

El endpoint dedicado solo edita cuentas exclusivamente regionales; no convierte
administradores ni elimina otros roles. La sustitución de alcances y del rol
regional se realiza en una transacción mediante `set_regional_lateness_scope`.
Los alcances anteriores se inactivan para conservar historial. Si crear una cuenta
falla, el endpoint elimina únicamente la cuenta recién creada por esa petición.
Una contraseña inicial regional requiere 12 caracteres.

## Verificación

```
npx deno test apps/web/tests/accessControl.test.ts
pnpm --filter @attendance/web typecheck
pnpm --filter @attendance/shared typecheck
npx deno check supabase/functions/*/index.ts
pnpm --filter @attendance/web build
```

`supabase/tests/regional_lateness_scope.sql` debe ejecutarse exclusivamente en
una base aislada cuyo nombre empiece por `lateness_validation_`, con el esquema
actual y la migración aplicada. Prueba acceso por región/sucursal, aislamiento
entre empresas, revocación, usuario sin asignaciones, perfil propio, vistas
invoker y rechazo de autoasignación y consultas de scopes ajenos. Sus fixtures
se revierten al terminar. No ejecutar fixtures en producción.

## Despliegue self-hosted del 14 de septiembre de 2026

La migración `20260914210928_regional_lateness_viewer_scope.sql` se aplicó solo
al contenedor `supabase-db`, base `postgres`, con `ON_ERROR_STOP`, transacción
única, `lock_timeout=3000` y `statement_timeout=30000`. Esta instalación no tiene
tabla `supabase_migrations.schema_migrations`; no se ejecutó `db push --linked`,
porque el vínculo local anterior apunta a Supabase Cloud.

Se guardó copia previa del esquema público/Auth dentro de `supabase-db`, en
`/tmp/before_regional_lateness_20260914.sql`. Solo se desplegó el nuevo directorio
`admin-lateness-users` al volumen de funciones; no se reinició el runtime ni se
copiaron otras funciones.

Al aplicar: 12 regiones normalizadas, 18 sucursales existentes, ninguna con
región asignada y cero alcances de supervisor. La puesta en servicio de una
cuenta real requiere nombre, correo, empresa y región/tiendas confirmadas por
el responsable. Una región sin tiendas vinculadas no permite ver datos.
