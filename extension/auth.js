export const PROTOCOL = 2;
export const PAIR_CODE_PATTERN = /^[A-F0-9]{32}$/;
export const PROOF_PATTERN = /^[a-f0-9]{64}$/;

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const bytes = (value) => Uint8Array.from(value.match(/../g), pair => Number.parseInt(pair, 16));

export function newNonce() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// Role, protocol, listener and extension are bound to every proof. Fixed-position JSON avoids ambiguous concatenation.
export function proofMessage(purpose, port, extensionId, ...fields) {
  return JSON.stringify(['mbrowser', PROTOCOL, purpose, port, extensionId, ...fields]);
}

function importKey(key, usage) {
  return crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signProof(key, purpose, ...fields) {
  const signer = await importKey(key, 'sign');
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', signer, encoder.encode(proofMessage(purpose, ...fields)))));
}

export async function verifyProof(key, proof, purpose, ...fields) {
  if (typeof proof !== 'string' || !PROOF_PATTERN.test(proof)) return false;
  const verifier = await importKey(key, 'verify');
  return crypto.subtle.verify('HMAC', verifier, bytes(proof), encoder.encode(proofMessage(purpose, ...fields)));
}
