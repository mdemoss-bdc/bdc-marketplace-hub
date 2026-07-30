/**
 * POST /api/user/update-phone
 */
const { getUserByUsername, updatePhone } = require('../../_lib/db');
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
  try {
    const updated = await updatePhone(user.id, body.phone || '');
    res.status(200).json({ success: true, status: 'ok', user: updated });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to save phone.',
    });
  }
};
