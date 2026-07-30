/**
 * Persistent SQLite auth store for Vercel/Node serverless routes.
 * Schema mirrors the Python engine users table (id, username, password_hash,
 * role, created_at) plus desk profile fields needed by /api/auth/* and admin.
 *
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — no ORM dependency.
 * On Vercel the DB lives under /tmp (writable); locally under api/_data/.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('./crypto-passwords');

let _db = null;

function dbPath() {
  if (process.env.AUTH_DB_PATH) return process.env.AUTH_DB_PATH;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join('/tmp', 'bdc-auth.db');
  }
  return path.join(__dirname, '..', '_data', 'auth.db');
}

function openDb() {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _db = new DatabaseSync(file);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Reviewer',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      email TEXT DEFAULT '',
      full_name TEXT DEFAULT '',
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_master_admin INTEGER NOT NULL DEFAULT 0,
      subscription_status TEXT DEFAULT 'inactive',
      subscription_tier TEXT DEFAULT '',
      org_role TEXT DEFAULT '',
      organization_id INTEGER,
      email_verified INTEGER NOT NULL DEFAULT 1,
      is_suspended INTEGER NOT NULL DEFAULT 0,
      recovery_id TEXT DEFAULT '',
      mock_role TEXT DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
      ON users (LOWER(username));
  `);
  ensureSeeded(_db);
  return _db;
}

function envPassword(username) {
  const key = String(username || '').trim().toLowerCase();
  if (key === 'mdemoss') {
    return (
      process.env.DASHBOARD_PASSWORD ||
      process.env.LOGIN_PASSWORD ||
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

function seedAccount(db, spec) {
  const username = spec.username.toLowerCase();
  const existing = db
    .prepare('SELECT id, password_hash FROM users WHERE LOWER(username) = ?')
    .get(username);
  const password = envPassword(username);
  if (!password && !existing) {
    console.warn(
      `[auth-db] skip seed '${username}' — set ${spec.envHint}`,
    );
    return;
  }
  const hash = password ? hashPassword(password) : null;
  if (!existing) {
    if (!hash) return;
    db.prepare(
      `INSERT INTO users
        (username, password_hash, role, email, full_name, is_admin, is_master_admin,
         subscription_status, subscription_tier, org_role, organization_id,
         email_verified, recovery_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      username,
      hash,
      spec.role,
      spec.email,
      spec.full_name,
      spec.is_admin ? 1 : 0,
      spec.is_master_admin ? 1 : 0,
      spec.subscription_status,
      spec.subscription_tier,
      spec.org_role,
      spec.organization_id,
      spec.recovery_id,
    );
    console.log(`[auth-db] seeded user ${username} (${spec.role})`);
    return;
  }
  if (hash) {
    db.prepare(
      `UPDATE users SET password_hash = ?, role = ?, email = ?, full_name = ?,
        is_admin = ?, is_master_admin = ?, subscription_status = ?,
        subscription_tier = ?, org_role = ?, organization_id = ?,
        email_verified = 1, is_suspended = 0
       WHERE LOWER(username) = ?`,
    ).run(
      hash,
      spec.role,
      spec.email,
      spec.full_name,
      spec.is_admin ? 1 : 0,
      spec.is_master_admin ? 1 : 0,
      spec.subscription_status,
      spec.subscription_tier,
      spec.org_role,
      spec.organization_id,
      username,
    );
  } else {
    db.prepare(
      `UPDATE users SET role = ?, email = ?, full_name = ?,
        is_admin = ?, is_master_admin = ?, subscription_status = ?,
        subscription_tier = ?, org_role = ?, organization_id = ?,
        email_verified = 1
       WHERE LOWER(username) = ?`,
    ).run(
      spec.role,
      spec.email,
      spec.full_name,
      spec.is_admin ? 1 : 0,
      spec.is_master_admin ? 1 : 0,
      spec.subscription_status,
      spec.subscription_tier,
      spec.org_role,
      spec.organization_id,
      username,
    );
  }
}

/**
 * If the users table is empty (or missing bootstrap accounts), seed
 * mdemoss / testreviewer from DASHBOARD_PASSWORD / TESTER_PASSWORD.
 * Safe to call on every cold start.
 */
