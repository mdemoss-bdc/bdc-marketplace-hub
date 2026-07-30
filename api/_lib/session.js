/**
 * Server-only session helpers for Vercel serverless auth.
 * Secrets come from process.env — never from VITE_* client vars.
 */
const crypto = require('crypto');

const TOKEN_PREFIX = 'vs_';

function sessionSecret() {
  return (
    process.env.AUTH_SESSION_SECRET ||
    process.env.DASHBOARD_PASSWORD ||
    process.env.LOGIN_PASSWORD ||
    ''
  );
}

function accountProfiles() {
  return {
    mdemoss: {
      id: 9,
      username: 'mdemoss',
      email: 'mdemoss@local.dev',
      is_admin: true,
      is_master_admin: true,
      subscription_status: 'active',
      subscription_tier: 'pro_lifetime',
      org_role: '',
      organization_id: null,
      email_verified: true,
      is_suspended: false,
      created_at: '2024-01-01T00:00:00Z',
      mock_role: '',
      tiktok_connected: false,
      tiktok_token_expires_at: '',
      tiktok_privacy_level: 'SELF_ONLY',
      pending_extra_seats: 0,
    },
    testreviewer: {
      id: 20,
      username: 'testreviewer',
      email: 'testreviewer@local.dev',
      is_admin: true,
      is_master_admin: false,
      subscription_status: 'active',
      subscription_tier: 'rooftop_monthly',
      org_role: 'admin',
      organization_id: 1,
      email_verified: true,
      is_suspended: false,
      created_at: '2024-06-01T00:00:00Z',
      mock_role: '',
      tiktok_connected: false,
      tiktok_token_expires_at: '',
      tiktok_privacy_level: 'SELF_ONLY',
      pending_extra_seats: 0,
    },
    jdemoss: {
      id: 22,
      username: 'jdemoss',
      email: 'jdemoss@local.dev',
      is_admin: false,
      is_master_admin: false,
      subscription_status: 'active',
      subscription_tier: 'pro_annual',
      org_role: '',
      organization_id: null,
      email_verified: true,
      is_suspended: false,
      created_at: '2024-08-15T00:00:00Z',
      mock_role: '',
      tiktok_connected: false,
      tiktok_token_expires_at: '',
      tiktok_privacy_level: 'SELF_ONLY',
      pending_extra_seats: 0,
    },
  };
}

/** Map username → server-side password env var (never VITE_*). */
function passwordForUser(username) {
  const key = String(username || '').trim().toLowerCase();
  if (key === 'mdemoss') {
    return (
      process.env.DASHBOARD_PASSWORD ||
      process.env.LOGIN_PASSWORD ||
      process.env.ADMIN_PASSWORD ||
      ''
    ).trim();
  }
  if (key === 'testreviewer') {
    return (process.env.TESTER_PASSWORD || '').trim();
  }
  if (key === 'jdemoss') {
    return (process.env.JDEMOSS_PASSWORD || '').trim();
  }
  return '';
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signSession(user) {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error('AUTH_SESSION_SECRET or DASHBOARD_PASSWORD must be configured.');
  }
  const payload = Buffer.from(
    JSON.stringify({
      u: user.username,
      id: user.id,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${TOKEN_PREFIX}${payload}.${sig}`;
}

function verifySession(token) {
  const secret = sessionSecret();
  if (!secret || !token || !String(token).startsWith(TOKEN_PREFIX)) return null;
  const raw = String(token).slice(TOKEN_PREFIX.length);
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data?.u || !data?.exp || Date.now() > Number(data.exp)) return null;
  const profiles = accountProfiles();
  const user = profiles[String(data.u).toLowerCase()];
  return user ? { ...user } : null;
}

function authenticate(username, password) {
  const key = String(username || '').trim().toLowerCase();
  const expected = passwordForUser(key);
  if (!expected || !password) return null;
  if (!safeEqual(expected, password)) return null;
  const profiles = accountProfiles();
  return profiles[key] ? { ...profiles[key] } : null;
}

function setCors(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
}

module.exports = {
  TOKEN_PREFIX,
  authenticate,
  signSession,
  verifySession,
  setCors,
};
