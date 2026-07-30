/**
 * Meta / Facebook OAuth helpers for Vercel serverless + local Express.
 *
 * Flow:
 *  1. /api/auth/facebook → Meta dialog (signed state carries user id)
 *  2. /api/auth/facebook/callback → code → short-lived → long-lived user token
 *  3. Fetch Pages + Catalogs → persist Page ID, Catalog ID, Page Access Token
 */
const crypto = require('node:crypto');
const { randomHex } = require('./random-token');

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;
const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'catalog_management',
].join(',');

function appCredentials() {
  const appId = (
    process.env.FACEBOOK_APP_ID ||
    process.env.META_APP_ID ||
    process.env.FB_APP_ID ||
    ''
  ).trim();
  const appSecret = (
    process.env.FACEBOOK_APP_SECRET ||
    process.env.META_APP_SECRET ||
    process.env.FB_APP_SECRET ||
    ''
  ).trim();
  return { appId, appSecret };
}

function isConfigured() {
  const { appId, appSecret } = appCredentials();
  return Boolean(appId && appSecret);
}

function stateSecret() {
  return (
    process.env.AUTH_SESSION_SECRET ||
    process.env.FACEBOOK_APP_SECRET ||
    process.env.META_APP_SECRET ||
    process.env.ADMIN_PASSWORD ||
    process.env.DASHBOARD_PASSWORD ||
    'bdc-facebook-oauth'
  );
}

function publicBaseUrl(req) {
  const fromEnv = (process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (process.env.VERCEL_URL) {
    const host = String(process.env.VERCEL_URL).replace(/^https?:\/\//, '');
    return `https://${host}`;
  }
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost:5173')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function redirectUri(req) {
  const override = (process.env.FACEBOOK_REDIRECT_URI || process.env.META_REDIRECT_URI || '').trim();
  if (override) return override;
  return `${publicBaseUrl(req)}/api/auth/facebook/callback`;
}

/** HMAC-signed state: `{userId}.{nonce}.{sig}` — survives cold starts. */
function makeState(userId) {
  const uid = String(Number(userId) || 0);
  const nonce = randomHex(16);
  const body = `${uid}.${nonce}`;
  const sig = crypto.createHmac('sha256', stateSecret()).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verifyState(state) {
  const raw = String(state || '');
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [uid, nonce, sig] = parts;
  if (!uid || !nonce || !sig) return null;
  const body = `${uid}.${nonce}`;
  const expected = crypto.createHmac('sha256', stateSecret()).update(body).digest('hex');
  try {
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  const userId = Number(uid);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

function buildAuthUrl(req, userId) {
  const { appId } = appCredentials();
  if (!appId) throw new Error('FACEBOOK_APP_ID / META_APP_ID is not configured.');
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(req),
    state: makeState(userId),
    scope: SCOPES,
    response_type: 'code',
    auth_type: 'rerequest',
  });
  return `${DIALOG}?${params.toString()}`;
}

async function graphGet(path, accessToken, params = {}) {
  const url = new URL(path.startsWith('http') ? path : `${GRAPH}${path}`);
  url.searchParams.set('access_token', accessToken);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `Graph API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.graph = data.error;
    throw err;
  }
  return data;
}

async function exchangeCodeForToken(req, code) {
  const { appId, appSecret } = appCredentials();
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('code', code);
  const res = await fetch(url.toString(), { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data?.error?.message || 'Failed to exchange Facebook authorization code.');
  }
  return data;
}

async function exchangeForLongLivedUserToken(shortLivedToken) {
  const { appId, appSecret } = appCredentials();
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', shortLivedToken);
  const res = await fetch(url.toString(), { method: 'GET' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data?.error?.message || 'Failed to obtain long-lived Facebook user token.');
  }
  return data;
}

async function fetchPages(userAccessToken) {
  const data = await graphGet('/me/accounts', userAccessToken, {
    fields: 'id,name,access_token,tasks',
    limit: '100',
  });
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchCatalogs(userAccessToken) {
  const catalogs = [];
  try {
    const businesses = await graphGet('/me/businesses', userAccessToken, {
      fields: 'id,name',
      limit: '50',
    });
    for (const biz of businesses.data || []) {
      try {
        const owned = await graphGet(`/${biz.id}/owned_product_catalogs`, userAccessToken, {
          fields: 'id,name',
          limit: '50',
        });
        for (const cat of owned.data || []) {
          catalogs.push({
            id: String(cat.id),
            name: String(cat.name || ''),
            business_id: String(biz.id),
            business_name: String(biz.name || ''),
          });
        }
      } catch (err) {
        console.warn('[facebook] owned_product_catalogs', biz.id, err.message || err);
      }
    }
  } catch (err) {
    console.warn('[facebook] me/businesses', err.message || err);
  }

  // Fallback: client-owned catalogs on the user node (when available).
  if (!catalogs.length) {
    try {
      const owned = await graphGet('/me/owned_product_catalogs', userAccessToken, {
        fields: 'id,name',
        limit: '50',
      });
      for (const cat of owned.data || []) {
        catalogs.push({
          id: String(cat.id),
          name: String(cat.name || ''),
          business_id: '',
          business_name: '',
        });
      }
    } catch (err) {
      console.warn('[facebook] me/owned_product_catalogs', err.message || err);
    }
  }

  return catalogs;
}

/**
 * Complete OAuth: exchange code, pick primary Page + Catalog, return persist payload.
 */
async function completeOAuth(req, code) {
  const short = await exchangeCodeForToken(req, code);
  let userToken = short.access_token;
  let expiresIn = Number(short.expires_in) || 0;
  try {
    const longLived = await exchangeForLongLivedUserToken(short.access_token);
    userToken = longLived.access_token;
    expiresIn = Number(longLived.expires_in) || expiresIn;
  } catch (err) {
    console.warn('[facebook] long-lived exchange failed — using short-lived token', err.message || err);
  }

  const pages = await fetchPages(userToken);
  if (!pages.length) {
    const err = new Error(
      'No Facebook Pages found for this account. Grant Pages access and try again.',
    );
    err.code = 'no_pages';
    throw err;
  }

  const page = pages[0];
  const catalogs = await fetchCatalogs(userToken);
  const catalog = catalogs[0] || null;

  return {
    fb_user_access_token: userToken,
    fb_user_token_expires_in: expiresIn,
    fb_page_id: String(page.id || ''),
    fb_page_name: String(page.name || ''),
    fb_access_token: String(page.access_token || userToken),
    commerce_catalog_id: catalog ? String(catalog.id) : '',
    fb_catalog_name: catalog ? String(catalog.name) : '',
    pages: pages.map((p) => ({ id: p.id, name: p.name })),
    catalogs,
  };
}

module.exports = {
  SCOPES,
  appCredentials,
  isConfigured,
  publicBaseUrl,
  redirectUri,
  makeState,
  verifyState,
  buildAuthUrl,
  exchangeCodeForToken,
  exchangeForLongLivedUserToken,
  fetchPages,
  fetchCatalogs,
  completeOAuth,
};
