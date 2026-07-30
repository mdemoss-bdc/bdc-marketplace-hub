/**
 * GET    /api/auth/facebook — start Meta OAuth (redirect or JSON auth_url)
 * DELETE /api/auth/facebook — disconnect / clear stored Page + Catalog tokens
 */
const { applySecurityHeaders } = require('../../_lib/security');
const { getUserByUsername, clearFacebookConnection } = require('../../_lib/db');
const { verifyJwt, getTokenFromRequest } = require('../../_lib/jwt');
const { requireAuthUser } = require('../../_lib/http');
const {
  isConfigured,
  buildAuthUrl,
  appCredentials,
  publicBaseUrl,
} = require('../../_lib/facebook-oauth');

module.exports = async function handler(req, res) {
  applySecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'DELETE') {
    const user = await requireAuthUser(req, res, getUserByUsername);
    if (!user) return;
    try {
      await clearFacebookConnection(user.id);
      res.status(200).json({ success: true, facebook_connected: false });
    } catch (err) {
      console.error('[api/auth/facebook disconnect]', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Failed to disconnect Facebook.',
      });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }

  if (!isConfigured()) {
    const { appId, appSecret } = appCredentials();
    const missing = [
      !appId && 'FACEBOOK_APP_ID (or META_APP_ID)',
      !appSecret && 'FACEBOOK_APP_SECRET (or META_APP_SECRET)',
    ].filter(Boolean);
    res.status(503).json({
      success: false,
      error: 'not_configured',
      message: 'Facebook / Meta App credentials are not configured on this deployment.',
      missing_secrets: missing,
    });
    return;
  }

  const token = getTokenFromRequest(req);
  const payload = verifyJwt(token);
  if (!payload?.sub) {
    const base = publicBaseUrl(req);
    res.redirect(302, `${base}/login?next=${encodeURIComponent('/settings')}`);
    return;
  }

  const user = await getUserByUsername(payload.sub);
  if (!user?.id) {
    res.status(401).json({ success: false, error: 'Authorization required.' });
    return;
  }

  try {
    const authUrl = buildAuthUrl(req, user.id);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const wantsJson =
      url.searchParams.get('format') === 'json' ||
      String(req.headers.accept || '').includes('application/json');

    if (wantsJson) {
      res.status(200).json({
        success: true,
        auth_url: authUrl,
        scopes: [
          'pages_show_list',
          'pages_read_engagement',
          'pages_manage_posts',
          'catalog_management',
        ],
      });
      return;
    }

    res.redirect(302, authUrl);
  } catch (err) {
    console.error('[api/auth/facebook]', err);
    res.status(500).json({
      success: false,
      error: err.message || 'Failed to start Facebook OAuth.',
    });
  }
};
