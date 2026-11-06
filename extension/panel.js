import { renderStatus, feedback, request, observeStatus, bindSafetyControls } from './ui.js';

const $ = id => document.getElementById(id);
const select = $('preview-tab');
const canvas = $('preview-frame');
const toggle = $('toggle-preview');
const labels = {
  manual: 'Bajo tu control',
  working: 'Agente trabajando',
  attached: 'Agente conectado',
  idle: 'En espera',
};
let status;
let watched = null;
let refreshing = false;

function clearFrame() {
  canvas.width = 0;
  canvas.height = 0;
  canvas.hidden = true;
}

function stopPreview() {
  watched = null;
  clearFrame();
  $('preview-state').hidden = true;
  toggle.textContent = 'Ver vista previa';
  toggle.setAttribute('aria-pressed', 'false');
}

function update(next) {
  status = next;
  renderStatus(next);
  if (next.connection !== 'connected') {
    stopPreview();
    showTabs([]);
  }
}

function showTabs(tabs) {
  $('empty').hidden = tabs.length > 0;
  const rows = tabs.map(tab => {
    const row = document.createElement('li');
    row.dataset.state = tab.state;
    const title = document.createElement('strong');
    title.textContent = tab.title || 'Sin título';
    const detail = document.createElement('span');
    detail.textContent = `${labels[tab.state]} · ${tab.origin}`;
    row.append(title, detail);
    return row;
  });
  $('activity-tabs').replaceChildren(...rows);
  const eligible = tabs.filter(tab => tab.preview);
  if (watched && !eligible.some(tab => tab.id === watched.id)) stopPreview();
  const previous = select.value;
  const signature = JSON.stringify(eligible.map(tab => [tab.id, tab.title, tab.origin]));
  if (select.dataset.tabs !== signature) {
    select.dataset.tabs = signature;
    select.replaceChildren(...eligible.map(tab => new Option(tab.title || tab.origin, String(tab.id))));
    if (eligible.some(tab => String(tab.id) === previous)) select.value = previous;
  }
  select.disabled = eligible.length === 0;
  toggle.disabled = eligible.length === 0;
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
    }
  } catch {
    stopPreview();
    previewState('Chrome no pudo mostrar la vista previa.');
  } finally {
    refreshing = false;
  }
}

select.addEventListener('change', stopPreview);
toggle.addEventListener('click', () => {
  if (watched) {
    stopPreview();
  } else if (select.value) {
    watched = { id: Number(select.value) };
    toggle.textContent = 'Detener vista previa';
    toggle.setAttribute('aria-pressed', 'true');
    previewState('Esperando una imagen de la pestaña…');
    void refresh();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPreview();
  else void refresh();
});

$('settings').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
bindSafetyControls(() => status, update);
observeStatus(update);
const initial = await request({ action: 'getStatus' });
if (initial.status) update(initial.status);
if (!initial.ok) feedback(initial.error.message, true);
void refresh();
setInterval(refresh, 800);
