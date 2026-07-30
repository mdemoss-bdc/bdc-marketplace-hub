/**
 * scrypt password hashing (Node crypto only).
 * Stored format: scrypt:saltHex:hashHex
 */
const crypto = require('crypto');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!password || !stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
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

module.exports = {
  hashPassword,
  verifyPassword,
};
