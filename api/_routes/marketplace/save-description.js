/**
 * POST /api/marketplace/save-description
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const { saveVehicleAiDescription } = require('../../_lib/marketplace');

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
  try {
    const payload = await saveVehicleAiDescription(
      body.vin,
      body.ai_description || body.description,
    );
    res.status(200).json(payload);
  } catch (err) {
    const code = Number(err?.status) || 500;
    res.status(code >= 400 && code < 600 ? code : 500).json({
      success: false,
      error: err.message || 'Failed to save description.',
    });
  }
};
