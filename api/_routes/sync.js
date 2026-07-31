/**
 * POST /api/sync | /api/scrape | /api/v1/sync | /api/v1/scrape
 * Triggers dealership inventory scrape → Neon marketplace_inventory.
 * Uses Target URLs from Marketplace settings (or request body overrides).
 */
const { applySecurityHeaders } = require('../_lib/security');
const { parseBody } = require('../_lib/http');
const { startInventorySync } = require('../_lib/inventory-sync');
const { getUserByUsername } = require('../_lib/db');
const { verifyJwt, getTokenFromRequest } = require('../_lib/jwt');

async function resolveUserId(req) {
  try {
    const token = getTokenFromRequest(req);
    const payload = verifyJwt(token);
    if (payload?.sub) {
      const user = await getUserByUsername(payload.sub);
      if (user?.id) return Number(user.id) || 0;
    }
  } catch {
    /* public/local sync falls back to user 0 */
  }
  return 0;
}

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    const userId = await resolveUserId(req);
    const body = parseBody(req);
    const payload = await startInventorySync(userId, {
      inventory_url_used: body.inventory_url_used || body.url_used || body.used_url,
      inventory_url_new: body.inventory_url_new || body.url_new || body.new_url,
      inventory_locations: body.inventory_locations,
      dealer_name: body.dealer_name,
    });
    const statusCode = payload.status === 'error' ? 400 : 200;
    res.status(statusCode).json(payload);
  } catch (err) {
    console.error('[api/sync]', err);
    res.status(500).json({
      status: 'error',
      success: false,
      error: err.message || 'Inventory sync failed.',
      message: err.message || 'Inventory sync failed.',
      count: 0,
    });
  }
};
