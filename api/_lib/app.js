/**
 * Express app shared by the Vercel serverless entry (api/index.js).
 *
 * Routes are mounted both with and without the `/api` prefix so requests still
 * match when a rewrite strips or preserves the prefix.
 */
const express = require('express');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Warm persistent Postgres schema + baseline team accounts on cold start.
try {
  const { openDb, ensureSeeded, backend } = require('./db');
  Promise.resolve(openDb())
    .then(async () => {
      if (typeof ensureSeeded === 'function') {
        await ensureSeeded();
      }
      console.log(
        `[api] auth store ready (${backend}) — baseline accounts: mdemoss, jdemoss, testreviewer`,
      );
    })
    .catch((err) => console.error('[api] auth store warm failed:', err.message || err));
} catch (err) {
  console.warn('[api] auth store warm skipped:', err.message || err);
}
try {
  const { openMarketplaceDb } = require('./marketplace');
  Promise.resolve(openMarketplaceDb())
    .then(() => console.log('[api] marketplace store ready (postgresql)'))
    .catch((err) => console.error('[api] marketplace warm failed:', err.message || err));
} catch (err) {
  console.warn('[api] marketplace warm skipped:', err.message || err);
}

/**
 * Restore the original /api/... path after Vercel rewrites
 * `/api/auth/login` → `/api/index?__route=auth/login`.
 */
app.use((req, _res, next) => {
  try {
    const url = new URL(req.url || '/', 'http://local');
    const routed = url.searchParams.get('__route');
    if (routed) {
      url.searchParams.delete('__route');
      const qs = url.searchParams.toString();
      const pathPart = routed.startsWith('/') ? routed.slice(1) : routed;
      req.url = `/api/${pathPart}${qs ? `?${qs}` : ''}`;
    }
  } catch {
    /* keep req.url */
  }

  const candidates = [
    req.headers['x-invoke-path'],
    req.headers['x-forwarded-uri'],
    req.headers['x-vercel-original-path'],
    req.headers['x-matched-path'],
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    if (!raw.includes('auth') && !raw.startsWith('/api')) continue;
    if (raw.startsWith('/api/') || raw === '/api') {
      req.url = raw;
      break;
    }
    if (raw.startsWith('/auth/') || raw.startsWith('/users/') || raw.startsWith('/marketplace/')) {
      req.url = `/api${raw}`;
      break;
    }
  }

  const current = req.url || '/';
  if (!current.startsWith('/api') && current !== '/') {
    const q = current.includes('?') ? current.slice(current.indexOf('?')) : '';
    const p = current.split('?')[0] || '/';
    if (p === '/index' || p === '/api/index') {
      req.url = `/api${q}`;
    } else if (p && p !== '/') {
      req.url = `/api${p.startsWith('/') ? p : `/${p}`}${q}`;
    }
  }
  next();
});

function wrap(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error('[api]', err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: err instanceof Error ? err.message : 'Internal server error.',
        });
      }
    });
  };
}

