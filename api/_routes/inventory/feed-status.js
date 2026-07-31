/**
 * POST /api/v1/marketplace/posting
 * POST /api/inventory/feed-status
 *
 * Toggle Meta catalog feed membership ("Add to Feed" / "Remove from Feed").
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const { setFeedStatus } = require('../../_lib/marketplace');

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

  const body = parseBody(req);
  const vins = body.vins || (body.vin ? [body.vin] : []);
  try {
    const payload = await setFeedStatus({
      vins,
      action: body.action,
      in_meta_feed:
        typeof body.in_meta_feed === 'boolean'
          ? body.in_meta_feed
          : typeof body.inMetaFeed === 'boolean'
            ? body.inMetaFeed
            : undefined,
    });
    res.status(200).json(payload);
  } catch (err) {
    const code = Number(err?.status) || 500;
    console.error('[api/inventory/feed-status]', err);
    res.status(code >= 400 && code < 600 ? code : 500).json({
      success: false,
      error: err.message || 'Feed status update failed.',
    });
  }
};
