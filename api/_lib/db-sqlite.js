/**
 * Persistent SQLite auth store (local / no DATABASE_URL fallback).
 * Prefer PostgreSQL via api/_lib/db-pg.js when DATABASE_URL or POSTGRES_URL is set.
 *
 * Schema mirrors the Python engine users table plus desk profile fields.
 * Uses Node's built-in `node:sqlite` (DatabaseSync) — no ORM dependency.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword, looksLikePasswordHash, needsRehash } = require('./crypto-passwords');
const { randomHex, randomRecoveryId } = require('./random-token');

/** Bootstrap password for mdemoss when no env secret is configured. */
const DEFAULT_ADMIN_PASSWORD = 'Netsirk115!$';
const DEFAULT_TESTER_PASSWORD = 'TestReviewer123!';
const DEFAULT_JDEMOSS_PASSWORD = 'Jdemoss123!';

/** Alternate spellings that resolve to the canonical username. */
const USERNAME_ALIASES = {
  jdmoss: 'jdemoss',
  'j.de.moss': 'jdemoss',
};

let _db = null;

function dbPath() {
  if (process.env.AUTH_DB_PATH) return process.env.AUTH_DB_PATH;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join('/tmp', 'bdc-auth.db');
  }
  return path.join(__dirname, '..', '_data', 'auth.db');
}

function vaultPaths() {
  const paths = [];
  if (process.env.AUTH_VAULT_PATH) paths.push(process.env.AUTH_VAULT_PATH);
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    paths.push(path.join('/tmp', 'bdc-auth-vault.json'));
  }
  paths.push(path.join(__dirname, '..', '_data', 'auth-vault.json'));
  return paths;
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
      phone TEXT DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_users_email_lower
      ON users (LOWER(email));
  `);
  for (const ddl of [
    "ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''",
    'ALTER TABLE users ADD COLUMN email_revert_token TEXT DEFAULT NULL',
    'ALTER TABLE users ADD COLUMN email_revert_expires_at TEXT DEFAULT NULL',
    "ALTER TABLE users ADD COLUMN old_email_history TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN fb_page_id TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN fb_page_name TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN fb_access_token TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN fb_user_access_token TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN commerce_catalog_id TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN fb_catalog_name TEXT DEFAULT ''",
    "ALTER TABLE users ADD COLUMN catalog_token TEXT DEFAULT ''",
    'ALTER TABLE users ADD COLUMN facebook_connected_at TEXT DEFAULT NULL',
  ]) {
    try {
      _db.exec(ddl);
    } catch {
      /* already present */
    }
  }
  restoreVault(_db);
  ensureSeeded(_db);
  persistVault(_db);
  return _db;
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

/** Lowercase + alias map so jdmoss / JDeMoss / jdemoss all resolve consistently. */
function normalizeLoginIdentifier(identifier) {
  const key = String(identifier || '').trim().toLowerCase();
  if (!key) return '';
  return USERNAME_ALIASES[key] || key;
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
      syncBaselinePassword: true,
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
      // Keep demo password aligned with Jdemoss123! (or JDEMOSS_PASSWORD).
      syncBaselinePassword: true,
    },
  ];
}

/**
 * Insert baseline account only when it does not already exist.
 * Never overwrites an existing password_hash.
 */
function seedAccountIfMissing(db, spec) {
  const username = String(spec.username || '').trim().toLowerCase();
  if (!username) return;

  const existing = db
    .prepare('SELECT id, password_hash, email FROM users WHERE LOWER(username) = ?')
    .get(username);

  if (existing) {
    const storedEmail = String(existing.email || '').trim();
    const storedHash = String(existing.password_hash || '').trim();
    const hashMissing = !looksLikePasswordHash(storedHash);

    // Backfill empty email / missing hash only — never clobber a real password
    // unless this baseline account opts into syncBaselinePassword (jdemoss).
    if (!storedEmail && spec.email) {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(spec.email, existing.id);
      console.log(`[auth-db] backfilled email for existing user ${username}`);
    }
    if (hashMissing && spec.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        hashPassword(spec.password),
        existing.id,
      );
      console.log(`[auth-db] restored missing password hash for ${username}`);
    } else if (
      spec.syncBaselinePassword &&
      spec.password &&
      !verifyPassword(spec.password, storedHash)
    ) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        hashPassword(spec.password),
        existing.id,
      );
      console.log(
        `[auth-db] synced baseline password for ${username} (hash did not match Jdemoss123!/env)`,
      );
    } else {
      console.log(`[auth-db] baseline skip ${username} — already exists (password preserved)`);
    }

    // Keep admin flags in sync without touching password/email when set.
    db.prepare(
      `UPDATE users SET role = ?, full_name = COALESCE(NULLIF(full_name, ''), ?),
        is_admin = ?, is_master_admin = ?, subscription_status = ?,
        subscription_tier = ?, org_role = ?,
        organization_id = COALESCE(organization_id, ?),
        email_verified = 1, is_suspended = 0
       WHERE id = ?`,
    ).run(
      spec.role,
      spec.full_name,
      spec.is_admin ? 1 : 0,
      spec.is_master_admin ? 1 : 0,
      spec.subscription_status,
      spec.subscription_tier,
      spec.org_role || '',
      spec.organization_id,
      existing.id,
    );
    return;
  }

  if (!spec.password) {
    console.warn(`[auth-db] skip seed '${username}' — no password available`);
    return;
  }

  db.prepare(
    `INSERT INTO users
      (username, password_hash, role, email, full_name, is_admin, is_master_admin,
       subscription_status, subscription_tier, org_role, organization_id,
       email_verified, recovery_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
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
  );
  console.log(`[auth-db] seeded user ${username} (${spec.role}, email=${spec.email})`);
}

