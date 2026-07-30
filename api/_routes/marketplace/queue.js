/**
 * GET /api/marketplace/queue
 * Returns the Facebook Marketplace publisher queue as JSON.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { getPublisherQueue, emptyPublisherQueue } = require('../../_lib/marketplace');

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
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const status = url.searchParams.get('status') || undefined;
    const payload = await getPublisherQueue(status);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/marketplace/queue]', err);
    res.status(200).json(emptyPublisherQueue());
  }
};
