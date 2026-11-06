import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

function chromeExecutables() {
  if (process.platform === 'win32') {
    return [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(path => path && isAbsolute(path))
      .map(path => join(path, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (process.platform === 'darwin') {
    return ['/Applications', join(homedir(), 'Applications')]
      .map(path => join(path, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/google-chrome'];
}

function installedChrome() {
  for (const executable of chromeExecutables()) {
    try {
      accessSync(executable, constants.X_OK);
      return executable;
    } catch { /* Try the next standard installation path. */ }
  }
  return null;
}

async function openInChrome(url) {
  const executable = installedChrome();
  if (!executable) throw new Error('Chrome unavailable');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Only the human command can create the link. The credential is never a command result. */
export function createLinkCommand(bridge, open = openInChrome) {
  return {
    name: 'mbrowser',
    description: 'Conectar Chrome a este DeepSeek Harness',
    recordInput: false,
    async handler({ rawInput, signal }) {
      if (rawInput.trim()) return { kind: 'error', text: 'Elegí /mbrowser sin agregar texto.' };
      if (signal?.aborted) return { kind: 'error', text: 'Conexión cancelada.' };
      try {
        const { code } = bridge.createPairingCode();
        const link = bridge.origin + '/mbrowser/connect#link=' + code.replaceAll('-', '');
        await open(link);
        return { kind: 'success', text: 'Continuá en el panel de mbrowser en Chrome.' };
      } catch {
        return { kind: 'error', text: 'No se pudo abrir mbrowser. Comprobá que Google Chrome esté instalado y elegí /mbrowser de nuevo.' };
      }
    },
  };
}
