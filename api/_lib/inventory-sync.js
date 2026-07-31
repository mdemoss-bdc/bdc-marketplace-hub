/**
 * Inventory sync engine for Vercel / Neon.
 *
 * Multi-adapter strategy (Dealer.com, DealerOn, DealerSpike, Sincro/Ansira):
 * detect platform from homepage/SRP HTML → adapter extract → normalize →
 * upsert into marketplace_inventory by VIN. Moses sitemap remains a DealerOn
 * supplement when the SRP shell is thin.
 */
const { randomHex } = require('./random-token');
const {
  query,
  queryOne,
  ensureCoreSchema,
  databaseUrl,
} = require('./pg');
const { sanitizeInventoryList, decodeHtmlEntities: decodeEntitiesShared } = require('./inventoryParser');
const {
  parseInventoryPage,
  detectPlatform,
  parsePrice,
  parseMileage,
  parseColor,
} = require('./platform-adapters');
const { resolveInventoryTargetUrls } = require('./scraper-settings');

const VDP_ENRICH_CAP = Number(process.env.INVENTORY_VDP_ENRICH_CAP || 200);

const SCRAPER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; BDCMarketplaceHub/1.0; +https://bdcmanager.com)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** @type {Map<number, object>} */
const JOBS = new Map();

function defaultJob(userId = 0) {
  return {
    user_id: userId,
    syncing: false,
    phase: 'idle',
    synced: 0,
    total: 0,
    enriched: 0,
    done: true,
    error: '',
    reason: '',
    session_id: '',
    cancel_status: '',
    last_sync: '',
    started_at: 0,
  };
}

function getJob(userId = 0) {
  if (!JOBS.has(userId)) JOBS.set(userId, defaultJob(userId));
  return JOBS.get(userId);
}

function patchJob(userId, patch) {
  const job = { ...getJob(userId), ...patch, user_id: userId };
  JOBS.set(userId, job);
  return job;
}

