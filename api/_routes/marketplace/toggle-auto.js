/**
 * POST /api/marketplace/toggle-auto
 * GET  /api/marketplace/toggle-auto (read current auto-publish flag)
 *
 * Toggles or reads the Marketplace Hub auto-publish schedule status.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const { getAutoPublish, setAutoPublish } = require('../../_lib/marketplace');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json(await getAutoPublish());
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const body = parseBody(req);
    let enabled;
    if (typeof body.enabled === 'boolean') {
      enabled = body.enabled;
    } else if (typeof body.auto_publish === 'boolean') {
      enabled = body.auto_publish;
    } else if (typeof body.on === 'boolean') {
      enabled = body.on;
    } else if (body.toggle === true || body.toggle === 'toggle') {
      enabled = !(await getAutoPublish()).auto_publish;
    } else {
      // Default: toggle
      enabled = !(await getAutoPublish()).auto_publish;
    }
    const payload = await setAutoPublish(Boolean(enabled));
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/marketplace/toggle-auto]', err);
    res.status(Number(err?.status) || 500).json({
      success: false,
      error: err.message || 'Failed to toggle auto-publish.',
    });
  }
};
