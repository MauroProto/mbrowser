// Only trusted extension pages import this module. No storage access, tokens, fetch or page messaging.
const $ = id => document.getElementById(id);

const notices = Object.freeze({
  DETACHED_BY_USER: 'Chrome desconectó la depuración. mbrowser se pausó y no volverá a conectarse hasta que pulses Reanudar.',
  DEBUGGER_BUSY: 'Otra sesión de depuración ocupa una pestaña. Cierra esa sesión y reanuda mbrowser cuando quieras.',
  CONNECTION_REPLACED: 'Otra conexión reemplazó esta sesión. Se pausó para evitar reconexiones en competencia.',
  AUTH_REJECTED: 'La extensión no pudo verificar la identidad de Harness. Comprueba el puerto y la versión. Si cambiaste de perfil, vuelve a vincular con un código nuevo.',
  PROTOCOL_ERROR: 'La conexión local recibió un mensaje incompatible. El control quedó en pausa por seguridad.',
  REVOCATION_PENDING: 'Acceso local bloqueado. Harness no ha confirmado aún la revocación. Solo se reintentará invalidar la credencial, nunca conectar el control.',
  REVOKED: 'Autorización revocada. Para volver a conectar necesitas un código nuevo de Harness.',
  DETACH_INCOMPLETE: 'El control está detenido, pero Chrome no confirmó la liberación de una conexión. Puedes cancelarla desde el aviso de depuración de Chrome.',
  STORAGE_UNAVAILABLE: 'Chrome no pudo guardar el estado seguro. El control está detenido, pero una pausa no guardada podría perderse al reiniciar. Desactiva la extensión en Chrome si el error continúa antes de volver a autorizarla.',
  STORAGE_INVALID: 'La autorización guardada no era válida. No se inició el control; vuelve a vincular con un código nuevo.',
  PAIRING_REJECTED: 'El código no se aceptó o ya caducó. Pide un código nuevo en Harness y vuelve a confirmar el alcance.',
  PAIRING_PROTOCOL: 'La respuesta de vinculación no es compatible. Revisa que Harness y esta extensión estén actualizados.',
  BRIDGE_UNAVAILABLE: 'Harness no está disponible en el puerto local configurado. Solo se reconecta automáticamente si tu autorización sigue activa.',
  CONSENT_CHANGED: 'Tu autorización cambió durante la solicitud. El control no se reanudó; revisa el estado actual.',
});

export function renderStatus(status) {
  let title;
  let detail;
  switch (status.connection) {
    case 'connected':
      title = 'Conectado y autorizado';
      detail = 'Listo para recibir acciones de Harness dentro del alcance que elegiste.';
      break;
    case 'connecting':
      title = 'Conectando con Harness';
      detail = 'Comprobando la conexión local autenticada. No repitas acciones mientras se conecta.';
      break;
    case 'waiting':
      title = 'Esperando a Harness';
      detail = `Autorización activa. Se intentará la conexión local en el puerto ${status.bridgePort}.`;
      break;
    case 'pairing':
      title = 'Vinculando de forma segura';
      detail = 'Validando el código de un solo uso. Todavía no se está controlando ninguna página.';
      break;
    case 'paused':
      title = 'Control en pausa';
      detail = 'No se aceptan nuevas órdenes ni se reconecta automáticamente. Tu alcance sigue guardado.';
      break;
    default:
      title = status.revocationPending ? 'Acceso bloqueado localmente' : status.notice === 'REVOKED' ? 'Autorización revocada' : 'Todavía sin vincular';
      detail = 'El control está desactivado. Revisa el alcance y autoriza la primera conexión con un código de Harness.';
  }
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
  $('status-dot').dataset.state = status.connection;
  const notice = notices[status.notice];
  $('notice').textContent = notice || '';
  $('notice').hidden = !notice;
  $('pause').hidden = !status.paired || !status.enabled;
  $('resume').hidden = !status.paired || status.enabled;
  $('revoke').hidden = !status.paired && !status.revocationPending;
  $('revoke').textContent = status.revocationPending ? 'Reintentar revocación…' : 'Revocar autorización…';
  if ($('extension-id')) $('extension-id').textContent = status.extensionId;
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
    return { ok: false, error: { code: 'EXTENSION_UNAVAILABLE', message: 'La extensión no respondió. Verifica el estado antes de repetir una acción; no se reintentó automáticamente.' } };
  } finally { clearTimeout(timeout); }
}

export function observeStatus(listener) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === 'mbrowser.status' && message.status) listener(message.status);
  });
}

export function bindSafetyControls(getStatus, update) {
  // Pause remains available while any other request is pending.
  $('pause').addEventListener('click', async () => {
    const response = await request({ action: 'pause' });
    if (response.status) update(response.status);
    feedback(response.ok ? 'Control pausado. Las acciones ya enviadas no se pueden deshacer.' : response.error.message, !response.ok);
  });
  $('resume').addEventListener('click', async () => {
    const status = getStatus();
    if (!status) return;
    $('resume').disabled = true;
    try {
      const response = await request({ action: 'resume', revision: status.revision, accepted: true });
      if (response.status) update(response.status);
      feedback(response.ok ? 'Autorización reanudada con el alcance guardado.' : response.error.message, !response.ok);
    } finally { $('resume').disabled = false; }
  });
  const dialog = $('revoke-dialog');
  $('revoke').addEventListener('click', () => {
    dialog.returnValue = '';
    if (!dialog.open) dialog.showModal();
  });
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'revoke') return;
    const response = await request({ action: 'revoke', confirmed: true });
    if (response.status) update(response.status);
    feedback(response.ok ? 'Control revocado en esta extensión. El estado indica si Harness ya confirmó la invalidación.' : response.error.message, !response.ok);
  });
}
