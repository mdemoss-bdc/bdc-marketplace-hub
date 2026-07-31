/**
 * Marketplace queue + inventory helpers — PostgreSQL only on Vercel.
 *
 * Uses DATABASE_URL / POSTGRES_URL via api/_lib/pg.js. Never opens a local
 * SQLite file in serverless environments (that caused "unable to open
 * database file" and wiped ephemeral state).
 */
const {
  query,
  queryOne,
  queryAll,
  ensureCoreSchema,
  databaseUrl,
  isServerless,
} = require('./pg');
const {
  sanitizeInventoryList,
  sanitizeVehicleRecord,
  parseInventoryText,
  cleanVehicleText,
  resolveStockNumber,
  isValidStockNumber,
  stockFallbackFromVin,
} = require('./inventoryParser');

const DAILY_POST_CAP = 10;
const VALID_STATUSES = new Set(['scheduled', 'posted', 'failed', 'paused']);

let _ready = null;

async function openMarketplaceDb() {
  if (!databaseUrl() && isServerless()) {
    throw new Error(
      'DATABASE_URL / POSTGRES_URL required — SQLite is disabled on Vercel.',
    );
  }
  if (!databaseUrl()) {
    throw new Error(
      'DATABASE_URL / POSTGRES_URL is not configured for marketplace storage.',
    );
  }
  if (_ready) return _ready;
  _ready = ensureCoreSchema().catch((err) => {
    _ready = null;
    throw err;
  });
  return _ready;
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
    auto_publish: true,
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

async function readAutoPublishFlag() {
  try {
    const row = await queryOne(
      `SELECT value FROM marketplace_settings WHERE key = 'auto_publish'`,
    );
    if (!row) return true;
    const v = String(row.value || '').trim().toLowerCase();
    return !(v === 'off' || v === '0' || v === 'false' || v === 'paused');
  } catch {
    return true;
  }
}

async function getAutoPublish() {
  try {
    await openMarketplaceDb();
    const enabled = await readAutoPublishFlag();
    return {
      success: true,
      auto_publish: enabled,
      status: enabled ? 'active' : 'paused',
    };
  } catch (err) {
    console.error('[marketplace] getAutoPublish', err);
    return { success: true, auto_publish: true, status: 'active' };
  }
}

async function setAutoPublish(enabled) {
  try {
    await openMarketplaceDb();
    const value = enabled ? 'on' : 'off';
    await query(
      `INSERT INTO marketplace_settings (key, value) VALUES ('auto_publish', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [value],
    );
    return {
      success: true,
      auto_publish: Boolean(enabled),
      status: enabled ? 'active' : 'paused',
    };
  } catch (err) {
    console.error('[marketplace] setAutoPublish', err);
    const e = new Error(err.message || 'Failed to update auto-publish.');
    e.status = 500;
    throw e;
  }
}

async function postsToday() {
  const day = new Date().toISOString().slice(0, 10);
  const row = await queryOne(
    `SELECT COUNT(*)::int AS c FROM marketplace_queue
     WHERE status = 'posted' AND posted_at IS NOT NULL AND posted_at LIKE $1`,
    [`${day}%`],
  );
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

async function getPublisherQueue(statusFilter) {
  try {
    await openMarketplaceDb();
    let rows;
    if (statusFilter && VALID_STATUSES.has(statusFilter)) {
      rows = await queryAll(
        `SELECT * FROM marketplace_queue WHERE status = $1
         ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'failed' THEN 1
         WHEN 'paused' THEN 2 ELSE 3 END,
         COALESCE(scheduled_time, posted_at, created_at::text) ASC`,
        [statusFilter],
      );
    } else {
      rows = await queryAll(
        `SELECT * FROM marketplace_queue
         ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'failed' THEN 1
         WHEN 'paused' THEN 2 ELSE 3 END,
         COALESCE(scheduled_time, posted_at, created_at::text) ASC`,
      );
    }
    const items = rows.map(rowToPublisherItem);
    const counts = { scheduled: 0, posted: 0, failed: 0, paused: 0 };
    for (const item of items) {
      counts[item.status] = (counts[item.status] || 0) + 1;
    }
    const autoPublish = await readAutoPublishFlag();
    const used = await postsToday();
    return {
      success: true,
      items,
      total: items.length,
      counts,
      quota: quotaPayload(used),
      queue: items,
      auto_publish: autoPublish,
    };
  } catch (err) {
    console.error('[marketplace] getPublisherQueue', err);
    return emptyPublisherQueue();
  }
}

async function listInventory(queryParams = {}) {
  try {
    await openMarketplaceDb();
    const clauses = [];
    const params = [];
    let i = 1;

    const userId = Number(queryParams.user_id) || 0;
    if (userId > 0) {
      clauses.push(`user_id = $${i++}`);
      params.push(userId);
    }

    const status = String(queryParams.status || 'ACTIVE').trim() || 'ACTIVE';
    if (status.toUpperCase() !== 'ALL') {
      clauses.push(`UPPER(status) = UPPER($${i++})`);
      params.push(status);
    }
    if (queryParams.condition) {
      clauses.push(`LOWER(condition) = LOWER($${i++})`);
      params.push(String(queryParams.condition));
    }
    if (queryParams.make) {
      clauses.push(`LOWER(make) = LOWER($${i++})`);
      params.push(String(queryParams.make));
    }
    if (queryParams.model) {
      clauses.push(`LOWER(model) = LOWER($${i++})`);
      params.push(String(queryParams.model));
    }
    if (queryParams.location) {
      clauses.push(`LOWER(location) = LOWER($${i++})`);
      params.push(String(queryParams.location));
    }
    if (queryParams.posted_status) {
      clauses.push(
        `LOWER(COALESCE(posted_status, 'not_posted')) = LOWER($${i++})`,
      );
      params.push(String(queryParams.posted_status));
    }
    const minPrice = Number(queryParams.min_price) || 0;
    const maxPrice = Number(queryParams.max_price) || 0;
    const minYear = Number(queryParams.min_year) || 0;
    const maxYear = Number(queryParams.max_year) || 0;
    if (minPrice > 0) {
      clauses.push(`price >= $${i++}`);
      params.push(minPrice);
    }
    if (maxPrice > 0) {
      clauses.push(`price <= $${i++}`);
      params.push(maxPrice);
    }
    if (minYear > 0) {
      clauses.push(`year >= $${i++}`);
      params.push(minYear);
    }
    if (maxYear > 0) {
      clauses.push(`year <= $${i++}`);
      params.push(maxYear);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rawRows = await queryAll(
      `SELECT * FROM marketplace_inventory ${where}
       ORDER BY condition ASC, year DESC, price ASC`,
      params,
    );
    const inventory = sanitizeInventoryList(rawRows).map((row, idx) => {
      const src = rawRows[idx] || {};
      const inFeed =
        Number(src.in_meta_feed) === 1 ||
        String(src.posted_status || '').toLowerCase() === 'posted';
      const year = Number(row.year) || Number(src.year) || 0;
      const price =
        Number(row.price) ||
        Number(src.price) ||
        Number(src.internet_price) ||
        Number(src.list_price) ||
        0;
      const mileage =
        Number(row.mileage) ||
        Number(src.mileage) ||
        Number(src.miles) ||
        Number(src.odometer) ||
        0;
      const make = cleanVehicleText(row.make || src.make || '');
      const model = cleanVehicleText(row.model || src.model || '');
      const trim = cleanVehicleText(row.trim || src.trim || '');
      const exterior = cleanVehicleText(
        row.exterior_color ||
          src.exterior_color ||
          src.exteriorColor ||
          src.ext_color ||
          src.ext_color_generic ||
          src.color ||
          '',
      );
      const interior = cleanVehicleText(
        row.interior_color || src.interior_color || src.interiorColor || '',
      );
      let stock = resolveStockNumber(
        { ...src, ...row, stock_number: row.stock_number || src.stock_number },
        year,
        make,
        model,
        row.vin || src.vin,
      );
      if (!isValidStockNumber(stock, year, make, model)) {
        stock = '';
      }
      return {
        ...row,
        year,
        make,
        model,
        trim,
        price,
        mileage,
        miles: mileage,
        stock_number: stock,
        stockNumber: stock,
        posted_status: inFeed ? 'posted' : String(src.posted_status || 'not_posted'),
        in_meta_feed: inFeed,
        exterior_color: exterior,
        exteriorColor: exterior,
        color: exterior,
        interior_color: interior,
        interiorColor: interior,
        image_url: row.image_url || src.image_url || '',
        vdp_url: row.vdp_url || src.vdp_url || '',
        ai_description: cleanVehicleText(row.ai_description || src.ai_description || ''),
        title: [year, make, model].filter(Boolean).join(' '),
      };
    });

    const userClause = userId > 0 ? 'user_id = $1 AND ' : '';
    const userParams = userId > 0 ? [userId] : [];

    const makes = (
      await queryAll(
        `SELECT DISTINCT make FROM marketplace_inventory
         WHERE ${userClause}make != '' AND UPPER(status)='ACTIVE' ORDER BY make`,
        userParams,
      )
    ).map((r) => r.make);
    const models = (
      await queryAll(
        `SELECT DISTINCT model FROM marketplace_inventory
         WHERE ${userClause}model != '' AND UPPER(status)='ACTIVE' ORDER BY model`,
        userParams,
      )
    ).map((r) => r.model);
    const years = (
      await queryAll(
        `SELECT DISTINCT year FROM marketplace_inventory
         WHERE ${userClause}year > 0 ORDER BY year ASC`,
        userParams,
      )
    ).map((r) => r.year);
    const locations = (
      await queryAll(
        `SELECT DISTINCT location FROM marketplace_inventory
         WHERE ${userClause}location != '' ORDER BY location`,
        userParams,
      )
    ).map((r) => r.location);

    const active = await queryOne(
      `SELECT COUNT(*)::int AS c FROM marketplace_inventory
       WHERE ${userClause}UPPER(status)='ACTIVE'`,
      userParams,
    );
    const sold = await queryOne(
      `SELECT COUNT(*)::int AS c FROM marketplace_inventory
       WHERE ${userClause}UPPER(status)='SOLD'`,
      userParams,
    );
    const posted = await queryOne(
      `SELECT COUNT(*)::int AS c FROM marketplace_inventory
       WHERE ${userClause}(
         in_meta_feed = 1
         OR LOWER(COALESCE(posted_status,'')) IN ('posted','queued')
       )`,
      userParams,
    );
    const last = await queryOne(
      `SELECT MAX(last_seen) AS last_sync FROM marketplace_inventory
       ${userId > 0 ? 'WHERE user_id = $1' : ''}`,
      userParams,
    );

    return {
      success: true,
      inventory,
      vehicles: inventory,
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
      last_sync: last?.last_sync ? String(last.last_sync) : '',
    };
  } catch (err) {
    console.error('[marketplace] listInventory', err);
    return emptyInventory();
  }
}

async function findVehicleByVin(vin) {
  return queryOne(
    `SELECT * FROM marketplace_inventory WHERE UPPER(vin) = UPPER($1) LIMIT 1`,
    [vin],
  );
}

async function scheduleVehicle({ vin, ai_description, publish_now, scheduled_time }) {
  await openMarketplaceDb();
  const cleanVin = String(vin || '').trim().toUpperCase();
  if (!cleanVin) {
    const err = new Error('vin is required.');
    err.status = 400;
    throw err;
  }

  const vehicle = await findVehicleByVin(cleanVin);
  if (!vehicle) {
    const err = new Error(`VIN ${cleanVin} not found in inventory`);
    err.status = 404;
    throw err;
  }

  const used = await postsToday();
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

  const existing = await queryOne(
    `SELECT id FROM marketplace_queue
     WHERE vin = $1 AND status IN ('scheduled','paused')
     ORDER BY id DESC LIMIT 1`,
    [cleanVin],
  );

  let rowId;
  let action;
  if (existing) {
    await query(
      `UPDATE marketplace_queue SET status=$1, scheduled_time=$2, posted_at=$3,
       ai_description=$4, error_message='' WHERE id=$5`,
      [status, sched, postedAt, description, existing.id],
    );
    rowId = existing.id;
    action = 'updated';
  } else {
    const inserted = await queryOne(
      `INSERT INTO marketplace_queue
        (vin, stock_number, year, make, model, trim, price,
         status, scheduled_time, posted_at, ai_description, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0)
       RETURNING id`,
      [
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
      ],
    );
    rowId = Number(inserted?.id) || 0;
    action = publish_now ? 'published' : 'scheduled';
  }

  const row = await queryOne(`SELECT * FROM marketplace_queue WHERE id = $1`, [rowId]);
  return {
    success: true,
    status: 'ok',
    action,
    item: row ? rowToPublisherItem(row) : null,
    quota: quotaPayload(await postsToday()),
  };
}

async function setQueueStatus({ id, status, error_message }) {
  await openMarketplaceDb();
  if (!VALID_STATUSES.has(status)) {
    const err = new Error(`status must be one of ${[...VALID_STATUSES].join(', ')}`);
    err.status = 400;
    throw err;
  }
  const row = await queryOne(`SELECT id FROM marketplace_queue WHERE id = $1`, [
    Number(id),
  ]);
  if (!row) {
    const err = new Error(`Queue item ${id} not found`);
    err.status = 404;
    throw err;
  }
  if (status === 'posted') {
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    await query(
      `UPDATE marketplace_queue SET status=$1, posted_at=$2, error_message='' WHERE id=$3`,
      [status, nowIso, Number(id)],
    );
  } else {
    await query(
      `UPDATE marketplace_queue SET status=$1, error_message=$2 WHERE id=$3`,
      [status, String(error_message || ''), Number(id)],
    );
  }
  const updated = await queryOne(`SELECT * FROM marketplace_queue WHERE id = $1`, [
    Number(id),
  ]);
  return {
    success: true,
    item: updated ? rowToPublisherItem(updated) : null,
    quota: quotaPayload(await postsToday()),
  };
}

async function getDailyPostingQueue(userId, date) {
  try {
    await openMarketplaceDb();
    const target = date || new Date().toISOString().slice(0, 10);
    const uid = Number(userId) || 0;
    const queue = await queryAll(
      `SELECT * FROM posting_queue WHERE user_id = $1 AND queue_date = $2
       ORDER BY scheduled_time ASC, id ASC`,
      [uid, target],
    );
    const statsRows = await queryAll(
      `SELECT status, COUNT(*)::int AS c FROM posting_queue
       WHERE user_id = $1 AND queue_date = $2 GROUP BY status`,
      [uid, target],
    );
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

async function getInventoryByVin(vin) {
  await openMarketplaceDb();
  return findVehicleByVin(String(vin || '').trim().toUpperCase());
}

async function getLatestQueueCopy(vin) {
  await openMarketplaceDb();
  return queryOne(
    `SELECT ai_description FROM marketplace_queue WHERE UPPER(vin) = UPPER($1)
     ORDER BY id DESC LIMIT 1`,
    [vin],
  );
}

/**
 * Toggle Meta catalog feed membership for one or more VINs.
 * Sets both `in_meta_feed` and legacy `posted_status` for Hub badge parity.
 */
async function setFeedStatus({ vins, action, in_meta_feed }) {
  await openMarketplaceDb();
  const list = Array.isArray(vins)
    ? vins.map((v) => String(v || '').trim().toUpperCase()).filter(Boolean)
    : [];
  if (!list.length) {
    const err = new Error('vins must be a non-empty array');
    err.status = 400;
    throw err;
  }

  let enabled;
  if (typeof in_meta_feed === 'boolean') {
    enabled = in_meta_feed;
  } else if (action === 'post' || action === 'add' || action === 'enable') {
    enabled = true;
  } else if (action === 'unpost' || action === 'remove' || action === 'disable') {
    enabled = false;
  } else {
    const err = new Error("action must be 'post' or 'unpost'");
    err.status = 400;
    throw err;
  }

  const postedStatus = enabled ? 'posted' : 'not_posted';
  let updated = 0;
  for (const vin of list) {
    const result = await query(
      `UPDATE marketplace_inventory
       SET in_meta_feed = $1, posted_status = $2, last_seen = CURRENT_TIMESTAMP
       WHERE UPPER(vin) = UPPER($3)`,
      [enabled ? 1 : 0, postedStatus, vin],
    );
    updated += result.rowCount || 0;
  }
  return {
    status: 'ok',
    success: true,
    updated,
    posted_status: postedStatus,
    in_meta_feed: enabled,
  };
}

async function saveVehicleAiDescription(vin, description) {
  await openMarketplaceDb();
  const cleanVin = String(vin || '').trim().toUpperCase();
  const text = String(description || '').trim();
  if (!cleanVin || !text) {
    const err = new Error('vin and description are required.');
    err.status = 400;
    throw err;
  }
  const result = await query(
    `UPDATE marketplace_inventory
     SET ai_description = $1, last_seen = CURRENT_TIMESTAMP
     WHERE UPPER(vin) = UPPER($2)`,
    [text, cleanVin],
  );
  if (!result.rowCount) {
    const err = new Error(`VIN ${cleanVin} not found in inventory`);
    err.status = 404;
    throw err;
  }
  return {
    success: true,
    vin: cleanVin,
    ai_description: text,
    description: text,
  };
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
  getAutoPublish,
  setAutoPublish,
  openMarketplaceDb,
  getInventoryByVin,
  getLatestQueueCopy,
  findVehicleByVin,
  setFeedStatus,
  saveVehicleAiDescription,
  sanitizeInventoryList,
  sanitizeVehicleRecord,
  parseInventoryText,
};
