/**
 * POST /api/inventory/parse | /api/inventory/sanitize
 * Also aliases under /api/marketplace/parse for the Hub.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const {
  parseInventoryText,
  sanitizeInventoryList,
  sanitizeVehicleRecord,
} = require('../../_lib/inventoryParser');

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
  const path = String(req.path || req.url || '').split('?')[0];

  if (path.endsWith('/sanitize')) {
    const rows = Array.isArray(body.inventory)
      ? body.inventory
      : Array.isArray(body.vehicles)
        ? body.vehicles
        : Array.isArray(body)
          ? body
          : null;
    if (!rows) {
      res.status(400).json({
        success: false,
        error: 'Provide inventory/vehicles array in the JSON body.',
      });
      return;
    }
    const inventory = sanitizeInventoryList(rows);
    res.status(200).json({ success: true, inventory, count: inventory.length });
    return;
  }

  const raw =
    typeof body.raw === 'string'
      ? body.raw
      : typeof body.text === 'string'
        ? body.text
        : typeof body.html === 'string'
          ? body.html
          : '';

  if (!String(raw).trim()) {
    res.status(400).json({
      success: false,
      error: 'raw, text, or html body field is required.',
    });
    return;
  }

  const parsed = parseInventoryText(raw);
  const vehicle =
    body.vehicle && typeof body.vehicle === 'object'
      ? sanitizeVehicleRecord(body.vehicle, raw)
      : sanitizeVehicleRecord(parsed, raw);

  res.status(200).json({ success: true, parsed, vehicle });
};
