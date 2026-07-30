/**
 * GET /api/sync/status | /api/scrape/status
 * Progress payload for the Marketplace Hub sync poller.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { statusPayload } = require('../../_lib/inventory-sync');
const { getUserByUsername } = require('../../_lib/db');
const { verifyJwt, getTokenFromRequest } = require('../../_lib/jwt');

async function resolveUserId(req) {
  try {
    const token = getTokenFromRequest(req);
    const payload = verifyJwt(token);
    if (payload?.sub) {
      const user = await getUserByUsername(payload.sub);
      if (user?.id) return Number(user.id) || 0;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const userId = await resolveUserId(req);
    res.status(200).json(await statusPayload(userId));
  } catch (err) {
    console.error('[api/sync/status]', err);
    res.status(200).json({
      syncing: false,
      phase: 'idle',
      synced: 0,
      total: 0,
      enriched: 0,
      done: true,
      error: err.message || 'status unavailable',
      reason: 'error',
      last_sync: '',
      vehicle_count: 0,
      user_id: 0,
      session_id: '',
      cancel_status: '',
    });
  }
};
