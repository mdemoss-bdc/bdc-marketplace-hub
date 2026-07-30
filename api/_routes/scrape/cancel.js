/**
 * POST /api/scrape/cancel | /api/sync/cancel
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const { requestCancel, statusPayload } = require('../../_lib/inventory-sync');
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

  if (req.method !== 'POST') {
    res.status(405).json({
      error: 'Use POST with session_id (or rely on active user context).',
    });
    return;
  }

  try {
    const userId = await resolveUserId(req);
    const body = parseBody(req);
    const sessionId = String(body.session_id || '').trim();
    requestCancel(userId, sessionId);
    res.status(200).json({
      success: true,
      message: 'Cancel requested.',
      ...(await statusPayload(userId)),
    });
  } catch (err) {
    console.error('[api/scrape/cancel]', err);
    res.status(500).json({ success: false, error: err.message || 'Cancel failed.' });
  }
};
