/**
 * Vercel-safe random token helpers.
 *
 * Prefer Node's `node:crypto.randomBytes`. Fall back to Web Crypto
 * `crypto.getRandomValues` when the Node binding is unavailable (edge/runtime
 * quirks) so registration never hits `crypto.randomBytes is not a function`.
 */
function randomBytesCompat(size) {
  const n = Math.max(1, Number(size) || 16);
  try {
    const { randomBytes } = require('node:crypto');
    return randomBytes(n);
  } catch {
    /* fall through to Web Crypto */
  }
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('No secure random source available (node:crypto / Web Crypto).');
  }
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes);
}

function randomHex(byteLength) {
  return randomBytesCompat(byteLength).toString('hex');
}

/** Recovery id like REC-A1B2C3-D4E5F6 */
function randomRecoveryId() {
  return `REC-${randomHex(3).toUpperCase()}-${randomHex(3).toUpperCase()}`;
}

module.exports = {
  randomBytesCompat,
  randomHex,
  randomRecoveryId,
};
