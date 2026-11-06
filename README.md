# mbrowser

mbrowser conecta DeepSeek Harness con Google Chrome para que el agente trabaje en pestañas de fondo. Podés seguir navegando en tu pestaña y abrir el panel lateral para ver qué está haciendo el agente, incluida la posición de su cursor.

[Descargar mbrowser](https://github.com/MauroProto/mbrowser/releases/latest) · [English setup guide](./README.en.md)

## Instalación rápida

Necesitás **DeepSeek Harness 0.2.2-rc.1** y **Google Chrome 120 o posterior**. [Descargar DeepSeek Harness](https://www.deepseek.com/harness/en/)

### 1. Instalá el complemento en Harness

En Harness, abrí **Plugins → Install**. Pegá este enlace, instalá el paquete y activá **mbrowser** si aparece deshabilitado.

```text
https://github.com/MauroProto/mbrowser/releases/download/v3.0.0/mbrowser-3.0.0.tgz
```

Si usás el perfil web desde la terminal, podés instalar el mismo paquete así. [Guía de complementos de Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

```sh
dsh plugin --profile web add https://github.com/MauroProto/mbrowser/releases/download/v3.0.0/mbrowser-3.0.0.tgz
dsh web
```

### 2. Cargá la extensión en Chrome

1. Descargá el ZIP de la extensión y descomprimilo en una carpeta personal fuera del espacio de trabajo del agente. [mbrowser-extension-3.0.0.zip](https://github.com/MauroProto/mbrowser/releases/download/v3.0.0/mbrowser-extension-3.0.0.zip)
2. Abrí `chrome://extensions` en Chrome. Activá **Modo de desarrollador**, pulsá **Cargar descomprimida** y elegí la carpeta que contiene `manifest.json`.
3. Abrí el icono **mbrowser** desde el menú de extensiones y elegí **Configurar autorización**.

Conservá esa carpeta mientras Chrome tenga cargada la extensión. Si Chrome está gestionado por una organización, su política puede restringir la carga de extensiones. [Guía de Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

### 3. Vinculá y probá

1. En Harness, pedí **«Generá un código de vinculación de mbrowser»**. La herramienta `mbrowser_status` genera un código válido por 10 minutos y para un solo uso.
2. En **Configurar autorización**, elegí **Solo estos sitios** y escribí `https://example.com` para probar. Pegá el código, marcá el consentimiento y pulsá **Autorizar y conectar**.
3. Cuando la extensión muestre **Conectado y autorizado**, pedile a Harness **«Abrí https://example.com con mbrowser y decime el título»**.
4. En el icono de la extensión, elegí **Ver actividad del agente**. Cuando una pestaña creada por mbrowser esté conectada al depurador, podés elegirla y pulsar **Ver vista previa**.

Si venís de mbrowser 2, quitá el complemento y la extensión anteriores. Instalá las dos piezas de la versión 3 y generá un código nuevo. La versión 3 cambia el protocolo de vinculación. Si Harness dejó de arrancar y muestra un error sobre `mbrowser:extension:device:v1`, consultá la [migración del registro anterior](./TESTING.md#migración-desde-una-instalación-local-de-la-versión-2).

## Navegar mientras trabaja el agente

El panel lateral muestra el título, el sitio y el estado de las pestañas que usa mbrowser. En la vista previa, el cursor azul marca clics y desplazamientos y algunos usos del teclado. La vista usa imágenes locales de la pestaña seleccionada en el panel. Se detiene al cerrar u ocultar el panel, pausar el control o seleccionar en Chrome la pestaña que estabas viendo.

Podés seguir haciendo clic, seleccionando texto o desplazándote en tu propia pestaña. Si seleccionás una que estaba usando mbrowser, la extensión le cede el control. Para volver a trabajar allí con el agente, cambiá a otra pestaña y pedile que continúe. Chrome muestra su propio aviso de depuración.

**Pausar** corta la automatización de inmediato. **Reanudar** usa los permisos guardados. **Revocar** corta el acceso local e invalida la vinculación. Si Harness está apagado, se completa la revocación cuando vuelva a estar disponible.

## Permisos y datos

- La opción inicial autoriza sitios concretos y solo pestañas creadas por mbrowser. Una casilla separada permite usar tus pestañas existentes en segundo plano. Para habilitar todos los sitios HTTP(S) hay que elegirlo de forma explícita.
- Harness y Chrome se autentican entre sí por el puente local `127.0.0.1`. El código y la clave de vinculación se mantienen fuera de los mensajes del puente.
- Harness recibe los resultados de las acciones que le pedís. Por ejemplo, una lectura puede incluir contenido de una cuenta iniciada en un sitio que autorizaste. La redacción automática cubre campos de contraseña reconocidos.
- La vista previa se queda en el panel de Chrome. El complemento de Harness ofrece operaciones estructuradas sobre el documento principal. mbrowser rechaza enlaces fuera del alcance y controles que abren otra ventana o el selector de archivos. Los sitios autorizados aún pueden iniciar navegación o mostrar sus propios diálogos mediante sus scripts.
- Las pestañas seleccionadas, páginas internas de Chrome, incógnito y archivos locales quedan fuera del control. Los resultados de una acción ya enviada a Chrome pueden llegar antes de una pausa o un cambio de pestaña.

## Herramientas de Harness

| Herramienta | Uso |
| --- | --- |
| `mbrowser_status`, `mbrowser_tabs` | Ver la conexión y las pestañas disponibles para el agente. |
| `mbrowser_open`, `mbrowser_navigate`, `mbrowser_close` | Abrir y navegar en segundo plano. El cierre se limita a pestañas creadas por el mismo agente. |
| `mbrowser_read`, `mbrowser_snapshot`, `mbrowser_wait` | Leer texto, título o HTML con redacción defensiva, inspeccionar controles y esperar un elemento. |
| `mbrowser_click`, `mbrowser_type`, `mbrowser_press`, `mbrowser_scroll` | Usar controles y desplazarse en el documento principal. |

Para apuntar a un elemento, usá la referencia completa de un snapshot reciente o un selector CSS único. Si cambió el documento, tomá un snapshot nuevo.

## Si algo no conecta

| Qué ves | Qué hacer |
| --- | --- |
| Harness no encuentra `mbrowser_status` | Revisá **Plugins** en el perfil que estás usando. Activá mbrowser o reiniciá Harness si te lo pide. |
| El formulario no habilita el botón | Agregá al menos un sitio como `https://example.com`, pegá el código completo y marcá el consentimiento. |
| La extensión espera a Harness | Mantené Harness abierto y comprobá que ambos indiquen el mismo puerto. El predeterminado es **43127**. |
| Harness rechaza un sitio | Agregá el origen exacto, incluido el subdominio o puerto si corresponde. Aprobá el alcance de nuevo en la extensión. |
| Aparece `TAB_IN_USE` | Seleccioná otra pestaña de Chrome para dejar la del agente en segundo plano. |
| La vista previa no está disponible | Pedile al agente que lea o use la pestaña que abrió. La vista necesita una pestaña propia, en segundo plano y conectada al depurador. |

Para desinstalar, revocá la vinculación desde Chrome, quitá la extensión y desinstalá el complemento desde **Plugins** en Harness. En el perfil web también podés usar `dsh plugin --profile web remove @local/mbrowser`.

## Desarrollo

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
npm pack --ignore-scripts
```

[Arquitectura](./ARCHITECTURE.md) · [Pruebas](./TESTING.md)
