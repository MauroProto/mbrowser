// Pure validation shared by the worker and its local tests. No page code is loaded here.
import { PAIR_CODE_PATTERN, PROOF_PATTERN } from './auth.js';
export { PROTOCOL } from './auth.js';
export const DEFAULT_PORT = 43127;
export const CONSENT_VERSION = 1;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;
export const MAX_HTTP_BYTES = 16 * 1024;
export const MAX_COMMAND_MS = 120_000;
export const MAX_IN_FLIGHT = 32;

const UNSAFE_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export class ExtensionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExtensionError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ExtensionError(code, message);
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keysOnly(value, keys) {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) {
    fail('INVALID_ARGUMENT', 'Los parámetros de la operación no son válidos.');
  }
}

export function normalizePort(input) {
  if ((typeof input !== 'number' && typeof input !== 'string') || !/^\d{4,5}$/.test(String(input))) {
    fail('INVALID_PORT', 'Indica un puerto numérico local entre 1024 y 65535.');
  }
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || UNSAFE_PORTS.has(port)) {
    fail('INVALID_PORT', 'Ese puerto no es seguro para Chrome. Usa el puerto indicado por Harness.');
  }
  return port;
}

export function bridgeUrl(port, path, websocket = false) {
  // Neither the UI nor stored data can supply a host, scheme, path, or query string.
  if (!['/pair', '/revoke', '/extension'].includes(path) || (websocket !== (path === '/extension'))) {
    fail('INVALID_ENDPOINT', 'El punto de conexión local no es válido.');
  }
  return `${websocket ? 'ws' : 'http'}://127.0.0.1:${normalizePort(port)}${path}`;
}

export function normalizePairCode(input) {
  if (typeof input !== 'string' || input.length > 64) {
    fail('INVALID_PAIR_CODE', 'El código debe tener 32 caracteres hexadecimales.');
  }
  const code = input.trim().replaceAll('-', '').toUpperCase();
  if (!PAIR_CODE_PATTERN.test(code)) {
    fail('INVALID_PAIR_CODE', 'Copia el código de un solo uso que muestra Harness.');
  }
  return code;
}

export function validToken(value) {
  return typeof value === 'string' && PROOF_PATTERN.test(value);
}