/** Mount the same handler on `/api/...` and bare `/...` paths. */
function mount(apiPath, handler) {
  const wrapped = wrap(handler);
  app.all(apiPath, wrapped);
  if (apiPath.startsWith('/api/')) {
    app.all(apiPath.slice(4), wrapped); // /auth/login etc.
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
mount('/api/auth/login', require('../_routes/auth/login'));
mount('/api/auth/logout', require('../_routes/auth/logout'));
mount('/api/auth/me', require('../_routes/auth/me'));
mount('/api/auth/register', require('../_routes/auth/register'));
mount('/api/auth/signup', require('../_routes/auth/register'));
mount('/api/auth/change-password', require('../_routes/auth/change-password'));
mount('/api/auth/smtp-verify', require('../_routes/auth/smtp-verify'));
mount('/api/auth/facebook/callback', require('../_routes/auth/facebook/callback'));
mount('/api/auth/facebook', require('../_routes/auth/facebook'));

// ── Users / profile ─────────────────────────────────────────────────────────
mount('/api/users/me', require('../_routes/users/me'));
mount('/api/users/update-profile', require('../_routes/users/update-profile'));
mount('/api/user/update-email', require('../_routes/user/update-email'));
mount('/api/user/update-phone', require('../_routes/user/update-phone'));
mount('/api/user/recovery-id/regenerate', require('../_routes/user/recovery-id/regenerate'));

// ── Admin ───────────────────────────────────────────────────────────────────
mount('/api/admin/users', require('../_routes/admin/users'));

// ── Inventory sync / scrape (Marketplace Hub "Sync All Inventory") ──────────
mount('/api/sync/status', require('../_routes/sync/status'));
mount('/api/scrape/status', require('../_routes/sync/status'));
mount('/api/v1/sync/status', require('../_routes/sync/status'));
mount('/api/v1/scrape/status', require('../_routes/sync/status'));
mount('/api/scrape/cancel', require('../_routes/scrape/cancel'));
mount('/api/sync/cancel', require('../_routes/scrape/cancel'));
mount('/api/v1/scrape/cancel', require('../_routes/scrape/cancel'));
mount('/api/v1/sync/cancel', require('../_routes/scrape/cancel'));
mount('/api/sync', require('../_routes/sync'));
mount('/api/scrape', require('../_routes/sync'));
mount('/api/v1/sync', require('../_routes/sync'));
mount('/api/v1/scrape', require('../_routes/sync'));

// ── TikTok URL Property Verification (plain text at site root) ──────────────
const tiktokVerify = require('../_routes/tiktok-developers-site-verification');
mount('/tiktok-developers-site-verification.txt', tiktokVerify);
mount('/tiktok-developers-site-verification', tiktokVerify);
mount('/api/tiktok-developers-site-verification.txt', tiktokVerify);
mount('/api/tiktok-developers-site-verification', tiktokVerify);

// ── Marketplace publisher / inventory ───────────────────────────────────────
mount('/api/marketplace/queue/status', require('../_routes/marketplace/queue/status'));
mount('/api/marketplace/queue', require('../_routes/marketplace/queue'));
mount('/api/marketplace/inventory', require('../_routes/marketplace/inventory'));
mount('/api/marketplace/schedule', require('../_routes/marketplace/schedule'));
mount('/api/marketplace/toggle-auto', require('../_routes/marketplace/toggle-auto'));
mount('/api/marketplace/generate-copy', require('../_routes/marketplace/generate-copy'));
mount('/api/marketplace/generate-description', require('../_routes/generate-description'));
mount('/api/marketplace/save-description', require('../_routes/marketplace/save-description'));
mount('/api/v1/marketplace/queue', require('../_routes/v1/marketplace/queue'));
mount('/api/v1/marketplace/posting', require('../_routes/v1/marketplace/posting'));
mount('/api/inventory/feed-status', require('../_routes/inventory/feed-status'));
mount('/api/generate-description', require('../_routes/generate-description'));
mount('/api/v1/generate-description', require('../_routes/generate-description'));
mount('/api/v1/marketplace/generate-description', require('../_routes/generate-description'));
mount('/api/save-description', require('../_routes/marketplace/save-description'));
mount('/api/v1/marketplace/save-description', require('../_routes/marketplace/save-description'));

// ── Meta Commerce Manager catalog feed (public — Meta crawler) ──────────────
mount('/api/catalog/feed', require('../_routes/catalog/feed'));
mount('/api/feeds/meta', require('../_routes/catalog/feed'));
mount('/api/feeds/catalog', require('../_routes/catalog/feed'));

// ── Inventory regex sanitizer ───────────────────────────────────────────────
mount('/api/inventory/parse', require('../_routes/inventory/parse'));
mount('/api/inventory/sanitize', require('../_routes/inventory/parse'));
mount('/api/marketplace/parse', require('../_routes/inventory/parse'));
mount('/api/marketplace/sanitize', require('../_routes/inventory/parse'));

app.get(['/api/healthz', '/healthz'], (_req, res) => {
  res.status(200).json({ status: 'UP', router: 'api/index', success: true });
});

app.all(['/api', '/api/index', '/'], (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'BDC Marketplace Hub API catch-all router',
    endpoints: [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/me',
      '/api/users/me',
      '/api/marketplace/queue',
      '/api/marketplace/inventory',
      '/api/marketplace/schedule',
      '/api/marketplace/toggle-auto',
      '/api/sync',
      '/api/sync/status',
      '/api/catalog/feed',
      '/api/feeds/meta',
      '/api/admin/users',
    ],
  });
});

app.use((req, res) => {
  console.log('[api] 404', req.method, req.url, 'path=', req.path);
  res.status(404).json({
    success: false,
    error: `No route for ${req.method} ${req.path}`,
    url: req.url,
  });
});

module.exports = app;
