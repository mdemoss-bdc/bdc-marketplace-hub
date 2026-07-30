/**
 * Marketplace queue + inventory helpers for Vercel/Node serverless routes.
 * Mirrors the Python marketplace_engine / MarketplaceDB JSON contracts so the
 * Hub never receives HTML 404 bodies (which caused "Unexpected token 'T'").
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DAILY_POST_CAP = 10;
const VALID_STATUSES = new Set(['scheduled', 'posted', 'failed', 'paused']);

let _db = null;
let _dbFile = null;

function candidateDbPaths() {
  const env =
    process.env.MARKETPLACE_DB_PATH ||
    process.env.SQLITE_PATH ||
    process.env.AUTH_DB_PATH ||
    '';
  const roots = [
    env,
    path.join(__dirname, '..', '..', 'artifacts', 'api-server', 'bdc_production.db'),
    path.join(process.cwd(), 'artifacts', 'api-server', 'bdc_production.db'),
    path.join(__dirname, '..', '_data', 'marketplace.db'),
  ].filter(Boolean);

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    roots.push(path.join('/tmp', 'bdc-marketplace.db'));
  }
  return roots;
}

function resolveDbPath() {
  for (const file of candidateDbPaths()) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* skip */
    }
  }
  // Prefer writable fallback for cold starts with no shipped SQLite file.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join('/tmp', 'bdc-marketplace.db');
  }
  return path.join(__dirname, '..', '_data', 'marketplace.db');
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplace_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      is_demo INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mq_status ON marketplace_queue(status);
    CREATE INDEX IF NOT EXISTS idx_mq_posted_at ON marketplace_queue(posted_at);

    CREATE TABLE IF NOT EXISTS marketplace_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      ai_description TEXT DEFAULT '',
      last_seen TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, vin)
    );

    CREATE TABLE IF NOT EXISTS posting_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, queue_date, vin)
    );
  `);
}

function openMarketplaceDb() {
  const file = resolveDbPath();
  if (_db && _dbFile === file) return _db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  _db = new DatabaseSync(file);
  _dbFile = file;
  ensureSchema(_db);
  return _db;
}

function emptyQuota() {
  return {
    posts_today: 0,
    daily_cap: DAILY_POST_CAP,
    remaining: DAILY_POST_CAP,
    cap_reached: false,
    label: `0 / ${DAILY_POST_CAP} posts today`,
    window: '08:00–21:00',
  };
}

function emptyPublisherQueue() {
  return {
    success: true,
    items: [],
    total: 0,
    counts: { scheduled: 0, posted: 0, failed: 0, paused: 0 },
    quota: emptyQuota(),
    queue: [],
  };
}

function emptyInventory() {
  return {
    success: true,
    inventory: [],
    makes: [],
    models: [],
    years: [],
    locations: [],
    counts: { ACTIVE: 0, SOLD: 0, total: 0, posted: 0 },
    last_sync: '',
  };
}

function rowToPublisherItem(row) {
  const status = VALID_STATUSES.has(row.status) ? row.status : 'scheduled';
  const title = [row.year, row.make, row.model, row.trim]
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== '')
    .join(' ')
    .trim();
  return {
    id: row.id,
    vin: row.vin || '',
    stock_number: row.stock_number || '',
    year: Number(row.year) || 0,
    make: row.make || '',
    model: row.model || '',
    trim: row.trim || '',
    price: Number(row.price) || 0,
    status,
    scheduled_time: row.scheduled_time || null,
    posted_at: row.posted_at || null,
    ai_description: row.ai_description || '',
    error_message: row.error_message || '',
    vehicle_title: title || row.vin || 'Vehicle',
    scheduled_local: row.scheduled_time || null,
    posted_local: row.posted_at || null,
    in_window: null,
    minutes_until_post: null,
    overdue: false,
  };
}

function postsToday(db) {
  const day = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM marketplace_queue
       WHERE status = 'posted' AND posted_at IS NOT NULL AND posted_at LIKE ?`,
    )
    .get(`${day}%`);
  return Number(row?.c) || 0;
}

function quotaPayload(used) {
  const remaining = Math.max(0, DAILY_POST_CAP - used);
  return {
    posts_today: used,
    daily_cap: DAILY_POST_CAP,
    remaining,
    cap_reached: used >= DAILY_POST_CAP,
    label: `${used} / ${DAILY_POST_CAP} posts today`,
    window: '08:00–21:00',
  };
}