export function normalizeAllowedOrigins(input, { allowWildcard = true } = {}) {
  if (!Array.isArray(input) || input.length > 100) {
    fail('INVALID_ORIGINS', 'La lista de sitios autorizados no es válida.');
  }
  if (allowWildcard && input.length === 1 && input[0] === '*') return ['*'];
  const result = [];
  for (const item of input) {
    if (typeof item !== 'string' || item.length > 2048 || item !== item.trim() || /[\s*\u0000-\u001f\u007f]/u.test(item) ||
        !/^https?:\/\/[^/@\\?#]+\/?$/iu.test(item)) {
      fail('INVALID_ORIGINS', 'Usa orígenes exactos, por ejemplo https://ejemplo.com, sin rutas ni comodines.');
    }
    let parsed;
    try { parsed = new URL(item); } catch {
      fail('INVALID_ORIGINS', 'Hay un origen que no es una dirección web válida.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parsed.pathname !== '/' || !parsed.hostname) {
      fail('INVALID_ORIGINS', 'Cada origen debe ser http(s)://dominio[:puerto], sin rutas, credenciales ni parámetros.');
    }
    if (!result.includes(parsed.origin)) result.push(parsed.origin);
  }
  return result;
}

export function normalizeWebUrl(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 16_384 || /[\u0000-\u0020\u007f]/u.test(input)) {
    fail('INVALID_URL', 'Usa una dirección http o https válida, sin credenciales.');
  }
  let parsed;
  try { parsed = new URL(input); } catch {
    fail('INVALID_URL', 'La dirección de la pestaña no es válida.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    fail('INVALID_URL', 'Solo se pueden controlar sitios http o https, sin credenciales en la dirección.');
  }
  return parsed.href;
}

export function isAllowedUrl(input, allowedOrigins) {
  try {
    const url = new URL(normalizeWebUrl(input));
    return allowedOrigins.includes('*') || allowedOrigins.includes(url.origin);
  } catch { return false; }
}

export function parseTabId(input) {
  if (typeof input !== 'string' || !/^ext:[1-9]\d{0,9}$/.test(input)) {
    fail('INVALID_TAB_ID', 'El identificador de pestaña no es válido para esta extensión.');
  }
  const id = Number(input.slice(4));
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) {
    fail('INVALID_TAB_ID', 'El identificador de pestaña está fuera de rango.');
  }
  return id;
}

export function validChromeTabId(input) {
  return Number.isSafeInteger(input) && input > 0 && input <= 2_147_483_647;
}

export function validRequestId(input) {
  return (typeof input === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(input)) ||
    (Number.isSafeInteger(input) && input >= 0);
}

function finite(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function integer(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function optional(value, test) {
  return value === undefined || test(value);
}

const CDP_METHODS = Object.freeze([
  'Page.enable',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.navigate',
  'Runtime.evaluate',
  'Emulation.setFocusEmulationEnabled',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
]);

export function validateCdp(method, params) {
  if (!CDP_METHODS.includes(method)) {
    fail('CDP_METHOD_DENIED', 'Ese método de depuración no está autorizado por mbrowser.');
  }
  if (!isRecord(params)) fail('INVALID_ARGUMENT', 'Los parámetros de depuración deben ser un objeto.');
  let valid = true;
  switch (method) {
    case 'Page.enable':
    case 'Page.getFrameTree':
      keysOnly(params, []);
      break;
    case 'Page.createIsolatedWorld':
      keysOnly(params, ['frameId', 'worldName', 'grantUniveralAccess']);
      valid = typeof params.frameId === 'string' && params.frameId.length > 0 && params.frameId.length <= 256 &&
        typeof params.worldName === 'string' && params.worldName.length > 0 && params.worldName.length <= 256 &&
        params.grantUniveralAccess === false;
      break;
    case 'Page.navigate':
      keysOnly(params, ['url']);
      normalizeWebUrl(params.url);
      break;
    case 'Runtime.evaluate':
      keysOnly(params, ['expression', 'contextId', 'awaitPromise', 'returnByValue', 'userGesture', 'timeout']);
      valid = typeof params.expression === 'string' && params.expression.length <= MAX_REQUEST_BYTES &&
        integer(params.contextId, 1, 2_147_483_647) && params.awaitPromise === true && params.returnByValue === true &&
        params.userGesture === false && finite(params.timeout, 1, MAX_COMMAND_MS);
      break;
    case 'Emulation.setFocusEmulationEnabled':
      keysOnly(params, ['enabled']);
      valid = typeof params.enabled === 'boolean';
      break;
    case 'Input.dispatchMouseEvent':
      keysOnly(params, ['type', 'x', 'y', 'button', 'buttons', 'clickCount', 'deltaX', 'deltaY', 'modifiers']);
      valid = ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(params.type) &&
        finite(params.x, 0, 1_000_000) && finite(params.y, 0, 1_000_000) &&
        optional(params.button, v => ['none', 'left'].includes(v)) &&
        optional(params.buttons, v => integer(v, 0, 1)) &&
        optional(params.clickCount, v => integer(v, 0, 2)) &&
        optional(params.deltaX, v => finite(v, -1_000_000, 1_000_000)) &&
        optional(params.deltaY, v => finite(v, -1_000_000, 1_000_000)) &&
        optional(params.modifiers, v => integer(v, 0, 15));
      break;
    case 'Input.dispatchKeyEvent':
      keysOnly(params, ['type', 'key', 'code', 'windowsVirtualKeyCode', 'nativeVirtualKeyCode', 'modifiers', 'commands', 'text', 'unmodifiedText']);
      valid = ['keyDown', 'keyUp'].includes(params.type) &&
        optional(params.key, v => typeof v === 'string' && v.length <= 64) &&
        optional(params.code, v => typeof v === 'string' && v.length <= 64) &&
        optional(params.windowsVirtualKeyCode, v => integer(v, 0, 65535)) &&
        optional(params.nativeVirtualKeyCode, v => integer(v, 0, 65535)) &&
        optional(params.modifiers, v => integer(v, 0, 15)) &&
        optional(params.text, v => params.type === 'keyDown' && typeof v === 'string' && v.length <= 4 && !/[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f]/u.test(v)) &&
        optional(params.unmodifiedText, v => params.type === 'keyDown' && typeof v === 'string' && v.length <= 4 && !/[\u0000-\u0008\u000a-\u000c\u000e-\u001f\u007f]/u.test(v)) &&
        optional(params.commands, v => Array.isArray(v) && v.length <= 2 && v.every(c => ['selectAll', 'deleteBackward', 'deleteForward'].includes(c)));
      break;
    case 'Input.insertText':
      keysOnly(params, ['text']);
      valid = typeof params.text === 'string' && params.text.length <= MAX_REQUEST_BYTES;
      break;
  }
  if (!valid) fail('INVALID_ARGUMENT', 'Los parámetros del método de depuración no están autorizados.');
}

// No original Chrome error text is returned: it can contain URLs, script source or typed secrets.
export function safeError(error) {
  if (error instanceof ExtensionError) return { code: error.code, message: error.message };
  const text = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (/cannot find context|context.*destroyed|context.*not found|uniquecontextid|execution context/.test(text)) {
    return { code: 'CDP_CONTEXT_GONE', message: 'El documento cambió. Obtén una nueva observación antes de actuar.' };
  }
  if (/no tab|target closed|no target|tab.*closed/.test(text)) {
    return { code: 'TAB_NOT_FOUND', message: 'La pestaña ya no está disponible.' };
  }
  if (/another debugger|already attached|cannot attach/.test(text)) {
    return { code: 'DEBUGGER_BUSY', message: 'Otra sesión de depuración ocupa la pestaña. Cierra esa sesión y reanuda mbrowser.' };
  }
  if (/not attached|debugger is not attached/.test(text)) {
    return { code: 'DEBUGGER_DETACHED', message: 'La conexión de depuración se interrumpió.' };
  }
  if (/timed out|timeout/.test(text)) {
    return { code: 'TIMEOUT', message: 'La operación superó su tiempo de espera.' };
  }
  return { code: 'CHROME_OPERATION_FAILED', message: 'Chrome no pudo completar la operación. No se reintentó automáticamente.' };
}
