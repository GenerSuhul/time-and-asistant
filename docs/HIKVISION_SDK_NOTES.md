# Notas SDK Hikvision

El SDK ISUP/EHome oficial debe obtenerse de Hikvision. No se incluye en este repositorio porque puede tener licencia propietaria.

Coloca librerias nativas Linux en:

```text
services/device-gateway/native/hikvision-isup-sdk
```

Variables:

```bash
HIK_ISUP_SDK_PATH=/ruta/al/sdk
LD_LIBRARY_PATH=/ruta/al/sdk
```

La integracion real puede hacerse con:

- `node-ffi-napi`, si las firmas nativas son estables y compatibles.
- Addon N-API, si se necesita control fino de memoria/callbacks.
- Sidecar C/C++, si el SDK requiere runtime propio.

El modo mock funciona sin SDK. El modo ISUP real queda preparado, pero debe compilarse y probarse con las librerias oficiales y el firmware del dispositivo.

No inventar formatos propietarios: rostro, huella, binario, Base64 o multipart deben seguir documentacion oficial.
