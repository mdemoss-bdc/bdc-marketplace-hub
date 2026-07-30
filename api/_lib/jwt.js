/**
 * HMAC-SHA256 JWT helpers for BDC Marketplace Hub serverless auth.
 * Secret: AUTH_SESSION_SECRET or DASHBOARD_PASSWORD.
 */
const crypto = require('crypto');

const COOKIE_NAME = 'bdc_session';
const BDC_COOKIE = COOKIE_NAME;
const MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7d

function jwtSecret() {
  return (
    process.env.AUTH_SESSION_SECRET ||
    process.env.DASHBOARD_PASSWORD ||
    ''
  );
}

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function fromB64url(str) {
  const padded = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * @param {{ sub: string, id: number, role: 'Admin'|'Reviewer', is_admin: boolean, is_master_admin: boolean }} claims
 */
function signJwt(claims) {
  const secret = jwtSecret();
  if (!secret) {
    throw new Error('AUTH_SESSION_SECRET or DASHBOARD_PASSWORD must be configured.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: claims.sub,
    id: claims.id,
    role: claims.role,
    is_admin: Boolean(claims.is_admin),
    is_master_admin: Boolean(claims.is_master_admin),
    iat: now,
    exp: now + MAX_AGE_SEC,
  };
  const h = b64urlJson(header);
  const p = b64urlJson(payload);
  const data = `${h}.${p}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function verifyJwt(token) {
  const secret = jwtSecret();
  if (!secret || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const data = `${h}.${p}`;
  const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(fromB64url(p).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || Number(payload.exp) < now) return null;
  if (!payload.sub) return null;
  return payload;
}

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
  sameSite: 'Strict',
  path: '/',
  maxAge: MAX_AGE_SEC,
};

function serializeCookie(name, value, opts) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}

function parseCookies(req) {
  const header = req?.headers?.cookie || req?.headers?.Cookie || '';
  const out = {};
  if (!header) return out;
  String(header)
    .split(';')
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx < 1) return;
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (!key) return;
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    });
  return out;
}

function getTokenFromRequest(req) {
  const cookies = parseCookies(req);
  const fromCookie = cookies[COOKIE_NAME] || cookies[BDC_COOKIE] || '';
  if (fromCookie) return fromCookie;

  const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return '';
}

function setAuthCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, token, cookieOptions),
  );
}

function clearAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', {
      ...cookieOptions,
      maxAge: 0,
    }),
  );
}

module.exports = {
  BDC_COOKIE,
  COOKIE_NAME,
  cookieOptions,
  signJwt,
  verifyJwt,
  parseCookies,
  getTokenFromRequest,
  setAuthCookie,
  clearAuthCookie,
};
