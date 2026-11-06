# Extensión de Chrome

Para instalarla, seguí la [guía rápida](../README.md). Cargá la carpeta que contiene `manifest.json` y mantenela fuera de los espacios de trabajo en los que el agente tenga permiso de escritura.

La extensión usa Manifest V3, su ID fijo es `fjgcljkoolmpniiomfmdjkplelohggna` y la conexión solo usa `127.0.0.1`. Harness y la extensión deben usar la misma versión del protocolo.

**Configurar autorización** controla los sitios permitidos. **Ver actividad del agente** abre el panel lateral. La vista previa requiere una acción en ese panel y solo está disponible para pestañas creadas por mbrowser en segundo plano. Chrome puede mostrar el aviso nativo de depuración al adjuntarse a una pestaña.

El permiso `debugger` permite el control por pestaña, `tabs` permite verificar su identidad y destino, `storage` guarda la vinculación y el alcance, `alarms` gestiona reintentos de conexión y revocación, y `sidePanel` muestra la actividad. La única autorización de red del manifiesto corresponde al puente local. La extensión no se carga en incógnito.

[Arquitectura y límites](../ARCHITECTURE.md)
