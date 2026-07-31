/**
 * Marketplace scraper / Meta settings — persisted in marketplace_settings.
 * Used by Admin Console + inventory sync so Target URLs are never hardcoded.
 */
const fs = require('fs');
const path = require('path');
const { query, queryOne, ensureCoreSchema } = require('./pg');

const SETTINGS_KEY = 'scraper_config';

const DEFAULTS = {
  inventory_url_used: '',
  inventory_url_new: '',
  inventory_locations: [],
  salesperson_filter: '',
  scraper_frequency: 'daily',
  dealer_name: '',
  facebook_business_manager_id: '',
  commerce_catalog_id: '',
  meta_pixel_id: '',
  user_id: 0,
};

function normalizeLocations(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      location_name: String(item?.location_name || item?.name || '').trim(),
      inventory_url_new: String(item?.inventory_url_new || item?.new_url || '').trim(),
      inventory_url_used: String(item?.inventory_url_used || item?.used_url || '').trim(),
      csv_enabled: Boolean(item?.csv_enabled),
      csv_url: String(item?.csv_url || '').trim(),
    }))
    .filter(
      (loc) =>
        loc.location_name ||
        loc.inventory_url_new ||
        loc.inventory_url_used ||
        loc.csv_url ||
        loc.csv_enabled,
    );
}

function normalizeSettings(raw = {}) {
  const locations = normalizeLocations(raw.inventory_locations);
  const used =
    String(raw.inventory_url_used || '').trim() ||
    locations.find((l) => l.inventory_url_used)?.inventory_url_used ||
    '';
  const neu =
    String(raw.inventory_url_new || '').trim() ||
    locations.find((l) => l.inventory_url_new)?.inventory_url_new ||
    '';
  let locs = locations;
  if (!locs.length && (used || neu)) {
    locs = [
      {
        location_name: String(raw.dealer_name || 'Main Lot').trim() || 'Main Lot',
        inventory_url_used: used,
        inventory_url_new: neu,
        csv_enabled: false,
        csv_url: '',
      },
    ];
  }
  return {
    ...DEFAULTS,
    ...raw,
    inventory_url_used: used,
    inventory_url_new: neu,
    inventory_locations: locs,
    salesperson_filter: String(raw.salesperson_filter || ''),
    scraper_frequency: String(raw.scraper_frequency || 'daily'),
    dealer_name: String(raw.dealer_name || ''),
    facebook_business_manager_id: String(raw.facebook_business_manager_id || ''),
    commerce_catalog_id: String(raw.commerce_catalog_id || ''),
    meta_pixel_id: String(raw.meta_pixel_id || ''),
    user_id: Number(raw.user_id) || 0,
  };
}

