import { BackgroundController } from './background.js';

const controller = new BackgroundController();
const ignore = promise => { Promise.resolve(promise).catch(() => {}); };

// The one-way handoff is separate from the extension's trusted UI messages.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action === 'handoff') {
    ignore(controller.handleHandoff(message, sender));
    return false;
  }
  if (!controller.isUiSender(sender)) return false;
  controller.handleUi(message, sender).then(respond, () => respond({
    ok: false,
    error: { code: 'EXTENSION_UNAVAILABLE', message: 'La extensión no pudo completar la solicitud. Vuelve a abrir su panel.' },
  }));
  return true;
});
function start() {
  ignore(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
  ignore(controller.handleStartup());
}
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
chrome.alarms.onAlarm.addListener(alarm => ignore(controller.handleAlarm(alarm)));
chrome.debugger.onDetach.addListener((source, reason) => ignore(controller.handleDebuggerDetach(source, reason)));
chrome.tabs.onActivated.addListener(({ tabId }) => ignore(controller.handleTabActivated(tabId)));
chrome.tabs.onUpdated.addListener((id, change, tab) => ignore(controller.handleTabUpdated(id, change, tab)));
chrome.tabs.onRemoved.addListener(id => ignore(controller.handleTabRemoved(id)));
chrome.tabs.onReplaced.addListener((added, removed) => ignore(controller.handleTabReplaced(added, removed)));
