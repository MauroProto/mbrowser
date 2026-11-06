const $ = id => document.getElementById(id);

const states = Object.freeze({
  connected: ['Activo en DeepSeek Harness', 'El agente usa las pestañas que crea.'],
  connecting: ['Conectando…', ''],
  pairing: ['Conectando…', ''],
  waiting: ['Esperando a Harness', 'Abrí DeepSeek Harness para continuar.'],
  paused: ['Desactivado', 'Activá mbrowser cuando lo necesites.'],
  unpaired: ['Conectá DeepSeek Harness', 'Elegí /mbrowser en el Harness que quieras usar.'],
});
const notices = Object.freeze({
  DETACHED_BY_USER: 'Chrome detuvo el control. Pulsá Activar para seguir.',
  DEBUGGER_BUSY: 'Cerrá la otra sesión de depuración antes de activar.',
  CONNECTION_REPLACED: 'Otro Chrome tomó la conexión.',
  AUTH_REJECTED: 'Desconectá y elegí /mbrowser en Harness para volver a vincular.',
  PROTOCOL_ERROR: 'Actualizá mbrowser en Chrome y en Harness.',
  IDLE: 'mbrowser se desactivó por inactividad.',
  REVOCATION_PENDING: 'Desconectado en Chrome. Se completará al abrir el Harness anterior.',
  DETACH_INCOMPLETE: 'Podés cerrar la depuración desde el aviso de Chrome.',
  STORAGE_UNAVAILABLE: 'Chrome no pudo guardar el estado. Desactivá la extensión si el error continúa.',
  STORAGE_INVALID: 'Elegí /mbrowser en Harness para volver a conectar.',
});

export function renderStatus(status) {
  const [title, detail] = states[status.connection] || states.unpaired;
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
  $('status-detail').hidden = !detail;
  $('status-dot').dataset.state = status.connection;
  const notice = notices[status.notice];
  $('notice').textContent = notice || '';
  $('notice').hidden = !notice;
}

export function feedback(message, error = false) {
  const node = $('feedback');
  node.textContent = message || '';
  node.hidden = !message;
  node.dataset.error = String(error);
}

export async function request(message) {
  let timeout;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 25_000); }),
    ]);
    if (!response || typeof response.ok !== 'boolean') throw new Error('invalid response');
    return response;
  } catch {
    return { ok: false, error: { code: 'EXTENSION_UNAVAILABLE', message: 'Volvé a abrir mbrowser para comprobar la conexión.' } };
  } finally { clearTimeout(timeout); }
}

export function observeStatus(listener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'mbrowser.status' && message.status) listener(message.status);
  });
}
