# Extensión de Chrome

Para instalarla, seguí la [guía rápida](../README.md). Cargá la carpeta que contiene `manifest.json` y mantenela fuera de los espacios de trabajo en los que el agente tenga permiso de escritura.

La extensión usa Manifest V3, su ID fijo es `fjgcljkoolmpniiomfmdjkplelohggna` y la conexión solo usa `127.0.0.1`. Harness y la extensión deben usar la misma versión del protocolo.

El icono abre el panel lateral. Elegí **/mbrowser** en DeepSeek Harness para conectar. El panel pide permiso al abrir un sitio nuevo y la tarea continúa al aprobarlo. **Ver** muestra la página y el cursor de una pestaña del agente en segundo plano. Chrome puede mostrar su aviso de depuración.

El permiso `debugger` permite el control por pestaña, `tabs` permite verificar su identidad y destino, `storage` guarda la vinculación y el alcance, `alarms` gestiona reintentos de conexión y revocación, y `sidePanel` muestra la actividad. La única autorización de red del manifiesto corresponde al puente local. La extensión no se carga en incógnito.

[Arquitectura y límites](../ARCHITECTURE.md)
