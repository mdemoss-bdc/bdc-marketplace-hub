/**
 * Shared PostgreSQL pool for Vercel/Node serverless.
 * Reads DATABASE_URL / POSTGRES_URL (Neon / Vercel Postgres).
 */
const { Pool } = require('pg');

let _pool = null;
let _schemaReady = null;

function databaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ''
  ).trim();
}

function isServerless() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function requireDatabaseUrl() {
  const url = databaseUrl();
  if (!url) {
    if (isServerless()) {
      throw new Error(
        'DATABASE_URL / POSTGRES_URL must be set on Vercel — SQLite file storage is not supported.',
      );
    }
    throw new Error('DATABASE_URL / POSTGRES_URL is not configured.');
  }
  return url;
}

function getPool() {
  if (_pool) return _pool;
  const connectionString = requireDatabaseUrl();
  _pool = new Pool({
    connectionString,
    ssl:
      process.env.PGSSLMODE === 'disable'
        ? false
        : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 12_000,
  });
  _pool.on('error', (err) => {
    console.error('[pg] pool error', err.message || err);
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

async function queryAll(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/**
 * Create core auth + marketplace tables (PostgreSQL syntax).
 * Safe to call on every cold start.
 */
async function ensureCoreSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) DEFAULT '',
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'Reviewer',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
        mock_role TEXT DEFAULT '',
        email_revert_token TEXT DEFAULT NULL,
        email_revert_expires_at TIMESTAMPTZ DEFAULT NULL,
        old_email_history TEXT DEFAULT '',
        cox_client_id TEXT DEFAULT '',
        cox_client_secret TEXT DEFAULT '',
        cox_dealer_id TEXT DEFAULT '',
        active_session_id TEXT DEFAULT ''
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS marketplace_inventory (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL DEFAULT 0,
        vin TEXT NOT NULL,
        stock_number TEXT DEFAULT '',
        condition TEXT DEFAULT 'Used',
        year INTEGER DEFAULT 0,
        make TEXT DEFAULT '',
        model TEXT DEFAULT '',
        trim TEXT DEFAULT '',
        mileage INTEGER DEFAULT 0,
        price INTEGER DEFAULT 0,
        exterior_color TEXT DEFAULT '',
        interior_color TEXT DEFAULT '',
        image_url TEXT DEFAULT '',
        status TEXT DEFAULT 'ACTIVE',
        location TEXT DEFAULT '',
        dealership_group TEXT DEFAULT '',
        vdp_url TEXT DEFAULT '',
        posted_status TEXT DEFAULT 'not_posted',
        in_meta_feed INTEGER NOT NULL DEFAULT 0,
        ai_description TEXT DEFAULT '',
        last_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, vin)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS marketplace_queue (
        id SERIAL PRIMARY KEY,
        vin TEXT NOT NULL,
        stock_number TEXT NOT NULL DEFAULT '',
        year INTEGER NOT NULL DEFAULT 0,
        make TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        trim TEXT NOT NULL DEFAULT '',
        price INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'scheduled',
        scheduled_time TEXT DEFAULT NULL,
        posted_at TEXT DEFAULT NULL,
        ai_description TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        is_demo INTEGER NOT NULL DEFAULT 0
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS posting_queue (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL DEFAULT 0,
        queue_date TEXT NOT NULL,
        vin TEXT NOT NULL,
        stock_number TEXT DEFAULT '',
        year INTEGER DEFAULT 0,
        make TEXT DEFAULT '',
        model TEXT DEFAULT '',
        trim TEXT DEFAULT '',
        scheduled_time TEXT NOT NULL DEFAULT '',
        status TEXT DEFAULT 'Pending',
        posted_at TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, queue_date, vin)
      );
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS marketplace_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );
    `);

    await query(`CREATE INDEX IF NOT EXISTS idx_mq_status ON marketplace_queue (status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_mi_status ON marketplace_inventory (status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_mi_vin ON marketplace_inventory (vin)`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
        ON users (LOWER(username))
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_lower
        ON users (LOWER(email))
    `);

    // Facebook / Meta OAuth fields (idempotent for existing Neon schemas)
    const fbAlters = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fb_page_id TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fb_page_name TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fb_access_token TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fb_user_access_token TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS commerce_catalog_id TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fb_catalog_name TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS catalog_token TEXT DEFAULT ''",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_connected_at TIMESTAMPTZ DEFAULT NULL',
      'ALTER TABLE marketplace_inventory ADD COLUMN IF NOT EXISTS in_meta_feed INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE marketplace_inventory ADD COLUMN IF NOT EXISTS exterior_color TEXT DEFAULT ''",
      "ALTER TABLE marketplace_inventory ADD COLUMN IF NOT EXISTS interior_color TEXT DEFAULT ''",
    ];
    for (const ddl of fbAlters) {
      try {
        await query(ddl);
      } catch (err) {
        console.warn('[pg] facebook alter skipped:', err.message || err);
      }
    }

    console.log('[pg] core schema ready (users, marketplace_inventory, marketplace_queue)');
  })().catch((err) => {
    _schemaReady = null;
    throw err;
  });
  return _schemaReady;
}

module.exports = {
  databaseUrl,
  isServerless,
  requireDatabaseUrl,
  getPool,
  query,
  queryOne,
  queryAll,
  ensureCoreSchema,
};
