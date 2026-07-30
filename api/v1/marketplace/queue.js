/**
 * GET /api/v1/marketplace/queue
 * Daily posting queue used by the Hub "Posting Queue" tab.
 * Auth is optional — unauthenticated callers get an empty queue JSON payload
 * (never HTML) so the Hub JSON parser never crashes.
 */
const { applySecurityHeaders } = require('../../../_lib/security');
const { getDailyPostingQueue } = require('../../../_lib/marketplace');
const { getUserByUsername } = require('../../../_lib/db');
const { verifyJwt, getTokenFromRequest } = require('../../../_lib/jwt');

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

  let userId = 0;
  try {
    const token = getTokenFromRequest(req);
    const payload = verifyJwt(token);
    if (payload?.sub) {
      const user = getUserByUsername(payload.sub);
      if (user) userId = user.id;
    }
  } catch {
    userId = 0;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const date = url.searchParams.get('date') || '';
  res.status(200).json(getDailyPostingQueue(userId, date));
};