function normUrl(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function urlFingerprint(used, neu, locations) {
  const parts = new Set();
  for (const u of [used, neu]) {
    const n = normUrl(u);
    if (n) parts.add(n);
  }
  for (const loc of locations || []) {
    for (const key of ['inventory_url_used', 'inventory_url_new']) {
      const n = normUrl(loc?.[key]);
      if (n) parts.add(n);
    }
  }
  return [...parts].sort();
}

/** True when Target URL set/domain meaningfully changes. */
function urlsChanged(prev, next) {
  const prevFp = urlFingerprint(
    prev.inventory_url_used,
    prev.inventory_url_new,
    prev.inventory_locations,
  );
  const nextFp = urlFingerprint(
    next.inventory_url_used,
    next.inventory_url_new,
    next.inventory_locations,
  );
  if (!nextFp.length) return false;
  if (!prevFp.length) return true;
  if (prevFp.join('|') !== nextFp.join('|')) return true;
  const prevHosts = new Set(prevFp.map(hostOf).filter(Boolean));
  const nextHosts = new Set(nextFp.map(hostOf).filter(Boolean));
  if (!nextHosts.size) return false;
  if (prevHosts.size !== nextHosts.size) return true;
  for (const h of nextHosts) {
    if (!prevHosts.has(h)) return true;
  }
  return false;
}

async function wipeUserInventory(userId) {
  const uid = Number(userId) || 0;
  if (uid > 0) {
    const r = await query(`DELETE FROM marketplace_inventory WHERE user_id = $1`, [uid]);
    return r?.rowCount ?? 0;
  }
  // Single-tenant / unset user_id — purge the whole showroom for the new URL.
  const r = await query(`DELETE FROM marketplace_inventory`);
  return r?.rowCount ?? 0;
}

function clearFeedCaches() {
  const roots = [
    process.cwd(),
    path.join(process.cwd(), 'artifacts', 'api-server'),
    path.join(process.cwd(), 'api'),
    '/tmp',
  ];
  const names = [
    'meta-feed.csv',
    'meta-feed.xml',
    'tiktok-feed.xml',
    'tiktok-feed.csv',
    path.join('feeds', 'meta-feed.csv'),
    path.join('feeds', 'tiktok-feed.xml'),
    path.join('cache', 'meta-feed.csv'),
    path.join('cache', 'tiktok-feed.xml'),
  ];
  const removed = [];
  for (const root of roots) {
    for (const rel of names) {
      const full = path.isAbsolute(rel) ? rel : path.join(root, rel);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          fs.unlinkSync(full);
          removed.push(full);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

async function getScraperSettings() {
  await ensureCoreSchema();
  const row = await queryOne(
    `SELECT value FROM marketplace_settings WHERE key = $1`,
    [SETTINGS_KEY],
  );
  if (!row?.value) return { ...DEFAULTS };
  try {
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveScraperSettings(payload = {}) {
  await ensureCoreSchema();
  const current = await getScraperSettings();
  const next = normalizeSettings({ ...current, ...payload });
  let inventoryWiped = false;
  let wipedCount = 0;

  if (urlsChanged(current, next)) {
    wipedCount = await wipeUserInventory(next.user_id || current.user_id);
    clearFeedCaches();
    inventoryWiped = true;
    console.log(
      `[scraper-settings] Target URL change — wiped ${wipedCount} inventory rows + feed caches`,
    );
  }

  await query(
    `INSERT INTO marketplace_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTINGS_KEY, JSON.stringify(next)],
  );
  return {
    ...next,
    inventoryWiped,
    wipedCount,
    message: inventoryWiped
      ? 'Previous inventory purged for new target URL.'
      : undefined,
  };
}

/**
 * Resolve Used/New inventory Target URLs from settings, request overrides, then env.
 * Never force Moses Auto Group when a dealer has configured their own URLs.
 */
async function resolveInventoryTargetUrls(overrides = {}) {
  const saved = await getScraperSettings().catch(() => ({ ...DEFAULTS }));
  const locs = normalizeLocations(
    overrides.inventory_locations || saved.inventory_locations,
  );

  const usedCandidates = [
    overrides.inventory_url_used,
    overrides.url_used,
    overrides.used_url,
    saved.inventory_url_used,
    ...locs.map((l) => l.inventory_url_used),
    process.env.INVENTORY_URL_USED,
  ];
  const newCandidates = [
    overrides.inventory_url_new,
    overrides.url_new,
    overrides.new_url,
    saved.inventory_url_new,
    ...locs.map((l) => l.inventory_url_new),
    process.env.INVENTORY_URL_NEW,
  ];

  const pick = (list) => {
    for (const u of list) {
      const s = String(u || '').trim();
      if (/^https?:\/\//i.test(s)) return s;
    }
    return '';
  };

  const url_used = pick(usedCandidates);
  const url_new = pick(newCandidates);
  const dealer_name = String(
    overrides.dealer_name || saved.dealer_name || '',
  ).trim();

  return {
    url_used,
    url_new,
    dealer_name,
    settings: saved,
    locations: locs,
  };
}

module.exports = {
  getScraperSettings,
  saveScraperSettings,
  resolveInventoryTargetUrls,
  normalizeSettings,
  normalizeLocations,
  urlsChanged,
  wipeUserInventory,
  clearFeedCaches,
  DEFAULTS,
  SETTINGS_KEY,
};
