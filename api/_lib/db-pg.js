/**
 * PostgreSQL auth store for Vercel/Node when DATABASE_URL or POSTGRES_URL is set.
 * Same public surface as db-sqlite.js, but every method is async (pg Pool).
 *
 * Schema mirrors the Python engine `users` table so registrations survive
 * ephemeral /tmp SQLite on serverless.
 */
const { Pool } = require('pg');
const { hashPassword, verifyPassword, looksLikePasswordHash, needsRehash } = require('./crypto-passwords');
const { ensureCoreSchema, databaseUrl: sharedDatabaseUrl } = require('./pg');
const { randomHex, randomRecoveryId } = require('./random-token');

const DEFAULT_ADMIN_PASSWORD = 'Netsirk115!$';
const DEFAULT_TESTER_PASSWORD = 'TestReviewer123!';
const DEFAULT_JDEMOSS_PASSWORD = 'Jdemoss123!';

const USERNAME_ALIASES = {
  jdmoss: 'jdemoss',
  'j.de.moss': 'jdemoss',
};

let _pool = null;
let _ready = null;

function databaseUrl() {
  return sharedDatabaseUrl();
}

function getPool() {
  if (_pool) return _pool;
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error('DATABASE_URL / POSTGRES_URL is not configured.');
  }
  _pool = new Pool({
    connectionString,
    ssl:
      process.env.PGSSLMODE === 'disable'
        ? false
        : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  _pool.on('error', (err) => {
    console.error('[auth-pg] pool error', err.message || err);
  });
  return _pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function queryOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function ensureSchema() {
  // Shared DDL: users + marketplace_inventory + marketplace_queue + posting_queue
  await ensureCoreSchema();

  // Idempotent column adds for older Neon schemas / Cox fields
  const alters = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'Reviewer'",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_master_admin INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive'",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS org_role TEXT DEFAULT ''",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_id TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS mock_role TEXT DEFAULT ''",
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_revert_token TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_revert_expires_at TIMESTAMPTZ DEFAULT NULL',
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS old_email_history TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS cox_client_id TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS cox_client_secret TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS cox_dealer_id TEXT DEFAULT ''",
  ];
  for (const ddl of alters) {
    try {
      await query(ddl);
    } catch (err) {
      console.warn('[auth-pg] alter skipped:', err.message || err);
    }
  }
}

function adminEnvPassword() {
  const fromEnv = (
    process.env.ADMIN_PASSWORD ||
    process.env.DASHBOARD_PASSWORD ||
    process.env.LOGIN_PASSWORD ||
    ''
  ).trim();
  return fromEnv || DEFAULT_ADMIN_PASSWORD;
}

function normalizeLoginIdentifier(identifier) {
  const key = String(identifier || '').trim().toLowerCase();
  if (!key) return '';
  return USERNAME_ALIASES[key] || key;
}

function baselinePassword(username) {
  const key = normalizeLoginIdentifier(username);
  if (key === 'mdemoss' || key === String(process.env.ADMIN_USER || '').trim().toLowerCase()) {
    return adminEnvPassword();
  }
  if (key === 'testreviewer') {
    return (process.env.TESTER_PASSWORD || '').trim() || DEFAULT_TESTER_PASSWORD;
  }
  if (key === 'jdemoss') {
    return (process.env.JDEMOSS_PASSWORD || '').trim() || DEFAULT_JDEMOSS_PASSWORD;
  }
  return '';
}

function adminSeedEmail() {
  return (
    process.env.ADMIN_EMAIL ||
    process.env.MASTER_ADMIN_EMAIL ||
    'support.bdcmanager@gmail.com'
  )
    .trim()
    .toLowerCase();
}

function baselineAccounts() {
  const adminUser =
    String(process.env.ADMIN_USER || 'mdemoss').trim().toLowerCase() || 'mdemoss';
  return [
    {
      username: adminUser,
      password: adminEnvPassword(),
      role: 'Admin',
      email: adminSeedEmail(),
      full_name: 'Matthew DeMoss',
      is_admin: true,
      is_master_admin: true,
      subscription_status: 'active',
      subscription_tier: 'pro_lifetime',
      org_role: '',
      organization_id: null,
      recovery_id: 'MD-DEMO-0009-AAAA',
    },
    {
      username: 'testreviewer',
      password: baselinePassword('testreviewer'),
      role: 'Reviewer',
      email: 'reviewer@bdcmanager.com',
      full_name: 'Test Reviewer',
      is_admin: false,
      is_master_admin: false,
      subscription_status: 'active',
      subscription_tier: 'rooftop_monthly',
      org_role: 'admin',
      organization_id: 1,
      recovery_id: 'TR-DEMO-0020-BBBB',
    },
    {
      username: 'jdemoss',
      password: baselinePassword('jdemoss'),
      role: 'Admin',
      email: 'jdemoss@bdcmanager.com',
      full_name: 'J DeMoss',
      is_admin: true,
      is_master_admin: false,
      subscription_status: 'active',
      subscription_tier: 'pro_annual',
      org_role: 'manager',
      organization_id: null,
      recovery_id: 'JD-DEMO-0022-CCCC',
      syncBaselinePassword: true,
    },
  ];
}

async function seedAccountIfMissing(spec) {
  const username = String(spec.username || '').trim().toLowerCase();
  if (!username) return;

  const existing = await queryOne(
    'SELECT id, password_hash, email FROM users WHERE LOWER(username) = $1',
    [username],
  );

  if (existing) {
    const storedEmail = String(existing.email || '').trim();
    const storedHash = String(existing.password_hash || '').trim();
    const hashMissing = !looksLikePasswordHash(storedHash);

    if (!storedEmail && spec.email) {
      await query('UPDATE users SET email = $1 WHERE id = $2', [spec.email, existing.id]);
      console.log(`[auth-pg] backfilled email for existing user ${username}`);
    }
    if (hashMissing && spec.password) {
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hashPassword(spec.password),
        existing.id,
      ]);
      console.log(`[auth-pg] restored missing password hash for ${username}`);
    } else if (
      spec.syncBaselinePassword &&
      spec.password &&
      !verifyPassword(spec.password, storedHash)
    ) {
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hashPassword(spec.password),
        existing.id,
      ]);
      console.log(`[auth-pg] synced baseline password for ${username}`);
    } else {
      console.log(`[auth-pg] baseline skip ${username} — already exists (password preserved)`);
    }

    await query(
      `UPDATE users SET role = $1,
        full_name = COALESCE(NULLIF(full_name, ''), $2),
        is_admin = $3, is_master_admin = $4, subscription_status = $5,
        subscription_tier = $6, org_role = $7,
        organization_id = COALESCE(organization_id, $8),
        email_verified = 1, is_suspended = 0
       WHERE id = $9`,
      [
        spec.role,
        spec.full_name,
        spec.is_admin ? 1 : 0,
        spec.is_master_admin ? 1 : 0,
        spec.subscription_status,
        spec.subscription_tier,
        spec.org_role || '',
        spec.organization_id,
        existing.id,
      ],
    );
    return;
  }

  if (!spec.password) {
    console.warn(`[auth-pg] skip seed '${username}' — no password available`);
    return;
  }

  await query(
    `INSERT INTO users
      (username, password_hash, role, email, full_name, is_admin, is_master_admin,
       subscription_status, subscription_tier, org_role, organization_id,
       email_verified, recovery_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12)`,
    [
      username,
      hashPassword(spec.password),
      spec.role,
      spec.email,
      spec.full_name,
      spec.is_admin ? 1 : 0,
      spec.is_master_admin ? 1 : 0,
      spec.subscription_status,
      spec.subscription_tier,
      spec.org_role || '',
      spec.organization_id,
      spec.recovery_id,
    ],
  );
  console.log(`[auth-pg] seeded user ${username} (${spec.role}, email=${spec.email})`);
}

