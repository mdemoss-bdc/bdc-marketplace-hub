/**
 * GET /api/leads — Lead Center board for the BDC Marketplace Hub.
 * Response: { leads: Lead[], total: number }
 */
const { applySecurityHeaders } = require('../_lib/security');
const {
  getLeadsSafe,
  emptyLeadsPayload,
  resolveTenantScope,
} = require('../_lib/leads');

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
    const source = url.searchParams.get('source') || undefined;
    const slaOnly = ['1', 'true', 'yes'].includes(
      (url.searchParams.get('sla_only') || '0').toLowerCase(),
    );
    const organizationId = await resolveTenantScope(req);
    const payload = await getLeadsSafe({
      status,
      source,
      sla_only: slaOnly,
      organization_id: organizationId,
    });
    res.status(200).json(payload);
  } catch (err) {
    console.error('[api/leads]', err);
    res.status(200).json(emptyLeadsPayload());
  }
};
