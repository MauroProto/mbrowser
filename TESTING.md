# Testing mbrowser

## Deterministic suite

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
```

The suite uses Node's built-in test runner and local fixtures. It checks paired proof exchange, forged listener and response rejection, one-use codes, authenticated revocation, disconnects, user consent, origin checks, active-tab protection, local preview restrictions, per-agent ownership, password redaction, and engine input/scroll behavior. It needs neither a Chrome profile nor a DeepSeek account. The GitHub workflow runs the suite on Windows, macOS and Linux with Node 22 and 24.

## Release checks

The release bundle is produced by `npm pack --ignore-scripts`. It contains the Harness entry, runtime code, Chrome extension and their metadata. The separate ZIP contains the extension assets for **Load unpacked** in Chrome.

To exercise the real path, install the tarball into a fresh Harness profile and load the extension in a disposable Chrome profile. Approve only an isolated fixture origin. Verify pairing, a background open, read and snapshot, native click and typing, CSSOM scroll, activity and preview, selected-tab protection, pause and signed revocation. Keep a separate foreground fixture open and check its focus and selection while the agent uses its background tab.

## Migración desde una instalación local de la versión 2

Si Harness muestra que la clave `mbrowser:extension:device:v1` debe seguir el formato `<scope>/<id>`, el error ocurre antes de cargar mbrowser. Con Harness cerrado, hacé una copia privada de `.credentials.yaml` en el directorio de datos de Harness. En el original, eliminá solo la entrada completa `mbrowser:extension:device:v1` de la sección `records`, incluido su contenido indentado. Volvé a iniciar Harness, instalá la versión 3 y generá un código nuevo. Conservá el resto del archivo tal como está. [Formato del almacén de Harness](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/credentials-local)

## Native verification for 3.0.0

A clean Windows test used DeepSeek Harness 0.2.2-rc.1 and Chrome 156. It installed the packaged bundle, loaded the extension in a disposable browser profile, paired from the options form and verified read, snapshot, click, typing and scroll. A separate selected tab kept its focus and text selection. A link that requested a new window was blocked. The local preview rendered the browser tab and pointer. Selecting the automated tab blocked control and closure. Restarting Harness restored the grant, and pause, resume and authenticated revoke all passed.

## Optional native CDP fixture tests

The developer suite in `tests/live/browser.test.js` uses a disposable Chrome debugger supplied explicitly by the tester. It limits mutations to tabs it creates at its own local fixture origin. This suite exercises browser behavior below the extension transport.

```powershell
$env:MBROWSER_LIVE = '1'
$env:MBROWSER_TEST_CDP_PORT = '9222' # Use the port of a disposable test profile.
pnpm test:live
Remove-Item Env:MBROWSER_LIVE,Env:MBROWSER_TEST_CDP_PORT
```