async function ensureSeeded() {
  const countRow = await queryOne('SELECT COUNT(*)::int AS cnt FROM users');
  const empty = !countRow || Number(countRow.cnt) === 0;
  if (empty) {
    console.log('[auth-pg] users table empty — running non-destructive baseline seed');
  } else {
    console.log('[auth-pg] ensuring baseline accounts exist (non-destructive)');
  }
  for (const account of baselineAccounts()) {
    await seedAccountIfMissing(account);
  }
}

async function openDb() {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    await ensureSeeded();
    console.log('[auth-pg] connected — persistent PostgreSQL users store ready');
    return getPool();
  })();
  try {
    return await _ready;
  } catch (err) {
    _ready = null;
    throw err;
  }
}

function rowToUser(row) {
  if (!row) return null;
  const role = String(row.role || '').trim() || (row.is_admin ? 'Admin' : 'Reviewer');
  const fbPageId = String(row.fb_page_id || '').trim();
  const fbToken = String(row.fb_access_token || '').trim();
  const fbPageName = String(row.fb_page_name || '').trim();
  const catalogId = String(row.commerce_catalog_id || '').trim();
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    role,
    rbac_role: role,
    is_admin: Boolean(row.is_admin),
    is_master_admin: Boolean(row.is_master_admin),
    subscription_status: row.subscription_status || 'inactive',
    subscription_tier: row.subscription_tier || '',
    org_role: row.org_role || '',
    organization_id: row.organization_id == null ? null : row.organization_id,
    email_verified: Boolean(row.email_verified),
    is_suspended: Boolean(row.is_suspended),
    created_at: row.created_at ? String(row.created_at) : '',
    phone: row.phone || '',
    mock_role: row.mock_role || '',
    tiktok_connected: false,
    tiktok_token_expires_at: '',
    tiktok_privacy_level: 'SELF_ONLY',
    pending_extra_seats: 0,
    full_name: row.full_name || row.username,
    recovery_id: row.recovery_id || '',
    // Facebook / Meta — never expose raw access tokens on /auth/me
    facebook_connected: Boolean(fbPageId && fbToken),
    fb_page_id: fbPageId,
    fb_page_name: fbPageName,
    commerce_catalog_id: catalogId,
    fb_catalog_name: String(row.fb_catalog_name || '').trim(),
    facebook_connected_at: row.facebook_connected_at
      ? String(row.facebook_connected_at)
      : '',
  };
}