function getPublisherQueue(statusFilter) {
  try {
    const db = openMarketplaceDb();
    let rows;
    if (statusFilter && VALID_STATUSES.has(statusFilter)) {
      rows = db
        .prepare(
          `SELECT * FROM marketplace_queue WHERE status = ?
           ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'failed' THEN 1
           WHEN 'paused' THEN 2 ELSE 3 END,
           COALESCE(scheduled_time, posted_at, created_at) ASC`,
        )
        .all(statusFilter);
    } else {
      rows = db
        .prepare(
          `SELECT * FROM marketplace_queue
           ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'failed' THEN 1
           WHEN 'paused' THEN 2 ELSE 3 END,
           COALESCE(scheduled_time, posted_at, created_at) ASC`,
        )
        .all();
    }
    const items = rows.map(rowToPublisherItem);
    const counts = { scheduled: 0, posted: 0, failed: 0, paused: 0 };
    for (const item of items) {
      counts[item.status] = (counts[item.status] || 0) + 1;
    }
    return {
      success: true,
      items,
      total: items.length,
      counts,
      quota: quotaPayload(postsToday(db)),
      queue: items,
    };
  } catch (err) {
    console.error('[marketplace] getPublisherQueue', err);
    return emptyPublisherQueue();
  }
}

function listInventory(query = {}) {
  try {
    const db = openMarketplaceDb();
    const clauses = [];
    const params = [];

    const status = String(query.status || 'ACTIVE').trim() || 'ACTIVE';
    if (status.toUpperCase() !== 'ALL') {
      clauses.push('UPPER(status) = UPPER(?)');
      params.push(status);
    }
    if (query.condition) {
      clauses.push('LOWER(condition) = LOWER(?)');
      params.push(String(query.condition));
    }
    if (query.make) {
      clauses.push('LOWER(make) = LOWER(?)');
      params.push(String(query.make));
    }
    if (query.model) {
      clauses.push('LOWER(model) = LOWER(?)');
      params.push(String(query.model));
    }
    if (query.location) {
      clauses.push('LOWER(location) = LOWER(?)');
      params.push(String(query.location));
    }
    if (query.posted_status) {
      clauses.push('LOWER(COALESCE(posted_status, \'not_posted\')) = LOWER(?)');
      params.push(String(query.posted_status));
    }
    const minPrice = Number(query.min_price) || 0;
    const maxPrice = Number(query.max_price) || 0;
    const minYear = Number(query.min_year) || 0;
    const maxYear = Number(query.max_year) || 0;
    if (minPrice > 0) {
      clauses.push('price >= ?');
      params.push(minPrice);
    }
    if (maxPrice > 0) {
      clauses.push('price <= ?');
      params.push(maxPrice);
    }
    if (minYear > 0) {
      clauses.push('year >= ?');
      params.push(minYear);
    }
    if (maxYear > 0) {
      clauses.push('year <= ?');
      params.push(maxYear);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const inventory = db
      .prepare(
        `SELECT * FROM marketplace_inventory ${where}
         ORDER BY condition ASC, year DESC, price ASC`,
      )
      .all(...params);

    const makes = db
      .prepare(
        `SELECT DISTINCT make FROM marketplace_inventory
         WHERE make != '' AND UPPER(status)='ACTIVE' ORDER BY make`,
      )
      .all()
      .map((r) => r.make);
    const models = db
      .prepare(
        `SELECT DISTINCT model FROM marketplace_inventory
         WHERE model != '' AND UPPER(status)='ACTIVE' ORDER BY model`,
      )
      .all()
      .map((r) => r.model);
    const years = db
      .prepare(
        `SELECT DISTINCT year FROM marketplace_inventory
         WHERE year > 0 ORDER BY year ASC`,
      )
      .all()
      .map((r) => r.year);
    const locations = db
      .prepare(
        `SELECT DISTINCT location FROM marketplace_inventory
         WHERE location != '' ORDER BY location`,
      )
      .all()
      .map((r) => r.location);

    const active = db
      .prepare(
        `SELECT COUNT(*) AS c FROM marketplace_inventory WHERE UPPER(status)='ACTIVE'`,
      )
      .get();
    const sold = db
      .prepare(
        `SELECT COUNT(*) AS c FROM marketplace_inventory WHERE UPPER(status)='SOLD'`,
      )
      .get();
    const posted = db
      .prepare(
        `SELECT COUNT(*) AS c FROM marketplace_inventory
         WHERE LOWER(COALESCE(posted_status,'')) IN ('posted','queued')`,
      )
      .get();
    const last = db
      .prepare(`SELECT MAX(last_seen) AS last_sync FROM marketplace_inventory`)
      .get();

    return {
      success: true,
      inventory,
      makes,
      models,
      years,
      locations,
      counts: {
        ACTIVE: Number(active?.c) || 0,
        SOLD: Number(sold?.c) || 0,
        total: (Number(active?.c) || 0) + (Number(sold?.c) || 0),
        posted: Number(posted?.c) || 0,
      },
      last_sync: last?.last_sync || '',
    };
  } catch (err) {
    console.error('[marketplace] listInventory', err);
    return emptyInventory();
  }
}

function findVehicleByVin(db, vin) {
  return db
    .prepare(
      `SELECT * FROM marketplace_inventory WHERE UPPER(vin) = UPPER(?) LIMIT 1`,
    )
    .get(vin);
}

function scheduleVehicle({ vin, ai_description, publish_now, scheduled_time }) {
  const cleanVin = String(vin || '').trim().toUpperCase();
  if (!cleanVin) {
    const err = new Error('vin is required.');
    err.status = 400;
    throw err;
  }

  const db = openMarketplaceDb();
  const vehicle = findVehicleByVin(db, cleanVin);
  if (!vehicle) {
    const err = new Error(`VIN ${cleanVin} not found in inventory`);
    err.status = 404;
    throw err;
  }

  const used = postsToday(db);
  if (publish_now && used >= DAILY_POST_CAP) {
    const err = new Error(
      `Daily cap reached (${used}/${DAILY_POST_CAP}) — cannot publish now.`,
    );
    err.status = 429;
    err.quota = quotaPayload(used);
    throw err;
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const description =
    ai_description != null
      ? String(ai_description)
      : vehicle.ai_description ||
        `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim();

  const status = publish_now ? 'posted' : 'scheduled';
  const sched = publish_now
    ? null
    : scheduled_time ||
      new Date(Date.now() + 45 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const postedAt = publish_now ? nowIso : null;

  const existing = db
    .prepare(
      `SELECT id FROM marketplace_queue
       WHERE vin = ? AND status IN ('scheduled','paused')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(cleanVin);

  let rowId;
  let action;
  if (existing) {
    db.prepare(
      `UPDATE marketplace_queue SET status=?, scheduled_time=?, posted_at=?,
       ai_description=?, error_message='' WHERE id=?`,
    ).run(status, sched, postedAt, description, existing.id);
    rowId = existing.id;
    action = 'updated';
  } else {
    const result = db
      .prepare(
        `INSERT INTO marketplace_queue
          (vin, stock_number, year, make, model, trim, price,
           status, scheduled_time, posted_at, ai_description, is_demo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        cleanVin,
        vehicle.stock_number || '',
        Number(vehicle.year) || 0,
        vehicle.make || '',
        vehicle.model || '',
        vehicle.trim || '',
        Number(vehicle.price) || 0,
        status,
        sched,
        postedAt,
        description,
      );
    rowId = Number(result.lastInsertRowid) || 0;
    action = publish_now ? 'published' : 'scheduled';
  }

  const row = db.prepare(`SELECT * FROM marketplace_queue WHERE id = ?`).get(rowId);
  return {
    success: true,
    status: 'ok',
    action,
    item: row ? rowToPublisherItem(row) : null,
    quota: quotaPayload(postsToday(db)),
  };
}

function setQueueStatus({ id, status, error_message }) {
  if (!VALID_STATUSES.has(status)) {
    const err = new Error(`status must be one of ${[...VALID_STATUSES].join(', ')}`);
    err.status = 400;
    throw err;
  }
  const db = openMarketplaceDb();
  const row = db.prepare(`SELECT id FROM marketplace_queue WHERE id = ?`).get(Number(id));
  if (!row) {
    const err = new Error(`Queue item ${id} not found`);
    err.status = 404;
    throw err;
  }
  if (status === 'posted') {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare(
      `UPDATE marketplace_queue SET status=?, posted_at=?, error_message='' WHERE id=?`,
    ).run(status, nowIso, Number(id));
  } else {
    db.prepare(
      `UPDATE marketplace_queue SET status=?, error_message=? WHERE id=?`,
    ).run(status, String(error_message || ''), Number(id));
  }
  const updated = db.prepare(`SELECT * FROM marketplace_queue WHERE id = ?`).get(Number(id));
  return {
    success: true,
    item: updated ? rowToPublisherItem(updated) : null,
    quota: quotaPayload(postsToday(db)),
  };
}

function getDailyPostingQueue(userId, date) {
  try {
    const db = openMarketplaceDb();
    const target = date || new Date().toISOString().slice(0, 10);
    const uid = Number(userId) || 0;
    const queue = db
      .prepare(
        `SELECT * FROM posting_queue WHERE user_id = ? AND queue_date = ?
         ORDER BY scheduled_time ASC, id ASC`,
      )
      .all(uid, target);
    const statsRows = db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM posting_queue
         WHERE user_id = ? AND queue_date = ? GROUP BY status`,
      )
      .all(uid, target);
    const stats = { Pending: 0, Posted: 0, Skipped: 0, total: 0, date: target };
    for (const r of statsRows) {
      if (r.status in stats) stats[r.status] = Number(r.c) || 0;
      stats.total += Number(r.c) || 0;
    }
    return { success: true, queue, stats };
  } catch (err) {
    console.error('[marketplace] getDailyPostingQueue', err);
    const target = date || new Date().toISOString().slice(0, 10);
    return {
      success: true,
      queue: [],
      stats: { Pending: 0, Posted: 0, Skipped: 0, total: 0, date: target },
    };
  }
}

module.exports = {
  DAILY_POST_CAP,
  emptyPublisherQueue,
  emptyInventory,
  getPublisherQueue,
  listInventory,
  scheduleVehicle,
  setQueueStatus,
  getDailyPostingQueue,
  openMarketplaceDb,
};
