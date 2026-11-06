import { renderStatus, feedback, request, observeStatus, bindSafetyControls } from './ui.js';

const $ = id => document.getElementById(id);
let status = null;

function update(next) {
  status = next;
  renderStatus(next);
  $('settings').textContent = next.paired ? 'Revisar alcance y conexión' : 'Configurar autorización';
  $('grant-summary').hidden = !next.paired;
  $('scope-kind').textContent = next.permissions.allowExistingTabs ? 'ACCESO AMPLIADO' : 'SOLO PROPIAS';
  $('tab-scope').textContent = next.permissions.allowExistingTabs ?
    'Pestañas propias y existentes de los sitios autorizados. El control se limita al segundo plano.' :
    'Solo pestañas que cree mbrowser en segundo plano.';
  const list = $('origin-list');
  list.replaceChildren();
  const origins = next.permissions.allowedOrigins;
  const visible = origins.includes('*') ? ['Todos los sitios http/https'] : origins.slice(0, 4);
  if (origins.length > 4 && !origins.includes('*')) visible.push(`Y ${origins.length - 4} más`);
  for (const origin of visible) {
    const item = document.createElement('li');
    item.textContent = origin;
    list.append(item);
  }
  $('tab-count').hidden = !next.paired;
  $('tab-count').textContent = `${next.ownedTabCount} ${next.ownedTabCount === 1 ? 'pestaña propia' : 'pestañas propias'} · ${next.attachedTabCount} ${next.attachedTabCount === 1 ? 'conexión de depuración' : 'conexiones de depuración'}`;
}

$('settings').addEventListener('click', () => { void chrome.runtime.openOptionsPage(); });
const currentWindow = await chrome.windows.getCurrent().catch(() => null);
$('activity').addEventListener('click', () => {
  if (!currentWindow?.id) {
    feedback('Abre mbrowser desde el menú del panel lateral de Chrome.', true);
    return;
  }
  void chrome.sidePanel.open({ windowId: currentWindow.id }).then(
    () => window.close(),
    () => feedback('Abre mbrowser desde el menú del panel lateral de Chrome.', true),
  );
});
bindSafetyControls(() => status, update);
observeStatus(update);
const response = await request({ action: 'getStatus' });
if (response.status) update(response.status);
if (!response.ok) feedback(response.error.message, true);
