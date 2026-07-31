/**
 * POST /api/v1/marketplace/queue/generate
 * Build today's Hub posting_queue (up to 10 vehicles, 8 AM–9 PM).
 */
const { applySecurityHeaders } = require('../../../../_lib/security');
const { parseBody, requireAuthUser } = require('../../../../_lib/http');
const { generateDailyPostingQueue } = require('../../../../_lib/marketplace');
const { getUserByUsername } = require('../../../../_lib/db');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  const user = await requireAuthUser(req, res, getUserByUsername);
  if (!user) return;

  const body = parseBody(req);
  const force = Boolean(body.force);
  const date = typeof body.date === 'string' ? body.date : '';

  try {
    const payload = await generateDailyPostingQueue(user.id, { date, force });
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/v1/marketplace/queue/generate]', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to generate posting queue.',
      message: err.message || 'Failed to generate posting queue.',
    });
  }
};
