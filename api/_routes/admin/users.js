/**
 * GET /api/admin/users
 * Admin-only directory loaded from the persistent users table (Postgres when
 * DATABASE_URL is set). No passwords.
 */
const {
  getUserByUsername,
  requireRole,
  adminDirectoryUsers,
} = require('../../_lib/users');
const { verifyJwt, getTokenFromRequest } = require('../../_lib/jwt');
const { applySecurityHeaders } = require('../../_lib/security');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const token = getTokenFromRequest(req);
  const payload = verifyJwt(token);
  if (!payload) {
    res.status(401).json({ error: 'Authorization required.' });
    return;
  }

  const user = await getUserByUsername(payload.sub);
  const effective = user
    ? { ...user, role: user.role || payload.role }
    : {
        username: payload.sub,
        role: payload.role,
        is_admin: payload.is_admin,
        is_master_admin: payload.is_master_admin,
      };

  if (!requireRole(effective, ['Admin'])) {
    res.status(403).json({ error: 'Admin role required.' });
    return;
  }

  res.status(200).json({ users: await adminDirectoryUsers() });
};
