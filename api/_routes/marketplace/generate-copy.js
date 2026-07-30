/**
 * POST /api/marketplace/generate-copy
 * Lightweight listing-copy stub so the Hub never receives HTML 404 on Vercel.
 * When inventory is available, builds a template description from the row.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const { getInventoryByVin, getLatestQueueCopy } = require('../../_lib/marketplace');

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
  const vin = String(body.vin || '').trim().toUpperCase();
  if (!vin) {
    res.status(400).json({ success: false, error: 'vin is required.' });
    return;
  }

  try {
    const queueRow = await getLatestQueueCopy(vin);
    if (queueRow?.ai_description) {
      res.status(200).json({
        success: true,
        ai_description: queueRow.ai_description,
        source: 'queue',
      });
      return;
    }

    const vehicle = await getInventoryByVin(vin);
    if (!vehicle) {
      res.status(404).json({ success: false, error: `VIN ${vin} not found in inventory` });
      return;
    }

    const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
      .filter(Boolean)
      .join(' ');
    const price = Number(vehicle.price) || 0;
    const miles = Number(vehicle.mileage) || 0;
    const desc = [
      title,
      price ? `Asking $${price.toLocaleString()}` : null,
      miles ? `${miles.toLocaleString()} miles` : null,
      vehicle.exterior_color ? `${vehicle.exterior_color} exterior` : null,
      vehicle.ai_description || null,
      'Message us to schedule a test drive today!',
    ]
      .filter(Boolean)
      .join('\n');

    res.status(200).json({
      success: true,
      ai_description: desc,
      source: vehicle.ai_description ? 'inventory' : 'template',
    });
  } catch (err) {
    console.error('[api/marketplace/generate-copy]', err);
    res.status(500).json({ success: false, error: 'Copy generation failed.' });
  }
};
