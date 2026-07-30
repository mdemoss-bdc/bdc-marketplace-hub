/**
 * POST /api/auth/login
 * Dynamic credential check against the persistent users table → JWT session.
 */
const { authenticate } = require('../../_lib/users');
const { signJwt, setAuthCookie } = require('../../_lib/jwt');
const {
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} = require('../../_lib/rate-limit');
const { applySecurityHeaders } = require('../../_lib/security');

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      body = {};
    }
  }
  return body || {};
}

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const ip = clientIp(req);
  const limit = checkLoginRateLimit(ip);
  if (!limit.allowed) {
    console.log('[AUTH FAIL]', ip, 'rate limited');
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res.status(429).json({
      error: 'Too many login attempts. Try again later.',
      retryAfterSec: limit.retryAfterSec,
    });
    return;
  }

  const body = parseBody(req);
  // Case-insensitive lookup — authenticate() also lowercases + maps aliases (jdmoss→jdemoss).
  const username = String(body.username || body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!username || !password) {
    console.log('[AUTH FAIL]', username || '(empty)', 'missing username or password');
    recordLoginFailure(ip);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const user = authenticate(username, password);
  if (!user) {
    // authenticate() already logs [AUTH FAIL] with a specific reason
    recordLoginFailure(ip);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  try {
    const token = signJwt({
      sub: user.username,
      id: user.id,
      role: user.role,
      is_admin: user.is_admin,
      is_master_admin: user.is_master_admin,
    });
    setAuthCookie(res, token);
    clearLoginFailures(ip);
    res.status(200).json({
      success: true,
      ...user,
      role: user.role,
      token,
    });
  } catch (err) {
    console.log('[AUTH FAIL]', username, err instanceof Error ? err.message : 'session signing failed');
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Session signing failed.',
    });
  }
};
