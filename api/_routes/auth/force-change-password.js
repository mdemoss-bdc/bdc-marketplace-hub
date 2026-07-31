/**
 * POST /api/auth/force-change-password
 * Completes a mandatory password change after temporary-password login.
 */
const { getUserByUsername } = require('../../_lib/users');
const { forceChangePassword } = require('../../_lib/db');
const { signJwt, setAuthCookie } = require('../../_lib/jwt');
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody, requireAuthUser } = require('../../_lib/http');

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

  const user = await requireAuthUser(req, res, getUserByUsername);
  if (!user) return;

  const body = parseBody(req);
  const newPassword = String(body.new_password || '');
  const confirmPassword = String(body.confirm_password || '');
  if (newPassword !== confirmPassword) {
    res.status(400).json({ success: false, error: 'New passwords do not match.' });
    return;
  }

  try {
    const updated = await forceChangePassword(user.id, newPassword);
    const token = signJwt({
      sub: updated.username,
      id: updated.id,
      role: updated.role,
      is_admin: updated.is_admin,
      is_master_admin: updated.is_master_admin,
      must_change_password: false,
    });
    setAuthCookie(res, token);
    res.status(200).json({
      success: true,
      ...updated,
      token,
      must_change_password: false,
      requirePasswordChange: false,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to change password.',
    });
  }
};