async function persistLastSync(iso) {
  if (!databaseUrl()) return;
  await ensureCoreSchema();
  await query(
    `INSERT INTO marketplace_settings (key, value) VALUES ('inventory_last_sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [iso],
  );
}

async function readLastSync() {
  try {
    if (!databaseUrl()) return '';
    await ensureCoreSchema();
    const row = await queryOne(
      `SELECT value FROM marketplace_settings WHERE key = 'inventory_last_sync'`,
    );
    if (row?.value) return String(row.value);
    const max = await queryOne(
      `SELECT MAX(last_seen) AS last_sync FROM marketplace_inventory`,
    );
    return max?.last_sync ? String(max.last_sync) : '';
  } catch {
    return '';
  }
}

function decodeHtmlEntities(value) {
  return decodeEntitiesShared(value);
}

function urlSeg(s) {
  return String(s || '')
    .replace(/\+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function conditionFromUrl(url) {
  const path = String(url || '').toLowerCase();
  if (path.includes('/new-') || path.includes('-new-') || /\/new\//.test(path)) {
    return 'New';
  }
  return 'Used';
}

function parseVdpUrl(rawUrl) {
  const decoded = decodeHtmlEntities(rawUrl);
  const path = decoded.split('/').pop() || '';
  const vinM = path.match(/-([A-HJ-NPR-Z0-9]{17})$/i);
  if (!vinM) return null;
  const vin = vinM[1].toUpperCase();
  const condition = conditionFromUrl(decoded);
  let remainder = path.slice(condition.length + 1);
  remainder = remainder.slice(0, -(vin.length + 1));
  const yearM = remainder.match(/-(\d{4})-/);
  if (!yearM) return null;
  const year = Number.parseInt(yearM[1], 10);
  const locRaw = urlSeg(remainder.slice(0, yearM.index));
  const afterYear = remainder.slice(yearM.index + yearM[0].length);
  const mkParts = afterYear.split('-');
  const make = urlSeg(mkParts[0] || '');
  const modelTrim = mkParts.slice(1);
  const modelSegs = [];
  let trim = '';
  for (let i = 0; i < modelTrim.length; i += 1) {
    const seg = modelTrim[i];
    if (modelSegs.join('').replace(/\s+/g, '').length < 3) {
      modelSegs.push(seg);
    } else {
      trim = modelTrim.slice(i).map(urlSeg).join(' ');
      break;
    }
  }
  const model = urlSeg(modelSegs.join('-'));
  if (!make || !year) return null;
  let vdp = decoded;
  if (!/^https?:\/\//i.test(vdp)) {
    vdp = decoded.startsWith('/') ? decoded : `/${decoded}`;
  }
  return {
    vin,
    year,
    make,
    model,
    trim,
    condition,
    location: locRaw,
    vdp_url: vdp,
    status: 'ACTIVE',
    dealership_group: '',
  };
}

async function fetchText(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: SCRAPER_HEADERS,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSitemapVehicles(siteOrigin) {
  if (!siteOrigin) return [];
  const sitemapUrl =
    process.env.INVENTORY_SITEMAP_URL ||
    `${String(siteOrigin).replace(/\/$/, '')}/sitemap.xml`;
  try {
    const xml = await fetchText(sitemapUrl, 30000);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1]);
    const vehicles = [];
    for (const loc of locs) {
      const parsed = parseVdpUrl(loc);
      if (parsed) {
        if (parsed.vdp_url.startsWith('/') && siteOrigin) {
          parsed.vdp_url = `${siteOrigin.replace(/\/$/, '')}${parsed.vdp_url}`;
        }
        vehicles.push(parsed);
      }
    }
    return vehicles;
  } catch (err) {
    console.warn('[inventory-sync] sitemap fetch failed:', err.message || err);
    return [];
  }
}

async function fetchListingPageVehicles(url, condition, dealerName = '') {
  try {
    const html = await fetchText(url, 30000);
    const { platform, vehicles } = await parseInventoryPage(html, url, condition);
    console.log(
      `[inventory-sync] adapter=${platform} url=${url} vehicles=${vehicles.length}`,
    );
    return vehicles.map((v) => ({
      ...v,
      dealership_group: v.dealership_group || dealerName || '',
      condition: condition || v.condition || 'Used',
    }));
  } catch (err) {
    console.warn('[inventory-sync] listing fetch failed:', url, err.message || err);
    return [];
  }
}

/**
 * Probe homepage + configured inventory Target URLs, then scrape each source.
 */
async function collectViaAdapters(targets, onProgress) {
  const { url_used, url_new, dealer_name } = targets;
  const sources = [];
  if (url_used) sources.push({ url: url_used, condition: 'Used' });
  if (url_new) sources.push({ url: url_new, condition: 'New' });

  if (!sources.length) {
    throw new Error(
      'No inventory Target URL configured. Save Used/New inventory URLs in Marketplace settings first.',
    );
  }

  let homepagePlatform = 'unknown';
  let siteOrigin = '';
  try {
    siteOrigin = new URL(sources[0].url).origin;
    const homeHtml = await fetchText(`${siteOrigin}/`, 20000);
    homepagePlatform = detectPlatform(homeHtml, `${siteOrigin}/`);
    console.log(`[inventory-sync] homepage platform=${homepagePlatform} origin=${siteOrigin}`);
    onProgress?.({ phase: 'discovering', platform: homepagePlatform });
  } catch (err) {
    console.warn('[inventory-sync] homepage probe failed:', err.message || err);
  }

  const byVin = new Map();
  for (const src of sources) {
    const rows = await fetchListingPageVehicles(src.url, src.condition, dealer_name);
    for (const v of rows) {
      if (v?.vin) byVin.set(String(v.vin).toUpperCase(), v);
    }
    onProgress?.({
      phase: 'discovering',
      platform: homepagePlatform,
      synced: byVin.size,
      total: byVin.size,
    });
  }

  // Sitemap supplement when SRP is thin (DealerOn / unknown shells).
  if (byVin.size < 25 || homepagePlatform === 'dealeron' || homepagePlatform === 'unknown') {
    const sitemapRows = await fetchSitemapVehicles(siteOrigin);
    for (const v of sitemapRows) {
      const key = String(v.vin || '').toUpperCase();
      if (!key) continue;
      if (dealer_name && !v.dealership_group) v.dealership_group = dealer_name;
      const prev = byVin.get(key);
      byVin.set(key, prev ? { ...v, ...prev, vin: key } : v);
    }
  }

  return {
    platform: homepagePlatform,
    vehicles: [...byVin.values()],
    url_used,
    url_new,
  };
}

/**
 * Best-effort VDP page enrichment for missing price / mileage / colors.
 * Caps requests so serverless sync stays within timeout budgets.
 */
async function enrichVehiclesFromVdp(vehicles, onProgress) {
  const targets = vehicles.filter(
    (v) =>
      v?.vdp_url &&
      (!Number(v.price) || !Number(v.mileage) || !v.exterior_color),
  );
  const slice = targets.slice(0, Math.max(0, VDP_ENRICH_CAP));
  let enriched = 0;
  for (const v of slice) {
    try {
      const html = await fetchText(v.vdp_url, 12000);
      const price =
        parsePrice(
          (html.match(/data-(?:internet-)?price=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/data-(?:selling|final)-price=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/data-msrp=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/"(?:internetPrice|sellingPrice|finalPrice|price)"\s*:\s*"?([\d,.]+)"?/i) ||
              [])[1] ||
            (html.match(/\$\s*([\d,]+)/) || [])[1],
        ) || Number(v.price) || 0;
      const mileage =
        parseMileage(
          (html.match(/data-(?:mileage|miles|odometer)=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/"(?:mileage|miles|odometer)"\s*:\s*"?([\d,]+)"?/i) || [])[1] ||
            (html.match(/([\d,]+)\s*(?:mi|miles)\b/i) || [])[1],
        ) || Number(v.mileage) || 0;
      const exterior =
        parseColor(
          (html.match(/data-(?:exterior-)?color=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/data-ext(?:erior)?-color=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/"(?:exteriorColor|extColor|color|ext_color_generic)"\s*:\s*"([^"]+)"/i) ||
              [])[1] ||
            (html.match(/Exterior(?:\s*Color)?\s*[:\-]\s*([A-Za-z][A-Za-z0-9 \-/]{2,40})/i) || [])[1],
        ) || v.exterior_color || '';
      const stock =
        (html.match(/data-stock(?:-number)?=["']([^"']+)["']/i) || [])[1] ||
        (html.match(/"(?:stockNumber|stock_number|stock)"\s*:\s*"([^"]+)"/i) || [])[1] ||
        '';
      if (price > 0) v.price = price;
      if (mileage > 0) v.mileage = mileage;
      if (exterior) v.exterior_color = exterior;
      const interior =
        parseColor(
          (html.match(/data-interior-color=["']([^"']+)["']/i) || [])[1] ||
            (html.match(/"(?:interiorColor|intColor)"\s*:\s*"([^"]+)"/i) || [])[1],
        ) || v.interior_color || '';
      if (interior) v.interior_color = interior;
      if (stock && !/^(?:19|20)\d{2}$/.test(String(stock).trim())) {
        v.stock_number = String(stock).trim();
        v.stockNumber = v.stock_number;
      }
      enriched += 1;
      onProgress?.({ enriched, total: slice.length });
    } catch {
      /* skip single VDP failures */
    }
  }
  return enriched;
}

async function upsertVehicles(userId, vehicles) {
  if (!vehicles.length) return 0;
  await ensureCoreSchema();
  const clean = sanitizeInventoryList(vehicles);
  let upserted = 0;
  for (const v of clean) {
    const vin = String(v.vin || '').trim().toUpperCase();
    if (!vin) continue;
    const inFeed = v.in_meta_feed === true || v.in_meta_feed === 1
      ? 1
      : String(v.posted_status || '').toLowerCase() === 'posted'
        ? 1
        : 0;
    await query(
      `INSERT INTO marketplace_inventory (
         user_id, vin, stock_number, condition, year, make, model, trim,
         mileage, price, exterior_color, interior_color, image_url, status,
         location, dealership_group, vdp_url, posted_status, in_meta_feed,
         ai_description, last_seen
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,
         $9,$10,$11,$12,$13,$14,
         $15,$16,$17,$18,$19,
         $20, CURRENT_TIMESTAMP
       )
       ON CONFLICT (user_id, vin) DO UPDATE SET
         stock_number = COALESCE(NULLIF(EXCLUDED.stock_number, ''), marketplace_inventory.stock_number),
         condition = COALESCE(NULLIF(EXCLUDED.condition, ''), marketplace_inventory.condition),
         year = CASE WHEN EXCLUDED.year > 0 THEN EXCLUDED.year ELSE marketplace_inventory.year END,
         make = COALESCE(NULLIF(EXCLUDED.make, ''), marketplace_inventory.make),
         model = COALESCE(NULLIF(EXCLUDED.model, ''), marketplace_inventory.model),
         trim = COALESCE(NULLIF(EXCLUDED.trim, ''), marketplace_inventory.trim),
         mileage = CASE WHEN EXCLUDED.mileage > 0 THEN EXCLUDED.mileage ELSE marketplace_inventory.mileage END,
         price = CASE WHEN EXCLUDED.price > 0 THEN EXCLUDED.price ELSE marketplace_inventory.price END,
         exterior_color = COALESCE(NULLIF(EXCLUDED.exterior_color, ''), marketplace_inventory.exterior_color),
         interior_color = COALESCE(NULLIF(EXCLUDED.interior_color, ''), marketplace_inventory.interior_color),
         image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), marketplace_inventory.image_url),
         status = 'ACTIVE',
         location = COALESCE(NULLIF(EXCLUDED.location, ''), marketplace_inventory.location),
         dealership_group = COALESCE(NULLIF(EXCLUDED.dealership_group, ''), marketplace_inventory.dealership_group),
         vdp_url = COALESCE(NULLIF(EXCLUDED.vdp_url, ''), marketplace_inventory.vdp_url),
         last_seen = CURRENT_TIMESTAMP`,
      [
        userId,
        vin,
        String(v.stock_number || ''),
        String(v.condition || 'Used'),
        Number(v.year) || 0,
        String(v.make || ''),
        String(v.model || ''),
        String(v.trim || ''),
        Number(v.mileage) || 0,
        Number(v.price) || 0,
        String(v.exterior_color || ''),
        String(v.interior_color || ''),
        String(v.image_url || ''),
        'ACTIVE',
        String(v.location || ''),
        String(v.dealership_group || 'Moses Auto Group'),
        String(v.vdp_url || ''),
        String(v.posted_status || 'not_posted'),
        inFeed,
        String(v.ai_description || ''),
      ],
    );
    upserted += 1;
  }
  return upserted;
}

function shouldCancel(userId) {
  const job = getJob(userId);
  return job.cancel_status === 'cancelling' || job.reason === 'cancelled';
}

/**
 * Run a full inventory sync against the configured Target URLs.
 */
async function runInventorySync(userId = 0, sessionId = '', options = {}) {
  const uid = Number(userId) || 0;
  const sid = sessionId || `sync_${randomHex(8)}`;
  patchJob(uid, {
    syncing: true,
    phase: 'discovering',
    synced: 0,
    total: 0,
    enriched: 0,
    done: false,
    error: '',
    reason: '',
    session_id: sid,
    cancel_status: 'running',
    started_at: Date.now(),
  });

  try {
    if (!databaseUrl()) {
      throw new Error('DATABASE_URL / POSTGRES_URL is required for inventory sync.');
    }
    await ensureCoreSchema();

    const targets = await resolveInventoryTargetUrls(options);
    console.log(
      `[inventory-sync] targets used=${targets.url_used || '(none)'} new=${targets.url_new || '(none)'} dealer=${targets.dealer_name || ''}`,
    );
    patchJob(uid, {
      reason: `url:${targets.url_used || targets.url_new || 'unset'}`,
    });

    const collected = await collectViaAdapters(targets, (progress) => {
      patchJob(uid, {
        phase: progress.phase || 'discovering',
        synced: progress.synced || 0,
        total: progress.total || 0,
        reason: progress.platform ? `platform:${progress.platform}` : '',
      });
    });
    let vehicles = collected.vehicles;
    patchJob(uid, {
      total: vehicles.length,
      synced: vehicles.length,
      phase: 'discovering',
      reason: `platform:${collected.platform || 'unknown'}`,
    });

    if (shouldCancel(uid)) {
      patchJob(uid, {
        syncing: false,
        done: true,
        phase: 'idle',
        reason: 'cancelled',
        cancel_status: 'cancelled',
      });
      return getJob(uid);
    }

    patchJob(uid, { phase: 'enriching' });
    await enrichVehiclesFromVdp(vehicles, (p) => {
      patchJob(uid, {
        phase: 'enriching',
        enriched: p.enriched || 0,
        total: vehicles.length,
      });
    });

    // Upsert in chunks so status polls see progress.
    const chunkSize = 40;
    let upserted = 0;
    for (let i = 0; i < vehicles.length; i += chunkSize) {
      if (shouldCancel(uid)) {
        const iso = new Date().toISOString();
        await persistLastSync(iso);
        patchJob(uid, {
          syncing: false,
          done: true,
          phase: 'idle',
          reason: 'cancelled',
          cancel_status: 'cancelled',
          synced: upserted,
          last_sync: iso,
        });
        return getJob(uid);
      }
      const chunk = vehicles.slice(i, i + chunkSize);
      upserted += await upsertVehicles(uid, chunk);
      patchJob(uid, {
        synced: upserted,
        enriched: upserted,
        total: vehicles.length,
        phase: 'enriching',
      });
    }

    const iso = new Date().toISOString();
    await persistLastSync(iso);
    patchJob(uid, {
      syncing: false,
      done: true,
      phase: 'idle',
      synced: upserted,
      enriched: upserted,
      total: vehicles.length,
      error: '',
      reason: upserted > 0 ? 'ok' : 'empty',
      cancel_status: '',
      last_sync: iso,
      url_used: targets.url_used,
      url_new: targets.url_new,
    });
    console.log(`[inventory-sync] user=${uid} upserted=${upserted} session=${sid}`);
    return getJob(uid);
  } catch (err) {
    console.error('[inventory-sync] failed', err);
    patchJob(uid, {
      syncing: false,
      done: true,
      phase: 'idle',
      error: err.message || String(err),
      reason: 'error',
      cancel_status: '',
    });
    return getJob(uid);
  }
}

function requestCancel(userId = 0, sessionId = '') {
  const uid = Number(userId) || 0;
  const job = getJob(uid);
  if (sessionId && job.session_id && sessionId !== job.session_id) {
    return { ...job, error: 'session_mismatch' };
  }
  return patchJob(uid, {
    cancel_status: 'cancelling',
    phase: 'cancelling',
    reason: 'cancelled',
  });
}

async function statusPayload(userId = 0) {
  const uid = Number(userId) || 0;
  const job = getJob(uid);
  const lastSync = job.last_sync || (await readLastSync());
  let vehicleCount = 0;
  try {
    if (databaseUrl()) {
      await ensureCoreSchema();
      const row = await queryOne(
        `SELECT COUNT(*)::int AS c FROM marketplace_inventory WHERE UPPER(status)='ACTIVE'`,
      );
      vehicleCount = Number(row?.c) || 0;
    }
  } catch {
    /* ignore */
  }
  return {
    syncing: Boolean(job.syncing),
    phase: job.phase || 'idle',
    synced: Number(job.synced) || 0,
    total: Number(job.total) || 0,
    enriched: Number(job.enriched) || 0,
    done: job.done !== false && !job.syncing,
    error: job.error || '',
    reason: job.reason || '',
    last_sync: lastSync,
    vehicle_count: vehicleCount,
    user_id: uid,
    session_id: job.session_id || '',
    cancel_status: job.cancel_status || '',
  };
}

/**
 * Schedule sync work so Vercel can keep the isolate alive after the response
 * when `@vercel/functions` waitUntil is available; otherwise run inline.
 */
async function startInventorySync(userId = 0, options = {}) {
  const uid = Number(userId) || 0;
  const existing = getJob(uid);
  if (existing.syncing) {
    return {
      status: 'already_running',
      phase: existing.phase || 'unknown',
      count: existing.synced || 0,
      synced: existing.synced || 0,
      total: existing.total || 0,
      enriched: existing.enriched || 0,
      message: 'A sync is already running.',
      user_id: uid,
      session_id: existing.session_id || '',
    };
  }

  const targets = await resolveInventoryTargetUrls(options);
  if (!targets.url_used && !targets.url_new) {
    return {
      status: 'error',
      success: false,
      error:
        'No inventory Target URL configured. Save Used/New inventory URLs in Marketplace settings first.',
      message:
        'No inventory Target URL configured. Save Used/New inventory URLs in Marketplace settings first.',
      count: 0,
      user_id: uid,
    };
  }

  const sessionId = `sync_${randomHex(8)}`;
  patchJob(uid, {
    syncing: true,
    phase: 'starting',
    synced: 0,
    total: 0,
    enriched: 0,
    done: false,
    error: '',
    reason: '',
    session_id: sessionId,
    cancel_status: 'running',
  });

  const work = runInventorySync(uid, sessionId, options);

  let deferred = false;
  try {
    // Optional: keep running after the HTTP response on Vercel.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { waitUntil } = require('@vercel/functions');
    if (typeof waitUntil === 'function') {
      waitUntil(work);
      deferred = true;
    }
  } catch {
    deferred = false;
  }

  if (!deferred) {
    // Serverless-safe fallback: complete the sitemap sync before responding
    // so Neon is populated even when the isolate freezes after the response.
    await work;
  } else {
    // Give discovery a brief head-start so the first status poll isn't empty.
    await Promise.race([
      new Promise((r) => setTimeout(r, 50)),
      work,
    ]);
  }

  return {
    status: 'started',
    message: 'Syncing inventory…',
    purged: 0,
    user_id: uid,
    session_id: sessionId,
    url_used: targets.url_used,
    url_new: targets.url_new,
    dealer_name: targets.dealer_name,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getJob,
  startInventorySync,
  runInventorySync,
  requestCancel,
  statusPayload,
  readLastSync,
  resolveInventoryTargetUrls,
};
