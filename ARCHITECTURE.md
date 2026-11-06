# mbrowser architecture

## Components

- `host-v2.js` is the Cordis entry point for the current bundle. It registers structured Harness tools and uses the profile's credential and storage-domain services. The installed package name remains `@local/mbrowser`.
- `lib/engine.js` resolves per-agent ownership, current tabs and DOM references. It uses the in-process extension transport for all Harness tools.
- `lib/bridge.js` serves the authenticated control channel on IPv4 loopback. Only the pinned extension Origin may upgrade or use pairing and revocation routes.
- `extension/background.js` enforces the user's grant, validates the browser target and coordinates native debugger operations. The panel is a trusted extension page, separate from the Harness tool channel.

## Pairing and revocation

Protocol 2 derives a device key from a 128-bit, one-use pairing code and fresh nonces. The pairing request and response contain HMAC proofs rather than the code or device key. The Host consumes the code before writing the grant. On reconnect, the worker challenges the listener and verifies its proof before sending its own proof and the consent scope. Each proof binds its role, protocol, port, extension identity and relevant nonces. Chrome and Harness retain the derived key in their respective credential stores.

Revocation disables local control first. The retry request and acknowledgement use a separate derived revocation key. The Host retains only that key in a revoked record so it can sign acknowledgements after a lost reply. A new pairing replaces the previous grant. Version 1 protocol credentials are ineligible for protocol 2.

The bridge assumes a trusted local OS, Chrome profile and installed Harness code. A local process without the device key cannot impersonate the listener. A process that controls the user's account or installation can change those trust assumptions.

## Chrome control

Chrome creates agent tabs inactive. The worker checks authorization, current and pending origins, ownership and whether the tab is selected. It checks again after asynchronous debugger attachment and before dispatch. Selecting a tab aborts that tab's pending commands and detaches the debugger. Pause, revocation and navigation outside the grant release attachments without issuing renderer-wide stop or termination commands. Operations already submitted to Chrome may have taken effect.

A Chrome browser instance and Harness agent scope both constrain close ownership. The tab list and targeted access exclude tabs owned by other agents. The optional pre-existing-tab grant applies only to regular background tabs and never grants close authority.

Page observations and actions use the top document. The engine uses unique selectors or snapshot references that retain Node identity. It rejects embedded frame targets and known new-window, file-picker and out-of-grant link/form targets. Focus checks protect native typing. An approved site's own scripts still run under Chrome's policies. JavaScript evaluation is internal to the structured operations. Raw scripts and screenshot file output are outside the registered Harness tool surface.

## Local preview

The activity panel reads transient tab titles, origins and status from the worker. It requests frames only after a user selects preview. The worker accepts preview requests from the panel's exact extension URL and only captures a connected, extension-owned background tab. It checks the grant, document generation and tab selection before and after capture. Preview traffic is bounded and separate from the bridge. The panel draws each frame into an in-memory canvas and clears it on pause, loss of the tab, hiding or stopping preview.

The paired engine sends a short-lived, normalized pointer position for clicks, targeted keys and scroll. The panel draws the pointer over the preview independently of page rendering. Background scroll uses CSSOM offsets and does not send wheel events. Native clicks and keyboard actions use Chrome input events. A visual overlay can be disabled in the Harness plugin configuration.

## Observation limits

Returned observations use JSON text, size limits and defensive redaction of recognized password values. Arbitrary page text may still contain sensitive data. Site consent governs mbrowser's target documents and does not change ordinary browser networking, navigation policies or how Harness handles tool results. See [TESTING.md](./TESTING.md) for test coverage.
