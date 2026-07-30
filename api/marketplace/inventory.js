/**
 * GET /api/marketplace/inventory
 * Returns scraped marketplace inventory as JSON.
 */
const { applySecurityHeaders } = require('../_lib/security');
const { listInventory, emptyInventory } = require('../_lib/marketplace');

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
    const query = Object.fromEntries(url.searchParams.entries());
    const payload = listInventory(query);
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/marketplace/inventory]', err);
    res.status(200).json(emptyInventory());
  }
};
