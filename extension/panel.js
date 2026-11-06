import { renderStatus, feedback, request, observeStatus } from './ui.js';

const $ = id => document.getElementById(id);
const canvas = $('preview-frame');
const activity = $('activity-tabs');
const labels = {
  manual: 'Bajo tu control',
  working: 'Agente trabajando',
  attached: 'Agente conectado',
  idle: 'En espera',
};
let status;
let watched = null;
let refreshing = false;
let lastTabs;
let deciding;

function clearFrame() {
  canvas.width = 0;
  canvas.height = 0;
  canvas.hidden = true;
}

function stopPreview() {
  watched = null;
  clearFrame();
  $('preview-state').hidden = true;
  updatePreviewButtons();
}

function update(next) {
  if (status && next.revision < status.revision) return;
  status = next;
  renderStatus(next);
  $('controls').hidden = !next.paired;
  $('pause').hidden = !next.enabled;
  $('resume').hidden = next.enabled;
  $('revoke').hidden = !next.paired;
  $('site-request').hidden = !next.siteRequest;
  $('site-origin').textContent = next.siteRequest?.origin || '';
  $('allow-site').disabled = $('deny-site').disabled = deciding?.id === next.siteRequest?.id && Boolean(deciding);
  $('activity').hidden = next.connection !== 'connected';
  if (next.connection !== 'connected') {
    stopPreview();
    showTabs([]);
  }
}

function showTabs(tabs) {
  if (watched && !tabs.some(tab => tab.id === watched.id && tab.preview)) stopPreview();
  const signature = JSON.stringify(tabs);
  if (signature === lastTabs) return;
  lastTabs = signature;
  $('empty').hidden = tabs.length > 0;
  const focused = document.activeElement?.dataset.previewId;
  const rows = tabs.map(tab => {
    const row = document.createElement('li');
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = tab.title || 'Sin título';
    const detail = document.createElement('span');
    detail.textContent = `${labels[tab.state]} · ${tab.origin}`;
    text.append(title, detail);
    row.append(text);
    if (tab.preview) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.dataset.previewId = String(tab.id);
      button.addEventListener('click', () => togglePreview(tab.id));
      row.append(button);
    }
    return row;
  });
  activity.replaceChildren(...rows);
  updatePreviewButtons();
  if (focused) [...activity.querySelectorAll('button')].find(button => button.dataset.previewId === focused)?.focus();
}

function updatePreviewButtons() {
  for (const button of activity.querySelectorAll('button')) {
    const shown = Number(button.dataset.previewId) === watched?.id;
    button.textContent = shown ? 'Ocultar' : 'Ver';
    button.setAttribute('aria-pressed', String(shown));
  }
}

function togglePreview(id) {
  const alreadyWatching = watched?.id === id;
  stopPreview();
  if (alreadyWatching) return;
  watched = { id };
  updatePreviewButtons();
  previewState('Cargando vista…');
  void refresh();
}

function previewState(message) {
  $('preview-state').textContent = message;
  $('preview-state').hidden = !message;
}

function drawPointer(context, cursor) {
  if (!cursor) return;
  context.save();
  context.translate(cursor.x * canvas.width, cursor.y * canvas.height);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(0, 24);
  context.lineTo(7, 17);
  context.lineTo(12, 25);
  context.lineTo(17, 22);
  context.lineTo(12, 14);
  context.lineTo(23, 14);
  context.closePath();
  context.fillStyle = '#1f6feb';
  context.strokeStyle = '#fff';
  context.lineWidth = 2;
  context.fill();
  context.stroke();
  context.restore();
}

async function draw(frame, selection) {
  const bytes = Uint8Array.from(atob(frame.image), character => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    if (watched !== selection || document.hidden) return;
    const width = Math.min(bitmap.width, 800);
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(bitmap.height * width / bitmap.width));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    drawPointer(context, frame.cursor);
    canvas.hidden = false;
    previewState('');
  } finally {
    bitmap.close();
  }
}

async function refresh() {
  if (refreshing || document.hidden || status?.connection !== 'connected') return;
  refreshing = true;
  try {
    const activity = await request({ action: 'getActivity' });
    if (!activity.ok || status?.connection !== 'connected') {
      showTabs([]);
      return;
    }
    showTabs(activity.tabs);
    const selection = watched;
    if (!selection) return;
    const preview = await request({ action: 'getPreview', tabId: selection.id });
    if (watched !== selection || document.hidden) return;
    if (!preview.ok) {
      clearFrame();
      previewState(preview.error?.message || 'Esperando una imagen de la pestaña…');
    } else if (preview.frame) {
      await draw(preview.frame, selection);
    } else {
      clearFrame();
      previewState('Esperando actividad del agente…');
    }
  } catch {
    stopPreview();
    previewState('Chrome no pudo mostrar la vista previa.');
  } finally {
    refreshing = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPreview();
  else void refresh();
});

async function control(message) {
  const response = await request(message);
  if (response.status) update(response.status);
  feedback(response.ok ? '' : response.error.message, !response.ok);
}

async function decideSite(allow) {
  const pending = status?.siteRequest;
  if (!pending || deciding?.id === pending.id) return;
  deciding = pending;
  update(status);
  try { await control({ action: 'decideSite', id: pending.id, allow }); }
  finally {
    if (deciding === pending) deciding = null;
    update(status);
  }
}

$('allow-site').addEventListener('click', () => { void decideSite(true); });
$('deny-site').addEventListener('click', () => { void decideSite(false); });
$('pause').addEventListener('click', () => { void control({ action: 'pause' }); });
$('resume').addEventListener('click', () => {
  if (status) void control({ action: 'resume', revision: status.revision, accepted: true });
});
$('revoke').addEventListener('click', () => { void control({ action: 'revoke', confirmed: true }); });
observeStatus(update);
const initial = await request({ action: 'getStatus' });
if (!status && initial.status) update(initial.status);
if (!initial.ok) feedback(initial.error.message, true);
void refresh();
setInterval(refresh, 800);
