# Hik DeviceGateway → Node.js

Integración local para recibir notificaciones de control de acceso y consultar el histórico ISAPI. Reenvía eventos normalizados al gateway privado en `127.0.0.1:8799`; no expone servicios, no escribe con credenciales de frontend y no almacena imágenes ni biometría.

## Requisitos y arranque

- Node.js 20 o superior.
- DeviceGateway disponible en `http://127.0.0.1:18080`.
- Credenciales de administración de DeviceGateway (Basic o Digest).

```bash
cd /home/gsuhul/hik-devicegateway-integration
cp .env.example .env
# El proyecto carga .env automáticamente con Node.js 20.
export DEVICE_GATEWAY_USERNAME='admin'
export DEVICE_GATEWAY_PASSWORD='...'
npm start
```

El proceso escucha exclusivamente en `127.0.0.1:7000`. Comprobación local:

```bash
curl http://127.0.0.1:7000/health
```

## Configurar HTTP Host en DeviceGateway

En la interfaz de DeviceGateway, abra el dispositivo `AC_RENOVA` (`AD4776127`), localice la configuración de **HTTP Host / Event notification HTTP hosts** y cree o edite el host con:

| Campo | Valor |
|---|---|
| Protocol | HTTP |
| Host / IP | `127.0.0.1` |
| Port | `7000` |
| Path / URL | `/ISAPI/Event/notification/uploadEvent?format=json` |

Use `127.0.0.1` solamente si el callback corre en el mismo sistema o namespace de red que DeviceGateway. Si DeviceGateway está dentro de un contenedor, su `127.0.0.1` apunta al propio contenedor y esta dirección no alcanzará un proceso en el host.

El equivalente ISAPI (solo como referencia; este proyecto no lo ejecuta automáticamente) es:

```http
PUT /ISAPI/Event/notification/httpHosts?format=json&devIndex=<devIndex>
Content-Type: application/json

{"HttpHostNotificationList":[{"HttpHostNotification":{"id":"1","protocolType":"HTTP","addressingFormatType":"ipaddress","ipAddress":"127.0.0.1","portNo":7000,"url":"/ISAPI/Event/notification/uploadEvent?format=json"}}]}
```

## Obtener el devIndex real

`Device ID` y `devIndex` no son intercambiables. El cliente consulta:

```http
POST /ISAPI/ContentMgmt/DeviceMgmt/deviceList?format=json
```

Para resolver el índice de `AD4776127`:

```bash
npm run resolve-device -- AD4776127
```

También puede listar la respuesta completa con `npm run devices`. La búsqueda coteja el ID con `EhomeParams.EhomeID` y variantes del campo `deviceID`, y devuelve el `devIndex` asignado por DeviceGateway.

## Probar una marcación real

1. Arranque el callback y confirme `/health`.
2. Configure y habilite el HTTP Host anterior para `AC_RENOVA`.
3. Realice una única marcación autorizada en el terminal, usando una credencial de prueba consentida y no biométrica (por ejemplo, tarjeta/PIN de prueba). No cree empleados demo ni use datos biométricos para esta validación.
4. Observe el stdout del proceso. Se registra solo un resumen técnico con hora física, callback, persistencia y latencia, nunca identidad, tarjeta, imagen ni biometría.

La función `normalizeAccessEvent()` extrae también el `AccessControllerEvent` anidado. El callback espera a que `attendance_events` quede persistido y entonces responde OK; cursores, estado y cálculo diario continúan asíncronamente en el gateway principal.

## Consultar AcsEvent histórico

Defina un rango ISO-8601 explícito y el `devIndex` (o deje que el worker lo resuelva desde `DEVICE_ID=AD4776127`):

```bash
export DEV_INDEX='<devIndex-real>'
export HISTORY_START_TIME='2026-07-16T00:00:00-06:00'
export HISTORY_END_TIME='2026-07-16T23:59:59-06:00'
npm run history
```

El worker pagina mediante:

```http
POST /ISAPI/AccessControl/AcsEvent?format=json&devIndex=<devIndex>
Content-Type: application/json

{"AcsEventCond":{"searchID":"<uuid>","searchResultPosition":0,"maxResults":30,"major":0,"minor":0,"startTime":"<ISO-8601>","endTime":"<ISO-8601>"}}
```

Cada resultado se normaliza con la misma estructura del callback y se imprime como JSON; no se persiste. Ejecute `npm test` para verificar parser y normalización sin dispositivos, empleados ni datos reales.
