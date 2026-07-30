/**
 * Account profiles + credential verification for serverless auth.
 * Prefer scrypt hashes in api/_data/users.hashed.json; else timing-safe
 * compare against DASHBOARD_PASSWORD / TESTER_PASSWORD / JDEMOSS_PASSWORD.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyPassword } = require('./crypto-passwords');

const PROFILES = {
  mdemoss: {
    id: 9,
    username: 'mdemoss',
    email: 'mdemoss@local.dev',
    role: 'Admin',
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
    full_name: 'Matthew DeMoss',
    recovery_id: 'MD-DEMO-0009-AAAA',
  },
  testreviewer: {
    id: 20,
    username: 'testreviewer',
    email: 'testreviewer@local.dev',
    role: 'Reviewer',
    is_admin: false,
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
    full_name: 'Test Reviewer',
    recovery_id: 'TR-DEMO-0020-BBBB',
  },
  jdemoss: {
    id: 22,
    username: 'jdemoss',
    email: 'jdemoss@local.dev',
    role: 'Reviewer',
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
    full_name: 'J DeMoss',
    recovery_id: 'JD-DEMO-0022-CCCC',
  },
};

/** Extra directory rows matching mock-admin-users (non-loginable stubs). */
const DIRECTORY_EXTRAS = [
  {
    id: 21,
    username: 'mdemoss1',
    full_name: 'BDC Test User',
    email: 'mdemoss1@local.dev',
    subscription_status: 'active',
    subscription_tier: 'rooftop_monthly',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-09-01T00:00:00Z',
    recovery_id: 'M1-DEMO-0021-DDDD',
    org_id: 1,
    org_role: 'member',
    org_name: 'Demo Rooftop Motors',
    org_max_seats: 5,
  },
  {
    id: 30,
    username: 'sales.manager',
    full_name: 'Sales Manager',
    email: 'sales.manager@local.dev',
    subscription_status: 'active',
    subscription_tier: 'pro_annual',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2024-10-01T00:00:00Z',
    recovery_id: 'SM-DEMO-0030-EEEE',
    org_id: 2,
    org_role: 'admin',
    org_name: 'University Ford Desk',
    org_max_seats: 8,
  },
  {
    id: 31,
    username: 'desk.rep',
    full_name: 'Desk Rep',
    email: 'desk.rep@local.dev',
    subscription_status: 'inactive',
    subscription_tier: '',
    is_admin: false,
    is_suspended: false,
    email_verified: true,
    created_at: '2025-01-12T00:00:00Z',
    recovery_id: 'DR-DEMO-0031-FFFF',
    org_id: 2,
    org_role: 'member',
    org_name: 'University Ford Desk',
    org_max_seats: 8,
  },
];

function hashedFilePath() {
  return path.join(__dirname, '..', '_data', 'users.hashed.json');
}

function loadHashedPasswords() {
  try {
    const raw = fs.readFileSync(hashedFilePath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function envPasswordForUser(username) {
  const key = String(username || '').trim().toLowerCase();
  if (key === 'mdemoss') {
    return (process.env.DASHBOARD_PASSWORD || process.env.LOGIN_PASSWORD || '').trim();
  }
  if (key === 'testreviewer') {
    return (process.env.TESTER_PASSWORD || '').trim();
  }
  if (key === 'jdemoss') {
    return (process.env.JDEMOSS_PASSWORD || '').trim();
  }
  return '';
}

function safeEqualStr(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getUserByUsername(username) {
  const key = String(username || '').trim().toLowerCase();
  const profile = PROFILES[key];
  return profile ? { ...profile } : null;
}

function authenticate(username, password) {
  const key = String(username || '').trim().toLowerCase();
  const profile = PROFILES[key];
  if (!profile || !password) return null;

  const hashes = loadHashedPasswords();
  if (hashes && typeof hashes[key] === 'string' && hashes[key]) {
    if (!verifyPassword(password, hashes[key])) return null;
    return { ...profile };
  }

  const expected = envPasswordForUser(key);
  if (!expected) return null;
  if (!safeEqualStr(expected, password)) return null;
  return { ...profile };
}

function requireRole(user, roles) {
  if (!user || !Array.isArray(roles) || roles.length === 0) return false;
  const role = String(user.role || '');
  return roles.map(String).includes(role);
}

function adminDirectoryUsers() {
  const fromProfiles = Object.values(PROFILES).map((p) => ({
    id: p.id,
    username: p.username,
    full_name: p.full_name || p.username,
    email: p.email,
    subscription_status: p.subscription_status,
    subscription_tier: p.subscription_tier,
    is_admin: p.is_admin,
    is_suspended: p.is_suspended,
    email_verified: p.email_verified,
    created_at: p.created_at,
    recovery_id: p.recovery_id,
    org_id: p.organization_id,
    org_role: p.org_role || '',
    org_name:
      p.organization_id === 1
        ? 'Demo Rooftop Motors'
        : p.organization_id === 2
          ? 'University Ford Desk'
          : '',
    org_max_seats: p.organization_id === 1 ? 5 : p.organization_id === 2 ? 8 : undefined,
    role: p.role,
  }));
  return [...fromProfiles, ...DIRECTORY_EXTRAS.map((u) => ({ ...u }))];
}

module.exports = {
  PROFILES,
  authenticate,
  getUserByUsername,
  requireRole,
  adminDirectoryUsers,
};
