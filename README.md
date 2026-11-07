# mbrowser

Usá DeepSeek Harness para trabajar en pestañas de Chrome en segundo plano. En el panel lateral podés ver qué pestaña usa el agente y dónde está su cursor mientras seguís navegando.

## Instalación

Necesitás [DeepSeek Harness 0.2.2-rc.1](https://www.deepseek.com/harness/en/) y Chrome 120 o posterior.

1. [Descargá la extensión](https://github.com/MauroProto/mbrowser/releases/download/v3.1.1/mbrowser-extension-3.1.1.zip) y descomprimila fuera del espacio de trabajo del agente. En `chrome://extensions`, activá **Modo de desarrollador** y usá **Cargar descomprimida** para elegir la carpeta que contiene `manifest.json`.
2. En Harness, abrí **Complementos → Instalar** y pegá la dirección del paquete.

```text
https://github.com/MauroProto/mbrowser/releases/download/v3.1.1/mbrowser-3.1.1.tgz
```

3. En el Harness que quieras usar, elegí el comando **`/mbrowser`**. Chrome abre mbrowser y conecta las dos aplicaciones.

Si actualizaste los archivos en la carpeta que ya usaba Chrome, abrí una vez el icono de mbrowser para que Chrome cargue la actualización. Después elegí **`/mbrowser`** en Harness.

Si usás Harness Web desde la terminal, instalá el paquete con `dsh plugin --profile web add <dirección-del-paquete>` y arrancá con `dsh web`. [Guía de complementos de Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

## Uso

Abrí mbrowser en Chrome, pulsá **Activar** y pedile a Harness **«Abrí https://example.com con mbrowser y decime el título»**. Si el panel muestra un sitio nuevo, pulsá **Permitir** para que la tarea continúe. El permiso queda guardado. Pulsá **Ver** junto a una pestaña del agente para ver su página y su cursor.

**Desactivar** detiene el control. mbrowser también se desactiva tras unos dos minutos sin acciones y arranca desactivado cuando reiniciás Chrome. **Desconectar** borra la vinculación y sus permisos. Seleccionar en Chrome una pestaña del agente te devuelve su control. Chrome puede mostrar un aviso de depuración.

## Permisos y datos

- mbrowser empieza sin sitios autorizados y solo puede actuar en sus propias pestañas en segundo plano. Los sitios se autorizan por separado. El panel muestra el dominio y puerto antes de pedir permiso.
- La conexión se autentica en esta computadora. La vista previa se queda en el panel. El contenido que el agente lee en sitios autorizados se devuelve a Harness, incluso si el sitio tiene una sesión iniciada.
- Al actualizar, los sitios exactos se conservan. El acceso a todos los sitios o a pestañas preexistentes se retira. Para instalaciones de mbrowser 2 con errores al arrancar, consultá la [migración del registro anterior](./TESTING.md#migración-desde-una-instalación-local-de-la-versión-2).

[Descargas](https://github.com/MauroProto/mbrowser/releases/latest) · [English guide](./README.en.md) · [Arquitectura](./ARCHITECTURE.md) · [Pruebas](./TESTING.md)
