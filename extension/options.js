import { feedback, observeStatus, renderStatus, request } from './ui.js';

const $ = id => document.getElementById(id);
const showPanel = $('show-panel');
let status;
let tab;

function update(next) {
  if (status && next.revision < status.revision) return;
  status = next;
  renderStatus(next);
  showPanel.hidden = !tab || !next.paired;
  showPanel.textContent = next.enabled ? 'Abrir panel' : 'Activar y abrir panel';
}

showPanel.addEventListener('click', () => {
  if (!tab || !status?.paired) return;
  void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
    feedback('Abrí el panel desde el menú de extensiones de Chrome.', true);
  });
  if (!status.enabled) {
    void request({ action: 'resume', revision: status.revision, accepted: true }).then(result => {
      if (result.status) update(result.status);
      if (!result.ok) feedback(result.error.message, true);
    });
  }
});

tab = await chrome.tabs.getCurrent();
observeStatus(update);
const initial = await request({ action: 'consumeLink' });
if (initial.status) update(initial.status);
if (!initial.ok) feedback(initial.error.message, true);