async function saveFacebookConnection(userId, connection) {
  await openDb();
  const id = Number(userId);
  if (!id) throw new Error('userId is required.');
  await query(
    `UPDATE users SET
       fb_page_id = $1,
       fb_page_name = $2,
       fb_access_token = $3,
       fb_user_access_token = $4,
       commerce_catalog_id = $5,
       fb_catalog_name = $6,
       facebook_connected_at = CURRENT_TIMESTAMP
     WHERE id = $7`,
    [
      String(connection.fb_page_id || '').trim(),
      String(connection.fb_page_name || '').trim(),
      String(connection.fb_access_token || '').trim(),
      String(connection.fb_user_access_token || '').trim(),
      String(connection.commerce_catalog_id || '').trim(),
      String(connection.fb_catalog_name || '').trim(),
      id,
    ],
  );
  return getUserById(id);
}

async function clearFacebookConnection(userId) {
  await openDb();
  const id = Number(userId);
  if (!id) throw new Error('userId is required.');
  await query(
    `UPDATE users SET
       fb_page_id = '',
       fb_page_name = '',
       fb_access_token = '',
       fb_user_access_token = '',
       commerce_catalog_id = '',
       fb_catalog_name = '',
       facebook_connected_at = NULL
     WHERE id = $1`,
    [id],
  );
  return getUserById(id);
}

async function findUserRow(identifier) {
  await openDb();
  const key = normalizeLoginIdentifier(identifier);
  if (!key) return null;
  return queryOne(
    `SELECT * FROM users
     WHERE LOWER(username) = $1
        OR (email IS NOT NULL AND email != '' AND LOWER(email) = $2)
     LIMIT 1`,
    [key, key],
  );
}

async function getUserByUsername(username) {
  return rowToUser(await findUserRow(username));
}

async function getUserById(id) {
  await openDb();
  const row = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
  return rowToUser(row);
}

