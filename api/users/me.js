/**
 * GET/PUT/POST /api/users/me
 * Read or update the authenticated user's profile (phone, email).
 */
const {
  getUserByUsername,
  updateProfile,
} = require('../_lib/db');
const { applySecurityHeaders } = require('../_lib/security');
const { parseBody, requireAuthUser } = require('../_lib/http');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const user = requireAuthUser(req, res, getUserByUsername);
  if (!user) return;

  if (req.method === 'GET') {
    res.status(200).json({ success: true, user, phone: user.phone || '' });
    return;
  }

  if (req.method !== 'PUT' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.', success: false });
    return;
  }

  const body = parseBody(req);
  try {
    const updated = updateProfile(user.id, {
      phone: body.phone,
      email: body.email,
      new_email: body.new_email,
      current_password: body.current_password,
    });
    res.status(200).json({
      success: true,
      user: updated,
      message: body.new_email || body.email
        ? 'Profile updated.'
        : 'Phone number saved.',
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to update profile.',
    });
  }
};
