/**
 * POST /api/auth/login
 * Rate-limited credential check → JWT session cookie + token body.
 */
const { authenticate } = require('../_lib/users');
const { signJwt, setAuthCookie } = require('../_lib/jwt');
const {
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} = require('../_lib/rate-limit');
const { applySecurityHeaders } = require('../_lib/security');

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
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    res.status(429).json({
      error: 'Too many login attempts. Try again later.',
      retryAfterSec: limit.retryAfterSec,
    });
    return;
  }

  const body = parseBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) {
    recordLoginFailure(ip);
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const user = authenticate(username, password);
  if (!user) {
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
      ...user,
      role: user.role,
      token,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Session signing failed.',
    });
  }
};