async function authenticate(identifier, password) {
  const key = normalizeLoginIdentifier(identifier);
  if (!key || !password) {
    console.log('[AUTH FAIL]', key || '(empty)', 'missing username or password');
    return null;
  }

  const row = await findUserRow(key);
  console.log('[LOGIN CHECK]', { inputUsername: key, userFound: !!row });
  if (!row) {
    console.log('[AUTH FAIL]', key, 'user not found');
    return null;
  }
  if (row.is_suspended) {
    console.log('[AUTH FAIL]', key, 'account suspended');
    return null;
  }

  // Authenticate against the stored password hash only — no username allow-lists.
  if (!verifyPassword(password, row.password_hash)) {
    console.log('[LOGIN FAIL] Password mismatch for:', key);
    console.log('[AUTH FAIL]', key, 'password mismatch');
    return null;
  }

  // Transparently upgrade legacy scrypt/pbkdf2 hashes to bcrypt on successful login.
  if (needsRehash(row.password_hash)) {
    try {
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
        hashPassword(password),
        row.id,
      ]);
      console.log(`[auth-pg] upgraded ${row.username} hash to bcrypt`);
    } catch (err) {
      console.warn('[auth-pg] bcrypt upgrade skipped:', err.message || err);
    }
  }

  console.log('[AUTH OK]', row.username, 'hash verified');
  return rowToUser(row);
}

async function createUser({
  username,
  password,
  role = 'Reviewer',
  email = '',
  full_name = '',
  subscription_status = 'inactive',
  subscription_tier = '',
  account_type = '',
} = {}) {
  await openDb();
  const uname = String(username || '').trim().toLowerCase();
  const mail = String(email || '').trim().toLowerCase();
  if (uname.length < 3) throw new Error('Username must be at least 3 characters.');
  if (!password || String(password).length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  if (!mail) throw new Error('Email address is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    throw new Error('A valid email address is required.');
  }

  const existingUser = await queryOne(
    'SELECT id FROM users WHERE LOWER(username) = $1 LIMIT 1',
    [uname],
  );
  if (existingUser) throw new Error('Username already exists.');

  const emailTaken = await queryOne(
    `SELECT id FROM users WHERE email IS NOT NULL AND email != '' AND LOWER(email) = $1 LIMIT 1`,
    [mail],
  );
  if (emailTaken) throw new Error('An account with that email already exists.');

  const rbac = role === 'Admin' ? 'Admin' : 'Reviewer';
  const tier =
    subscription_tier ||
    (account_type === 'rooftop' ? 'rooftop_pending' : '');
  const hash = hashPassword(password);
  const recovery = randomRecoveryId();

  try {
    const inserted = await queryOne(
      `INSERT INTO users
        (username, password_hash, role, email, full_name, is_admin, is_master_admin,
         subscription_status, subscription_tier, email_verified, recovery_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,1,$9)
       RETURNING id`,
      [
        uname,
        hash,
        rbac,
        mail,
        String(full_name || uname).trim(),
        rbac === 'Admin' ? 1 : 0,
        subscription_status || 'inactive',
        tier,
        recovery,
      ],
    );
    const user = await getUserById(Number(inserted.id));
    console.log('[auth-pg] registered user', uname, mail || '(no email)');
    return user;
  } catch (err) {
    if (String(err.message || err).includes('unique') || err.code === '23505') {
      throw new Error('Username already exists.');
    }
    throw err;
  }
}

async function listUsersForAdmin() {
  await openDb();
  const result = await query(
    `SELECT id, username, full_name, email, subscription_status, subscription_tier,
            is_admin, is_suspended, email_verified, created_at, recovery_id,
            organization_id, org_role, role
     FROM users
     ORDER BY created_at DESC NULLS LAST, id DESC`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    username: r.username,
    full_name: r.full_name || r.username,
    email: r.email || '',
    subscription_status: r.subscription_status || 'inactive',
    subscription_tier: r.subscription_tier || '',
    is_admin: Boolean(r.is_admin),
    is_suspended: Boolean(r.is_suspended),
    email_verified: Boolean(r.email_verified),
    created_at: r.created_at ? String(r.created_at) : '',
    recovery_id: r.recovery_id || '',
    org_id: r.organization_id,
    org_role: r.org_role || '',
    org_name:
      r.organization_id === 1
        ? 'Demo Rooftop Motors'
        : r.organization_id === 2
          ? 'University Ford Desk'
          : '',
    org_max_seats: r.organization_id === 1 ? 5 : r.organization_id === 2 ? 8 : undefined,
    role: String(r.role || '').trim() || (r.is_admin ? 'Admin' : 'Reviewer'),
  }));
}

