/**
 * POST /api/auth/change-password
 */
const { getUserByUsername, changePassword } = require('../../_lib/db');
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
  if (body.new_password !== body.confirm_password) {
    res.status(400).json({ success: false, error: 'New passwords do not match.' });
    return;
  }
  try {
    await changePassword(user.id, body.current_password, body.new_password);
    res.status(200).json({ success: true, status: 'ok' });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update password.',
    });
  }
};
