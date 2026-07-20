# Runbook real: AC_RENOVA

Estado verificado el 2026-07-16 para el terminal `AC_RENOVA` (`AD4776127`), conectado por ISUP 5.0.

## Secretos y configuración

- Credenciales vigentes: `/home/gsuhul/secrets/devicegateway.env` (`600`).
- Copia de ejecución: `/home/gsuhul/hik-devicegateway-integration/.env` (`600`, ignorada por Git).
- No documentar ni copiar aquí la contraseña.
- `devIndex`: `BAABB0F5-B35C-F94C-B625-E28182439C84`.
- Archivo del índice: `/home/gsuhul/secrets/devicegateway-devindex-AD4776127.txt` (`600`).

## Callback

El callback escucha solo en `127.0.0.1:7000`:

```bash
cd /home/gsuhul/hik-devicegateway-integration
pm2 start npm --name hik-dg-callback -- start
pm2 save
curl http://127.0.0.1:7000/health
```

Operación diaria:

```bash
pm2 status hik-dg-callback
pm2 logs hik-dg-callback --lines 100
pm2 restart hik-dg-callback
```

## HTTP Host y Alarm Forwarding

El HTTP Host quedó configurado por el endpoint ISAPI documentado:

```text
PUT /ISAPI/Event/notification/httpHosts?format=json&devIndex=BAABB0F5-B35C-F94C-B625-E28182439C84
```

Slot HTTP resultante:

- Protocol: `HTTP`
- Host: `127.0.0.1`
- Port: `7000`
- Path: `/ISAPI/Event/notification/uploadEvent?format=json`

El slot EHome `id=2`, dirigido a `185.182.187.75:7663`, se conservó sin cambios. Para comprobar la configuración:

```bash
cd /home/gsuhul/hik-devicegateway-integration
export DEV_INDEX="$(cat /home/gsuhul/secrets/devicegateway-devindex-AD4776127.txt)"
node src/cli.js http-host get
```

En la UI de DeviceGateway, la función general está en **Gateway Configuration → Alarm Forwarding**. Esa pestaña controla el forwarding ISUP del gateway; el destino HTTP específico del terminal fue configurado mediante ISAPI porque el frontend instalado no muestra de forma inequívoca un editor de HTTP Host.

## Histórico AcsEvent

```bash
cd /home/gsuhul/hik-devicegateway-integration
export DEV_INDEX="$(cat /home/gsuhul/secrets/devicegateway-devindex-AD4776127.txt)"
export HISTORY_START_TIME="$(date +%Y-%m-%d)T00:00:00-06:00"
export HISTORY_END_TIME="$(date +%Y-%m-%d)T23:59:59-06:00"
npm run history
```

El comando solo imprime cantidad, rango temporal, nombres de campos e indicadores booleanos de empleado/tarjeta. No imprime imágenes, biometría ni eventos completos. La validación del 2026-07-16 devolvió 8 eventos entre `14:58:26-06:00` y `15:08:51-06:00`, sin empleado ni tarjeta.

## Prueba de marcación real

1. Mantener `pm2 logs hik-dg-callback --lines 100` abierto.
2. Comprobar `/health`.
3. Hacer una sola marcación autorizada con tarjeta o PIN de prueba, sin rostro ni huella y sin crear empleados demo.
4. Confirmar en el log una nueva línea resumen del callback.
5. Si no llega, revisar en **Gateway Configuration → Alarm Forwarding** que el forwarding requerido esté habilitado y revisar el histórico del mismo intervalo.

## Antes de conectar Supabase

- Capturar y revisar al menos un evento real no biométrico en el callback.
- Confirmar major/minor y timestamp que representan una marcación válida.
- Definir idempotencia usando serial del evento, dispositivo y fecha.
- Definir retención y tratamiento de identificadores de empleado/tarjeta.
- Implementar y probar el adaptador de persistencia por separado. Actualmente no existe ninguna escritura a Supabase.
