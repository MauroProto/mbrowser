// Only the top-level loopback handoff page runs this isolated script.
const fragment = /^#link=([A-F0-9]{32})$/.exec(location.hash);
if (fragment && !location.search) {
  history.replaceState(null, '', location.pathname);
  if (!document.referrer) {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.querySelector('meta[name="mbrowser-connect"][content="1"]')) return;
      void chrome.runtime.sendMessage({ action: 'handoff', code: fragment[1] }).catch(() => {});
    }, { once: true });
  }
}
