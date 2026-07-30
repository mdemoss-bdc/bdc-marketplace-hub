/**
 * POST /api/user/recovery-id/regenerate
 */
const { getUserByUsername, regenerateRecoveryId } = require('../../../_lib/db');
const { applySecurityHeaders } = require('../../../_lib/security');
const { requireAuthUser } = require('../../../_lib/http');

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
  try {
    const updated = await regenerateRecoveryId(user.id);
    res.status(200).json({
      success: true,
      status: 'ok',
      recovery_id: updated.recovery_id,
      user: updated,
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : 'Failed to regenerate Recovery ID.',
    });
  }
};
