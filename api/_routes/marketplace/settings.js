/**
 * GET/POST /api/marketplace/settings
 * Persists Inventory Scraper Target URLs for dynamic sync.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const {
  getScraperSettings,
  saveScraperSettings,
} = require('../../_lib/scraper-settings');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const settings = await getScraperSettings();
      res.status(200).json({ success: true, ...settings });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      const body = parseBody(req);
      const saved = await saveScraperSettings(body);
      res.status(200).json({
        success: true,
        ...saved,
        sync_triggered: false,
        message: 'Settings saved.',
      });
      return;
    }

    res.status(405).json({ success: false, error: 'Method not allowed.' });
  } catch (err) {
    console.error('[api/marketplace/settings]', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to load/save settings.',
    });
  }
};