function ensureSeeded(db) {
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
  const empty = !countRow || Number(countRow.cnt) === 0;
  if (empty) {
    console.log('[auth-db] users table empty — running bootstrap seed');
  }

  seedAccount(db, {
    username: 'mdemoss',
    role: 'Admin',
    email: 'mdemoss@local.dev',
    full_name: 'Matthew DeMoss',
    is_admin: true,
    is_master_admin: true,
    subscription_status: 'active',
    subscription_tier: 'pro_lifetime',
    org_role: '',
    organization_id: null,
    recovery_id: 'MD-DEMO-0009-AAAA',
    envHint: 'DASHBOARD_PASSWORD',
  });

  seedAccount(db, {
    username: 'testreviewer',
    role: 'Reviewer',
    email: 'testreviewer@local.dev',
    full_name: 'Test Reviewer',
    is_admin: false,
    is_master_admin: false,
    subscription_status: 'active',
    subscription_tier: 'rooftop_monthly',
    org_role: 'admin',
    organization_id: 1,
    recovery_id: 'TR-DEMO-0020-BBBB',
    envHint: 'TESTER_PASSWORD',
  });

  if (envPassword('jdemoss')) {
    seedAccount(db, {
      username: 'jdemoss',
      role: 'Reviewer',
      email: 'jdemoss@local.dev',
      full_name: 'J DeMoss',
      is_admin: false,
      is_master_admin: false,
      subscription_status: 'active',
      subscription_tier: 'pro_annual',
      org_role: '',
      organization_id: null,
      recovery_id: 'JD-DEMO-0022-CCCC',
      envHint: 'JDEMOSS_PASSWORD',
    });
  }
}

function rowToUser(row) {
  if (!row) return null;
  const role = String(row.role || '').trim() || (row.is_admin ? 'Admin' : 'Reviewer');
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
    created_at: row.created_at || '',
    mock_role: row.mock_role || '',
    tiktok_connected: false,
    tiktok_token_expires_at: '',
    tiktok_privacy_level: 'SELF_ONLY',
    pending_extra_seats: 0,
    full_name: row.full_name || row.username,
    recovery_id: row.recovery_id || '',
  };
}

function getUserByUsername(username) {
  const db = openDb();
  const key = String(username || '').trim().toLowerCase();
  if (!key) return null;
  const row = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = ?')
    .get(key);
  return rowToUser(row);
}

function getUserById(id) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return rowToUser(row);
}

function authenticate(username, password) {
  const db = openDb();
  const key = String(username || '').trim().toLowerCase();
  if (!key || !password) return null;
  const row = db
    .prepare('SELECT * FROM users WHERE LOWER(username) = ?')
    .get(key);
  if (!row || row.is_suspended) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return rowToUser(row);
}

function createUser({ username, password, role = 'Reviewer', email = '', full_name = '' }) {
  const db = openDb();
  const uname = String(username || '').trim().toLowerCase();
  if (uname.length < 3) throw new Error('Username must be at least 3 characters.');
  if (!password || String(password).length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const rbac = role === 'Admin' ? 'Admin' : 'Reviewer';
  const hash = hashPassword(password);
  try {
    const info = db
      .prepare(
        `INSERT INTO users
          (username, password_hash, role, email, full_name, is_admin, is_master_admin,
           subscription_status, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'inactive', 1)`,
      )
      .run(
        uname,
        hash,
        rbac,
        String(email || '').trim(),
        String(full_name || uname).trim(),
        rbac === 'Admin' ? 1 : 0,
      );
    return getUserById(Number(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message || err).includes('UNIQUE')) {
      throw new Error('Username already exists.');
    }
    throw err;
  }
}

function listUsersForAdmin() {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT id, username, full_name, email, subscription_status, subscription_tier,
              is_admin, is_suspended, email_verified, created_at, recovery_id,
              organization_id, org_role, role
       FROM users
       ORDER BY datetime(created_at) DESC, id DESC`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    full_name: r.full_name || r.username,
    email: r.email || '',
    subscription_status: r.subscription_status || 'inactive',
    subscription_tier: r.subscription_tier || '',
    is_admin: Boolean(r.is_admin),
    is_suspended: Boolean(r.is_suspended),
    email_verified: Boolean(r.email_verified),
    created_at: r.created_at || '',
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

module.exports = {
  openDb,
  ensureSeeded,
  getUserByUsername,
  getUserById,
  authenticate,
  createUser,
  listUsersForAdmin,
  dbPath,
};
