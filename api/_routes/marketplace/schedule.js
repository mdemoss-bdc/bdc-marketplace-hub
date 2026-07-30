/**
 * POST /api/marketplace/schedule
 * Schedule or instantly publish a vehicle to the Marketplace queue.
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { parseBody } = require('../../_lib/http');
const { scheduleVehicle, emptyPublisherQueue } = require('../../_lib/marketplace');

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
    const payload = await scheduleVehicle({
      vin: body.vin,
      ai_description: body.ai_description,
      publish_now: Boolean(body.publish_now || body.post_now || body.instant),
      scheduled_time: body.scheduled_time || null,
    });
    res.status(200).json(payload);
  } catch (err) {
    const status = Number(err?.status) || 500;
    console.error('[api/marketplace/schedule]', err);
    if (status === 429) {
      res.status(429).json({
        success: false,
        error: err.message || 'Daily cap reached.',
        quota: err.quota || emptyPublisherQueue().quota,
      });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: err.message || 'Scheduling failed.',
    });
  }
};
