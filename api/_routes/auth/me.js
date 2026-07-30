/**
 * GET/POST /api/auth/me
 * Validates JWT from cookie or Authorization Bearer.
 */
const { getUserByUsername } = require('../../_lib/users');
const { verifyJwt, getTokenFromRequest } = require('../../_lib/jwt');
const { applySecurityHeaders } = require('../../_lib/security');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const token = getTokenFromRequest(req);
  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ error: 'Authorization required.' });
    return;
  }

  const user = getUserByUsername(payload.sub);
  if (!user) {
    res.status(401).json({ error: 'Authorization required.' });
    return;
  }

  // Prefer live profile; keep JWT role claims if profile missing role
  res.status(200).json({
    ...user,
    role: user.role || payload.role,
    is_admin: user.is_admin,
    is_master_admin: user.is_master_admin,
  });
};
