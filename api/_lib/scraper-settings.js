/**
 * Marketplace scraper / Meta settings — persisted in marketplace_settings.
 * Used by Admin Console + inventory sync so Target URLs are never hardcoded.
 */
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
  await query(
    `INSERT INTO marketplace_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTINGS_KEY, JSON.stringify(next)],
  );
  return next;
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
  DEFAULTS,
  SETTINGS_KEY,
};
