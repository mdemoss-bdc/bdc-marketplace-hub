/**
 * Password hashing for register/login.
 *
 * New hashes: bcrypt (cost 10) via bcryptjs — format `$2a$...` / `$2b$...`
 * Legacy verify still accepts:
 *   - scrypt:saltHex:hashHex  (prior Node Vercel store)
 *   - pbkdf2:salt:key         (prefixed PBKDF2)
 *   - salt:key                (Python stdlib PBKDF2 without prefix)
 */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function hashPassword(password) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

function verifyScrypt(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1];
  const hashHex = parts[2];
  if (!saltHex || !hashHex) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function verifyPbkdf2(password, stored) {
  const raw = String(stored || '');
  let body = raw;
  if (raw.startsWith('pbkdf2:')) body = raw.slice('pbkdf2:'.length);
  const idx = body.indexOf(':');
  if (idx <= 0) return false;
  const salt = body.slice(0, idx);
  const keyHex = body.slice(idx + 1);
  if (!salt || !keyHex || keyHex.includes(':')) {
    // Ambiguous multi-colon (e.g. scrypt) — not PBKDF2.
    if (!raw.startsWith('pbkdf2:') && body.split(':').length !== 2) return false;
  }
  try {
    const key = crypto.pbkdf2Sync(String(password), salt, 260000, 32, 'sha256');
    const expected = Buffer.from(keyHex, 'hex');
    if (expected.length === 0 || key.length !== expected.length) return false;
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

function verifyPassword(password, stored) {
  if (!password || !stored || typeof stored !== 'string') return false;
  const hash = stored.trim();
  if (!hash) return false;

  // bcrypt (current)
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
    try {
      return bcrypt.compareSync(String(password), hash);
    } catch {
      return false;
    }
  }

  // Legacy Node scrypt
  if (hash.startsWith('scrypt:')) {
    return verifyScrypt(password, hash);
  }

  // Prefixed or bare Python PBKDF2 (salt:key)
  if (hash.startsWith('pbkdf2:') || /^[0-9a-f]+:[0-9a-f]+$/i.test(hash)) {
    return verifyPbkdf2(password, hash);
  }

  return false;
}

/** True when the stored value looks like a real password hash (any scheme). */
function looksLikePasswordHash(stored) {
  const hash = String(stored || '').trim();
  if (!hash) return false;
  return (
    hash.startsWith('$2a$') ||
    hash.startsWith('$2b$') ||
    hash.startsWith('$2y$') ||
    hash.startsWith('scrypt:') ||
    hash.startsWith('pbkdf2:') ||
    /^[0-9a-f]+:[0-9a-f]+$/i.test(hash)
  );
}

function needsRehash(stored) {
  const hash = String(stored || '').trim();
  return !(
    hash.startsWith('$2a$') ||
    hash.startsWith('$2b$') ||
    hash.startsWith('$2y$')
  );
}

module.exports = {
  hashPassword,
  verifyPassword,
  looksLikePasswordHash,
  needsRehash,
  BCRYPT_ROUNDS,
};
