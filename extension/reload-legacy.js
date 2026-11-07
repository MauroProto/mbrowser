// Chrome may still be using an older manifest after an unpacked folder was updated.
export function reloadLegacyManifest() {
  if (chrome.runtime.getManifest().action?.default_popup !== 'popup.html') return false;
  chrome.runtime.reload();
  return true;
}
