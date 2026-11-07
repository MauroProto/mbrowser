/** mbrowser v2 Host entry. In-process, extension-authorized, no direct-CDP fallback. */
import { z } from 'zod';
import manifest from './package.json' with { type: 'json' };
import { normalizePort } from './extension/policy.js';
import Schema from '@deepseek-ai/schemastery';
import { BrowserBridge, bridgeError, CREDENTIAL_KEY, DEFAULT_PORT } from './lib/bridge.js';
import { ExtensionTransport } from './lib/extension-transport.js';
import { BrowserEngine } from './lib/engine.js';
import { createToolDefinitions } from './lib/tools.js';
import { createLinkCommand } from './lib/link-chrome.js';

export const name = 'mbrowser';
export const inject = ['tools', 'credentials', 'storageDomain', 'commands'];
// Cordis configuration uses Schemastery; domain records use Zod, not the reverse.
export const Config = Schema.object({
  port: Schema.number().min(1024).max(65535).step(1).default(DEFAULT_PORT).description('Local bridge port. Use the same port in the Chrome extension.'),
  overlay: Schema.boolean().default(true).description('Show a temporary pointer in the local activity preview.'),
}).default({});
const RuntimeConfig = z.object({
  port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
  overlay: z.boolean().default(true),
}).default({ port: DEFAULT_PORT, overlay: true });
export function parseConfig(value) {
  const config = RuntimeConfig.parse(value);
  normalizePort(config.port);
  return config;
}

const STATE_DOMAIN = 'mbrowser_engine_v2';
const cancelled = () => bridgeError('ABORTED', 'mbrowser fue cancelado. No se inició una acción nueva.');

function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolvePromise, reject) => {
    const abort = () => finish(false, cancelled());
    let settled = false;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (ok) resolvePromise(value); else reject(value);
    };
    Promise.resolve(promise).then((value) => finish(true, value), (error) => finish(false, error));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Exported for focused integration tests; all business APIs were inspected before use. */
export function createRunner({ engine, bridge, signal: lifetimeSignal }) {
  return async (action, suppliedArgs = {}, exec = {}) => {
    const signal = exec.signal && lifetimeSignal
      ? AbortSignal.any([exec.signal, lifetimeSignal]) : exec.signal || lifetimeSignal;
    if (signal?.aborted) throw cancelled();
    if (action === 'status') {
      if (suppliedArgs.pair === true) {
        throw bridgeError('HUMAN_ACTION_REQUIRED', 'Elegí /mbrowser en la interfaz de Harness para conectar Chrome.');
      }
      const status = await withAbort(bridge.status(), signal);
      if (signal?.aborted) throw cancelled();
      const result = { ...status, version: manifest.version, engine_revision: engine?.constructor?.revision || 'unknown', state_persisted: true };
      if (!result.connected) result.setup = result.paired
        ? ['Abrí mbrowser en Chrome y pulsá Activar.']
        : ['Abrí el icono de mbrowser en Chrome y elegí /mbrowser en el Harness que quieras conectar.'];
      return result;
    }
    if (action === 'js' || action === 'shot') {
      throw bridgeError('UNSUPPORTED_COMMAND', 'El complemento ofrece lectura y acciones estructuradas. La vista previa está en el panel de Chrome.');
    }
    const scope = typeof exec.agent?.id === 'string' ? exec.agent.id : 'agentless';
    try { return await engine.execute(action, suppliedArgs, { scope, signal }); }
    catch (error) {
      // Stable codes remain visible even on Hosts which render only Error.message.
      if (typeof error?.code === 'string' && /^[A-Z_]{1,32}$/.test(error.code)) {
        const wrapped = new Error(`[${error.code}] ${error.message}`);
        wrapped.code = error.code;
        throw wrapped;
      }
      throw bridgeError('BROWSER_ERROR', 'mbrowser no pudo completar la acción. Comprueba el estado antes de repetirla.');
    }
  };
}

export async function apply(ctx, suppliedConfig = {}) {
  const config = parseConfig(suppliedConfig);
  // One ordered asynchronous effect owns setup, tool registration and teardown.
  // The routed domain keeps profile state out of source files and session workspaces.
  await ctx.effect(async function* () {
    const domain = await ctx.storageDomain.open({
      name: STATE_DOMAIN, version: 1, layout: 'single',
      global: { schema: z.object({ state: z.unknown() }), initial: { state: null } }, tables: {},
    });
    yield () => domain.close();
    const bridge = new BrowserBridge({
      port: config.port, credentials: ctx.credentials, credentialKey: `${CREDENTIAL_KEY}-${config.port}`,
      pairingTtlMs: 120_000,
    });
    yield () => bridge.dispose();
    const transport = new ExtensionTransport({ bridge });
    const engine = new BrowserEngine({
      transport, overlay: config.overlay,
      stateStore: { load: async () => domain.global.get().state, save: (value) => domain.global.set({ state: value }) },
    });
    yield () => engine.dispose();
    const lifetime = new AbortController();
    yield () => lifetime.abort(new Error('mbrowser unloaded'));
    await bridge.start();
    yield ctx.commands.register(createLinkCommand(bridge));
    const run = createRunner({ engine, bridge, signal: lifetime.signal });
    for (const definition of createToolDefinitions(run)) yield ctx.tools.register(definition);
  }, 'mbrowser extension engine');
}

export { createToolDefinitions } from './lib/tools.js';
