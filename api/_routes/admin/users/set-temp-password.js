/**
 * POST /api/admin/users/set-temp-password
 * Admin Console: assign a temporary password that forces reset on next login.
 */
const { getUserByUsername } = require('../../../_lib/users');
const { adminSetPassword } = require('../../../_lib/db');
const { applySecurityHeaders } = require('../../../_lib/security');
const { parseBody, requireAuthUser } = require('../../../_lib/http');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.', success: false });
    return;
  }

  const actor = await requireAuthUser(req, res, getUserByUsername);
  if (!actor) return;

  const body = parseBody(req);
  const userId = Number(body.user_id || body.id || 0);
  const newPassword = String(
    body.temporary_password || body.new_password || body.password || '',
  );

  try {
    const user = await adminSetPassword(actor, userId, newPassword, { temporary: true });
    res.status(200).json({
      success: true,
      user_id: user.id,
      username: user.username,
      must_change_password: true,
      message: 'Temporary password set. User must change it on next login.',
    });
  } catch (err) {
    const status = Number(err?.statusCode) || 400;
    res.status(status).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to set temporary password.',
    });
  }
};
