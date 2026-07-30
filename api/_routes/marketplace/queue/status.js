/**
 * POST /api/marketplace/queue/status
 * Pause / resume / mark failed on a publisher queue row.
 */
const { applySecurityHeaders } = require('../../../_lib/security');
const { parseBody } = require('../../../_lib/http');
const { setQueueStatus } = require('../../../_lib/marketplace');

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
  const id = body.id ?? body.item_id;
  const status = String(body.status || '').trim();
  if (!id || !status) {
    res.status(400).json({ success: false, error: 'id and status are required.' });
    return;
  }

  try {
    const payload = setQueueStatus({
      id,
      status,
      error_message: body.error_message || '',
    });
    res.status(200).json(payload);
  } catch (err) {
    const code = Number(err?.status) || 500;
    res.status(code >= 400 && code < 600 ? code : 500).json({
      success: false,
      error: err.message || 'Status update failed.',
    });
  }
};
