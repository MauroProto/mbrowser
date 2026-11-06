import { normalizeAllowedOrigins, normalizePort, normalizePairCode } from './policy.js';
import { renderStatus, feedback, request, observeStatus, bindSafetyControls } from './ui.js';

const $ = id => document.getElementById(id);
const radios = [...document.querySelectorAll('input[name="scope"]')];
let status = null;
let initialized = false;
let busy = false;

function selectedOrigins() {
  if (radios.find(input => input.checked)?.value === 'all') return ['*'];
  const origins = $('origins').value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean);
  return normalizeAllowedOrigins(origins, { allowWildcard: false });
}

function consent() {
  return {
    accepted: $('consent').checked,
    allowExistingTabs: $('allow-existing').checked,
    allowedOrigins: selectedOrigins(),
  };
}

function validField(id, validate) {
  const field = $(id);
  const hint = $(`${id}-error`);
  let message = '';
  try { validate(field.value); } catch (error) { message = error.message; }
  const invalid = Boolean(message && field.value.trim());
  field.setAttribute('aria-invalid', String(invalid));
  hint.textContent = invalid ? message : '';
  hint.hidden = !invalid;
  return !message;
}

function refreshControls() {
  const all = radios.find(input => input.checked)?.value === 'all';
  $('origins-field').hidden = all;
  $('origins').disabled = all;
  $('all-origins-warning').hidden = !all;
  const originsValid = validField('origins', selectedOrigins);
  const portValid = validField('bridge-port', normalizePort);
  const codeValid = validField('pair-code', normalizePairCode);
  const accepted = $('consent').checked && originsValid;
  $('pair-button').disabled = busy || !status || !accepted || !portValid || !codeValid;
  $('apply-permissions').disabled = busy || !status?.paired || !accepted;
  $('pair-button').textContent = busy ? 'Guardando autorización…' : status?.paired ? 'Reemplazar vínculo y conectar' : 'Autorizar y conectar';
}

function populate(next) {
  const all = next.permissions.allowedOrigins.includes('*');
  radios.forEach(input => { input.checked = input.value === (all ? 'all' : 'exact'); });
  $('origins').value = all ? '' : next.permissions.allowedOrigins.join('\n');
  $('allow-existing').checked = next.permissions.allowExistingTabs;
  $('bridge-port').value = String(next.bridgePort);
  $('consent').checked = false;
  refreshControls();
}

function update(next) {
  const previousRevision = status?.revision;
  status = next;
  renderStatus(next);
  $('apply-permissions').hidden = !next.paired;
  $('pairing-summary').textContent = next.paired ? 'Vínculo guardado. Abre esta sección solo para reemplazarlo.' : 'Necesitas un código solo la primera vez.';
  if (!initialized) {
    initialized = true;
    populate(next);
    $('pairing-details').open = !next.paired;
  } else if (previousRevision !== next.revision) {
    // A safety pause in another view invalidates previously checked approval, but keeps the unsaved draft.
    $('consent').checked = false;
  }
  refreshControls();
}

function invalidateConsent() {
  $('consent').checked = false;
  refreshControls();
}
for (const radio of radios) radio.addEventListener('change', invalidateConsent);
$('origins').addEventListener('input', invalidateConsent);
$('allow-existing').addEventListener('change', invalidateConsent);
$('bridge-port').addEventListener('input', invalidateConsent);
$('consent').addEventListener('change', refreshControls);
$('pair-code').addEventListener('input', refreshControls);

$('setup-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !status) return;
  let message;
  try {
    const grant = consent();
    if (!grant.accepted) throw new Error('Revisa el alcance y marca tu autorización antes de conectar.');
    message = {
      action: 'pair', revision: status.revision,
      port: normalizePort($('bridge-port').value),
      code: normalizePairCode($('pair-code').value), consent: grant,
    };
  } catch (error) { feedback(error.message, true); return; }
  // The code never persists in the page, browser storage, status or diagnostics.
  $('pair-code').value = '';
  busy = true;
  refreshControls();
  feedback('Validando el código con Harness. No se repetirán acciones de navegador.');
  try {
    const response = await request(message);
    message.code = '';
    if (response.status) update(response.status);
    if (response.ok) {
      populate(response.status);
      $('pairing-details').open = false;
      feedback('Autorización guardada. La conexión se iniciará solo dentro del alcance que elegiste.');
    } else feedback(response.error.message, true);
  } finally {
    message.code = '';
    busy = false;
    $('consent').checked = false;
    refreshControls();
  }
});

$('apply-permissions').addEventListener('click', async () => {
  if (busy || !status) return;
  let grant;
  try {
    grant = consent();
    if (!grant.accepted) throw new Error('Confirma tu autorización antes de guardar y conectar.');
  } catch (error) { feedback(error.message, true); return; }
  busy = true;
  refreshControls();
  try {
    const response = await request({ action: 'updatePermissions', revision: status.revision, consent: grant });
    if (response.status) update(response.status);
    if (response.ok) {
      populate(response.status);
      feedback('Alcance actualizado. Se canceló el trabajo anterior y se conectará con los nuevos límites.');
    } else feedback(response.error.message, true);
  } finally {
    busy = false;
    $('consent').checked = false;
    refreshControls();
  }
});

bindSafetyControls(() => status, update);
observeStatus(update);
const response = await request({ action: 'getStatus' });
if (response.status) update(response.status);
if (!response.ok) feedback(response.error.message, true);
