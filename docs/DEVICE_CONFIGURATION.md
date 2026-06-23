# Configuracion de dispositivos Hikvision

1. Activar el equipo.
2. Configurar red, gateway y DNS.
3. Configurar zona horaria Guatemala UTC-6.
4. Configurar NTP.
5. Activar Platform Access / ISUP cuando este disponible.
6. Server Address: dominio o IP publica del servidor central.
7. Port: `7660`.
8. Device ID: valor unico que coincide con `devices.device_identifier`.
9. ISUP Key: clave fuerte. En Supabase se guarda solo hash.
10. Configurar estados de asistencia:
    - Entrada
    - Salida almuerzo
    - Entrada almuerzo
    - Salida
11. Probar marcaje.
12. Ver evento recibido en el gateway y luego en `raw_access_events`.

## Sin IP publica en tienda

Para produccion, ISUP/EHome es el modo recomendado porque el dispositivo inicia la conexion hacia el servidor central. ISAPI directo solo aplica si hay LAN, VPN o una IP accesible.