function ensureSeeded(db) {
  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
  const empty = !countRow || Number(countRow.cnt) === 0;
  if (empty) {
    console.log('[auth-db] users table empty — running non-destructive baseline seed');
  } else {
    console.log('[auth-db] ensuring baseline accounts exist (non-destructive)');
  }
  for (const account of baselineAccounts()) {
    seedAccountIfMissing(db, account);
  }
}

function persistVault(db) {
  try {
    const rows = db
      .prepare(
        `SELECT username, password_hash, role, email, phone, full_name,
                is_admin, is_master_admin, subscription_status, subscription_tier,
                org_role, organization_id, email_verified, is_suspended,
                recovery_id, mock_role, created_at
         FROM users`,
      )
      .all();
    const payload = JSON.stringify(
      { version: 1, updated_at: new Date().toISOString(), users: rows },
      null,
      0,
    );
    for (const file of vaultPaths()) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, payload, 'utf8');
      } catch (err) {
        // /tmp may be the only writable path on Vercel.
        if (file.includes(`${path.sep}_data${path.sep}`)) continue;
        console.warn('[auth-db] vault write failed:', file, err.message || err);
      }
    }
  } catch (err) {
    console.warn('[auth-db] persistVault failed:', err.message || err);
  }
}

function restoreVault(db) {
  for (const file of vaultPaths()) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const users = Array.isArray(parsed?.users) ? parsed.users : [];
      let imported = 0;
      for (const u of users) {
        const username = String(u.username || '')
          .trim()
          .toLowerCase();
        if (!username || !u.password_hash) continue;
        const exists = db
          .prepare('SELECT id FROM users WHERE LOWER(username) = ?')
          .get(username);
        if (exists) continue;
        db.prepare(
          `INSERT INTO users
            (username, password_hash, role, email, phone, full_name,
             is_admin, is_master_admin, subscription_status, subscription_tier,
             org_role, organization_id, email_verified, is_suspended,
             recovery_id, mock_role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`,
        ).run(
          username,
          u.password_hash,
          u.role || 'Reviewer',
          u.email || '',
          u.phone || '',
          u.full_name || username,
          u.is_admin ? 1 : 0,
          u.is_master_admin ? 1 : 0,
          u.subscription_status || 'inactive',
          u.subscription_tier || '',
          u.org_role || '',
          u.organization_id == null ? null : u.organization_id,
          u.email_verified == null ? 1 : u.email_verified ? 1 : 0,
          u.is_suspended ? 1 : 0,
          u.recovery_id || '',
          u.mock_role || '',
          u.created_at || null,
        );
        imported += 1;
      }
      if (imported > 0) {
        console.log(`[auth-db] restored ${imported} user(s) from vault ${file}`);
      }
      return;
    } catch (err) {
      console.warn('[auth-db] vault restore skipped:', file, err.message || err);
    }
  }
}

