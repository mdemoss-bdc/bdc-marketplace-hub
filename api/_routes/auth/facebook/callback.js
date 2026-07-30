/**
 * GET /api/auth/facebook/callback
 *
 * Exchanges the Meta authorization code for a long-lived User Access Token,
 * loads Pages + Catalogs, and persists the selected Page / Catalog / Page
 * Access Token on the Neon users row identified by the signed OAuth state.
 */
const { applySecurityHeaders } = require('../../../_lib/security');
const { getUserById, saveFacebookConnection } = require('../../../_lib/db');
const {
  isConfigured,
  verifyState,
  completeOAuth,
  publicBaseUrl,
} = require('../../../_lib/facebook-oauth');

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

  const base = publicBaseUrl(req);
  const fail = (reason) => {
    res.redirect(302, `${base}/settings?facebook=error&reason=${encodeURIComponent(reason)}`);
  };

  if (!isConfigured()) {
    fail('not_configured');
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const oauthError = url.searchParams.get('error') || '';

    if (oauthError) {
      fail(oauthError === 'access_denied' ? 'access_denied' : 'oauth_error');
      return;
    }
    if (!code || !state) {
      fail('missing_code');
      return;
    }

    const userId = verifyState(state);
    if (!userId) {
      fail('state_mismatch');
      return;
    }

    const user = await getUserById(userId);
    if (!user) {
      fail('unknown_user');
      return;
    }

    const connection = await completeOAuth(req, code);
    await saveFacebookConnection(userId, connection);

    console.log(
      '[facebook] connected',
      `user_id=${userId}`,
      `page=${connection.fb_page_id}`,
      `catalog=${connection.commerce_catalog_id || '(none)'}`,
    );

    res.redirect(302, `${base}/settings?facebook=connected`);
  } catch (err) {
    console.error('[api/auth/facebook/callback]', err);
    fail(err.code || 'token_exchange');
  }
};