async function updatePhone(userId, phone) {
  await openDb();
  await query('UPDATE users SET phone = $1 WHERE id = $2', [
    String(phone || '').trim(),
    userId,
  ]);
  return getUserById(userId);
}

async function updateEmail(userId, newEmail, currentPassword) {
  await openDb();
  const row = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
  if (!row) throw new Error('User not found.');
  const mail = String(newEmail || '').trim().toLowerCase();
  if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    throw new Error('A valid email address is required.');
  }
  const masterUser =
    String(process.env.ADMIN_USER || 'mdemoss').trim().toLowerCase() || 'mdemoss';
  const isMaster = String(row.username || '').toLowerCase() === masterUser;
  const envOk = isMaster && currentPassword === adminEnvPassword();
  if (!envOk && !verifyPassword(currentPassword, row.password_hash)) {
    throw new Error('Current password is incorrect.');
  }
  const taken = await queryOne(
    `SELECT id FROM users
     WHERE email IS NOT NULL AND email != '' AND LOWER(email) = $1 AND id != $2
     LIMIT 1`,
    [mail, userId],
  );
  if (taken) {
    throw new Error('That email address is already registered to another account.');
  }
  const oldEmail = String(row.email || '').trim().toLowerCase();
  const revertToken = randomHex(24);
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const history = [row.old_email_history, oldEmail].filter(Boolean).join(',').slice(0, 2000);
  await query(
    `UPDATE users SET email = $1, email_revert_token = $2, email_revert_expires_at = $3,
      old_email_history = $4 WHERE id = $5`,
    [mail, revertToken, expires, history, userId],
  );
  return {
    user: await getUserById(userId),
    old_email: oldEmail,
    new_email: mail,
    revert_token: revertToken,
  };
}

async function updateProfile(userId, { phone, email, new_email, current_password } = {}) {
  let user = await getUserById(userId);
  if (!user) throw new Error('User not found.');
  let emailChange = null;
  if (phone !== undefined) {
    user = await updatePhone(userId, phone);
  }
  const nextEmail = email !== undefined ? email : new_email;
  if (nextEmail !== undefined && nextEmail !== null && String(nextEmail).trim() !== '') {
    emailChange = await updateEmail(userId, nextEmail, current_password);
    user = emailChange.user;
  }
  return { user, emailChange };
}

async function regenerateRecoveryId(userId) {
  await openDb();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const rid = `REC-${seg()}-${seg()}-${seg()}`;
  await query('UPDATE users SET recovery_id = $1 WHERE id = $2', [rid, userId]);
  return getUserById(userId);
}

async function changePassword(userId, currentPassword, newPassword) {
  await openDb();
  const row = await queryOne('SELECT * FROM users WHERE id = $1', [userId]);
  if (!row) throw new Error('User not found.');
  const key = String(row.username || '').trim().toLowerCase();
  const masterUser =
    String(process.env.ADMIN_USER || 'mdemoss').trim().toLowerCase() || 'mdemoss';
  const isMaster = key === 'mdemoss' || key === masterUser;
  const envOk = isMaster && adminEnvPassword() && currentPassword === adminEnvPassword();
  if (!envOk && !verifyPassword(currentPassword, row.password_hash)) {
    throw new Error('Current password is incorrect.');
  }
  if (!newPassword || String(newPassword).length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [
    hashPassword(newPassword),
    userId,
  ]);
  return getUserById(userId);
}

function dbPath() {
  return databaseUrl() || '(postgresql)';
}

async function persistVault() {
  /* no-op — PostgreSQL is the durable store */
}

module.exports = {
  openDb,
  ensureSeeded,
  adminEnvPassword,
  getUserByUsername,
  getUserById,
  authenticate,
  createUser,
  listUsersForAdmin,
  updatePhone,
  updateEmail,
  updateProfile,
  regenerateRecoveryId,
  changePassword,
  saveFacebookConnection,
  clearFacebookConnection,
  dbPath,
  persistVault,
  databaseUrl,
};
