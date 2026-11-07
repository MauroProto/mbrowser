import { reloadLegacyManifest } from './reload-legacy.js';

if (!reloadLegacyManifest()) {
  document.querySelector('p').textContent = 'Abrí el panel desde el icono de mbrowser.';
}