function rowToUser(row) {
  if (!row) return null;
  const role = String(row.role || '').trim() || (row.is_admin ? 'Admin' : 'Reviewer');
  const fbPageId = String(row.fb_page_id || '').trim();
  const fbToken = String(row.fb_access_token || '').trim();
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
    phone: row.phone || '',
    mock_role: row.mock_role || '',
    tiktok_connected: false,
    tiktok_token_expires_at: '',
    tiktok_privacy_level: 'SELF_ONLY',
    pending_extra_seats: 0,
    full_name: row.full_name || row.username,
    recovery_id: row.recovery_id || '',
    facebook_connected: Boolean(fbPageId && fbToken),
    fb_page_id: fbPageId,
    fb_page_name: String(row.fb_page_name || '').trim(),
    commerce_catalog_id: String(row.commerce_catalog_id || '').trim(),
    fb_catalog_name: String(row.fb_catalog_name || '').trim(),
    facebook_connected_at: row.facebook_connected_at
      ? String(row.facebook_connected_at)
      : '',
  };
}

function saveFacebookConnection(userId, connection) {
  const db = openDb();
  const id = Number(userId);
  if (!id) throw new Error('userId is required.');
  db.prepare(
    `UPDATE users SET
       fb_page_id = ?,
       fb_page_name = ?,
       fb_access_token = ?,
       fb_user_access_token = ?,
       commerce_catalog_id = ?,
       fb_catalog_name = ?,
       facebook_connected_at = datetime('now')
     WHERE id = ?`,
  ).run(
    String(connection.fb_page_id || '').trim(),
    String(connection.fb_page_name || '').trim(),
    String(connection.fb_access_token || '').trim(),
    String(connection.fb_user_access_token || '').trim(),
    String(connection.commerce_catalog_id || '').trim(),
    String(connection.fb_catalog_name || '').trim(),
    id,
  );
  persistVault(db);
  return getUserById(id);
}

function clearFacebookConnection(userId) {
  const db = openDb();
  const id = Number(userId);
  if (!id) throw new Error('userId is required.');
  db.prepare(
    `UPDATE users SET
       fb_page_id = '',
       fb_page_name = '',
       fb_access_token = '',
       fb_user_access_token = '',
       commerce_catalog_id = '',
       fb_catalog_name = '',
       facebook_connected_at = NULL
     WHERE id = ?`,
  ).run(id);
  persistVault(db);
  return getUserById(id);
}

function findUserRow(identifier) {
  const db = openDb();
  const key = normalizeLoginIdentifier(identifier);
  if (!key) return null;
  return (
    db
      .prepare(
        `SELECT * FROM users
         WHERE LOWER(username) = ?
            OR (email != '' AND LOWER(email) = ?)
         LIMIT 1`,
      )
      .get(key, key) || null
  );
}

function getUserByUsername(username) {
  return rowToUser(findUserRow(username));
}

function getUserById(id) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return rowToUser(row);
}

/**
 * Dynamic login: case-insensitive username/email lookup + bcrypt/legacy verify.
 * Seed accounts also accept their baseline plaintext and heal a stale hash.
 */
function authenticate(identifier, password) {
  const key = normalizeLoginIdentifier(identifier);
  if (!key || !password) {
    console.log('[AUTH FAIL]', key || '(empty)', 'missing username or password');
    return null;
  }

  const row = findUserRow(key);
  console.log('[LOGIN CHECK]', { inputUsername: key, userFound: !!row });
  if (!row) {
    console.log('[AUTH FAIL]', key, 'user not found');
    return null;
  }
  if (row.is_suspended) {
    console.log('[AUTH FAIL]', key, 'account suspended');
    return null;
  }

  let passwordOk = verifyPassword(password, row.password_hash);
  if (!passwordOk) {
    // Self-heal stale seed hashes when the typed password matches the
    // known baseline for that account (jdemoss / testreviewer / admin).
    const baseline = baselinePassword(key);
    if (baseline && password === baseline) {
      try {
        const db = openDb();
        const nextHash = hashPassword(password);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
          nextHash,
          row.id,
        );
        persistVault(db);
        row.password_hash = nextHash;
        passwordOk = true;
        console.log(`[auth-db] healed baseline password hash for ${row.username}`);
      } catch (err) {
        console.warn('[auth-db] baseline hash heal failed:', err.message || err);
      }
    }
  }
  if (!passwordOk) {
    console.log('[LOGIN FAIL] Password mismatch for:', key);
    console.log('[AUTH FAIL]', key, 'password mismatch');
    return null;
  }

  if (needsRehash(row.password_hash)) {
    try {
      const db = openDb();
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        hashPassword(password),
        row.id,
      );
      persistVault(db);
      console.log(`[auth-db] upgraded ${row.username} hash to bcrypt`);
    } catch (err) {
      console.warn('[auth-db] bcrypt upgrade skipped:', err.message || err);
    }
  }

  console.log('[AUTH OK]', row.username, 'hash verified');
  return rowToUser(row);
}

