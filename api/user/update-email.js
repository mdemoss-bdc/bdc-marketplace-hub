/**
 * POST /api/user/update-email
 */
const { getUserByUsername, updateEmail } = require('../_lib/db');
const { applySecurityHeaders } = require('../_lib/security');
const { parseBody, requireAuthUser } = require('../_lib/http');

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
  const user = requireAuthUser(req, res, getUserByUsername);
  if (!user) return;
  const body = parseBody(req);
  try {
    const updated = updateEmail(
      user.id,
      body.new_email || body.email,
      body.current_password,
    );
    res.status(200).json({
      success: true,
      status: 'ok',
      user: updated,
      message: 'Email updated.',
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update email.',
    });
  }
};
