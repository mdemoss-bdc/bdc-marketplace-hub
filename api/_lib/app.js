/**
 * Express app shared by the Vercel catch-all function (api/[[...path]].js).
 */
const express = require('express');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * Normalize request URL so Express routes always see /api/...
 * Optional catch-all invocations may present /auth/login instead of /api/auth/login.
 */
app.use((req, _res, next) => {
  const candidates = [
    req.headers['x-invoke-path'],
    req.headers['x-forwarded-uri'],
    req.headers['x-vercel-original-path'],
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    if (!raw.startsWith('/api')) continue;
    req.url = raw;
    break;
  }

  const current = req.url || '/';
  if (!current.startsWith('/api')) {
    const q = current.includes('?') ? current.slice(current.indexOf('?')) : '';
    const p = current.split('?')[0] || '/';
    if (p === '/' || p === '') {
      req.url = '/api' + q;
    } else {
      req.url = '/api' + (p.startsWith('/') ? p : `/${p}`) + q;
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

function mount(path, handler) {
  app.all(path, wrap(handler));
}

// ── Auth ────────────────────────────────────────────────────────────────────
mount('/api/auth/login', require('../_routes/auth/login'));
mount('/api/auth/logout', require('../_routes/auth/logout'));
mount('/api/auth/me', require('../_routes/auth/me'));
mount('/api/auth/register', require('../_routes/auth/register'));
mount('/api/auth/signup', require('../_routes/auth/register'));
mount('/api/auth/change-password', require('../_routes/auth/change-password'));
mount('/api/auth/smtp-verify', require('../_routes/auth/smtp-verify'));

// ── Users / profile ─────────────────────────────────────────────────────────
mount('/api/users/me', require('../_routes/users/me'));
mount('/api/users/update-profile', require('../_routes/users/update-profile'));
mount('/api/user/update-email', require('../_routes/user/update-email'));
mount('/api/user/update-phone', require('../_routes/user/update-phone'));
mount('/api/user/recovery-id/regenerate', require('../_routes/user/recovery-id/regenerate'));

// ── Admin ───────────────────────────────────────────────────────────────────
mount('/api/admin/users', require('../_routes/admin/users'));

// ── Marketplace publisher / inventory ───────────────────────────────────────
mount('/api/marketplace/queue/status', require('../_routes/marketplace/queue/status'));
mount('/api/marketplace/queue', require('../_routes/marketplace/queue'));
mount('/api/marketplace/inventory', require('../_routes/marketplace/inventory'));
mount('/api/marketplace/schedule', require('../_routes/marketplace/schedule'));
mount('/api/marketplace/generate-copy', require('../_routes/marketplace/generate-copy'));
mount('/api/v1/marketplace/queue', require('../_routes/v1/marketplace/queue'));

// ── Inventory regex sanitizer ───────────────────────────────────────────────
mount('/api/inventory/parse', require('../_routes/inventory/parse'));
mount('/api/inventory/sanitize', require('../_routes/inventory/parse'));
mount('/api/marketplace/parse', require('../_routes/inventory/parse'));
mount('/api/marketplace/sanitize', require('../_routes/inventory/parse'));

app.get('/api/healthz', (_req, res) => {
  res.status(200).json({ status: 'UP', router: 'api/[[...path]]', success: true });
});

app.all('/api', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'BDC Marketplace Hub API catch-all router',
    endpoints: [
      '/api/auth/login',
      '/api/auth/me',
      '/api/users/me',
      '/api/marketplace/queue',
      '/api/marketplace/inventory',
      '/api/marketplace/schedule',
      '/api/admin/users',
    ],
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `No route for ${req.method} ${req.path}`,
  });
});

module.exports = app;