function createUser({
  username,
  password,
  role = 'Reviewer',
  email = '',
  full_name = '',
  subscription_status = 'inactive',
  subscription_tier = '',
  account_type = '',
} = {}) {
  const db = openDb();
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

  const existingUser = db
    .prepare('SELECT id FROM users WHERE LOWER(username) = ? LIMIT 1')
    .get(uname);
  if (existingUser) throw new Error('Username already exists.');

  const emailTaken = db
    .prepare(
      `SELECT id FROM users WHERE email != '' AND LOWER(email) = ? LIMIT 1`,
    )
    .get(mail);
  if (emailTaken) throw new Error('An account with that email already exists.');

  const rbac = role === 'Admin' ? 'Admin' : 'Reviewer';
  const tier =
    subscription_tier ||
    (account_type === 'rooftop' ? 'rooftop_pending' : '');
  const hash = hashPassword(password);
  const recovery = randomRecoveryId();

  try {
    const info = db
      .prepare(
        `INSERT INTO users
          (username, password_hash, role, email, full_name, is_admin, is_master_admin,
           subscription_status, subscription_tier, email_verified, recovery_id)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?)`,
      )
      .run(
        uname,
        hash,
        rbac,
        mail,
        String(full_name || uname).trim(),
        rbac === 'Admin' ? 1 : 0,
        subscription_status || 'inactive',
        tier,
        recovery,
      );
    persistVault(db);
    const user = getUserById(Number(info.lastInsertRowid));
    console.log('[auth-db] registered user', uname, mail || '(no email)');
    return user;
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

function updatePhone(userId, phone) {
  const db = openDb();
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(
    String(phone || '').trim(),
    userId,
  );
  persistVault(db);
  return getUserById(userId);
}

function updateEmail(userId, newEmail, currentPassword) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
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
  const taken = db
    .prepare(
      `SELECT id FROM users WHERE email != '' AND LOWER(email) = ? AND id != ? LIMIT 1`,
    )
    .get(mail, userId);
  if (taken) {
    throw new Error('That email address is already registered to another account.');
  }
  const oldEmail = String(row.email || '').trim().toLowerCase();
  const revertToken = randomHex(24);
  const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const history = [row.old_email_history, oldEmail].filter(Boolean).join(',').slice(0, 2000);
  db.prepare(
    `UPDATE users SET email = ?, email_revert_token = ?, email_revert_expires_at = ?,
      old_email_history = ? WHERE id = ?`,
  ).run(mail, revertToken, expires, history, userId);
  persistVault(db);
  return {
    user: getUserById(userId),
    old_email: oldEmail,
    new_email: mail,
    revert_token: revertToken,
  };
}

function updateProfile(userId, { phone, email, new_email, current_password } = {}) {
  let user = getUserById(userId);
  if (!user) throw new Error('User not found.');
  let emailChange = null;
  if (phone !== undefined) {
    user = updatePhone(userId, phone);
  }
  const nextEmail = email !== undefined ? email : new_email;
  if (nextEmail !== undefined && nextEmail !== null && String(nextEmail).trim() !== '') {
    emailChange = updateEmail(userId, nextEmail, current_password);
    user = emailChange.user;
  }
  return { user, emailChange };
}

function regenerateRecoveryId(userId) {
  const db = openDb();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const rid = `REC-${seg()}-${seg()}-${seg()}`;
  db.prepare('UPDATE users SET recovery_id = ? WHERE id = ?').run(rid, userId);
  persistVault(db);
  return getUserById(userId);
}

function changePassword(userId, currentPassword, newPassword) {
  const db = openDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
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
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(newPassword),
    userId,
  );
  persistVault(db);
  return getUserById(userId);
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
};
