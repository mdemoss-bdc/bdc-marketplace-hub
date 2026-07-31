/**
 * Meta Commerce Manager — Automotive inventory catalog feed builder.
 * Reads ACTIVE vehicles from Neon and emits CSV / XML (RSS items) / JSON.
 */
const { queryAll, ensureCoreSchema, databaseUrl } = require('./pg');

const META_IMAGE_FALLBACK =
  'https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=1200&q=80';

const DEALER_NAME = process.env.DEALER_NAME || 'Moses Auto Group';
const DEALER_SITE =
  process.env.DEALER_SITE_URL ||
  process.env.INVENTORY_URL_USED ||
  'https://www.mosescars.com';

function validUrl(raw) {
  const s = String(raw || '').trim();
  return /^https?:\/\/.+\..+/.test(s);
}

function httpsUrl(url) {
  const s = String(url || '').trim();
  if (s.startsWith('http://')) return `https://${s.slice('http://'.length)}`;
  return s;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function csvQuote(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function intSafe(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function siteBase() {
  try {
    const u = new URL(DEALER_SITE);
    return httpsUrl(`${u.protocol}//${u.host}`);
  } catch {
    return 'https://www.mosescars.com';
  }
}

/**
 * Map a Neon inventory row → Meta automotive catalog item.
 */
function normalizeRow(vehicle) {
  const vinRaw = String(vehicle.vin || '').trim().toUpperCase();
  let stock = String(vehicle.stock_number || '').trim();
  const inTransit = /^in[\s-]?transit$/i.test(stock);
  // Treat Unavailable like N/A — keep the row, never use sentinel as item id.
  if (['n/a', 'na', 'none', '-', '—', 'unavailable'].includes(stock.toLowerCase())) stock = '';
  const dbId = String(vehicle.id || '').trim();
  // Synthetic IT*/UV* ids and non-17-char placeholders are not Meta VINs.
  const realVin =
    vinRaw.length === 17 &&
    !vinRaw.startsWith('IT') &&
    !vinRaw.startsWith('UV') &&
    /^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw)
      ? vinRaw
      : '';
  // Keep In Transit / Unavailable rows in the catalog; never use sentinels as id.
  const id = realVin || (!inTransit && stock ? stock : '') || (dbId ? `STOCK-${dbId}` : '');
  if (!id) return null;

  const make = String(vehicle.make || '').trim() || 'Vehicle';
  const model = String(vehicle.model || '').trim() || make;
  const trim = String(vehicle.trim || '').trim();
  const yearI = intSafe(vehicle.year, 0);
  const year = yearI >= 1900 && yearI <= 2100 ? String(yearI) : String(new Date().getFullYear());

  const title = [year, make, model, trim].filter(Boolean).join(' ');
  const milesI = Math.max(0, intSafe(vehicle.mileage, 0));
  let priceI = intSafe(vehicle.price, 0);
  if (priceI <= 0) priceI = intSafe(vehicle.retail_price, 0);

  const condRaw = String(vehicle.condition || '').trim().toLowerCase();
  const condition = condRaw === 'new' ? 'new' : 'used';
  const statusRaw = String(vehicle.status || 'ACTIVE').trim().toUpperCase();
  const availability = statusRaw === 'ACTIVE' ? 'in stock' : 'out of stock';

  const milesLabel = milesI > 0 ? `${milesI.toLocaleString()} miles` : 'mileage unavailable';
  const priceLabel = priceI > 0 ? `$${priceI.toLocaleString()}` : 'price available on request';
  const stockBit = inTransit
    ? ' In Transit.'
    : stock
      ? ` Stock #${stock}.`
      : '';
  const description = (
    `${title} — ${milesLabel}, listed at ${priceLabel}. ` +
    `${condition === 'new' ? 'New' : 'Used'} inventory from ${DEALER_NAME}.${stockBit}`
  ).slice(0, 5000);

  let url = '';
  const vdp = String(vehicle.vdp_url || vehicle.link || '').trim();
  if (validUrl(vdp)) url = httpsUrl(vdp);
  else url = siteBase();

  const imgRaw = String(vehicle.image_url || '').trim();
  const image_link = validUrl(imgRaw) ? httpsUrl(imgRaw) : META_IMAGE_FALLBACK;

  return {
    id,
    title,
    description,
    url,
    link: url, // Meta CSV / legacy column
    image_link,
    price: `${Math.max(priceI, 0)} USD`,
    availability,
    condition,
    year,
    make,
    model,
    trim,
    vin: realVin,
    mileage: {
      value: milesI,
      unit: 'MI',
    },
    'mileage.value': String(milesI),
    'mileage.unit': 'MI',
    brand: make,
  };
}

async function fetchActiveVehicles({ userId, limit = 5000, feedOnly = true } = {}) {
  if (!databaseUrl()) {
    throw new Error('DATABASE_URL / POSTGRES_URL is required for the catalog feed.');
  }
  await ensureCoreSchema();
  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
  const uid = userId == null || userId === '' ? null : Number(userId);
  // Meta feed only includes vehicles explicitly added via "Add to Feed"
  // (in_meta_feed=1) — fall back to legacy posted_status for older rows.
  const feedClause = feedOnly
    ? `AND (in_meta_feed = 1 OR LOWER(COALESCE(posted_status,'')) = 'posted')`
    : '';
  if (uid != null && Number.isFinite(uid)) {
    return queryAll(
      `SELECT * FROM marketplace_inventory
       WHERE UPPER(status) = 'ACTIVE' AND user_id = $1
       ${feedClause}
       ORDER BY year DESC, price ASC
       LIMIT $2`,
      [uid, lim],
    );
  }
  return queryAll(
    `SELECT * FROM marketplace_inventory
     WHERE UPPER(status) = 'ACTIVE'
     ${feedClause}
     ORDER BY year DESC, price ASC
     LIMIT $1`,
    [lim],
  );
}

async function buildCatalogItems(opts = {}) {
  const vehicles = await fetchActiveVehicles(opts);
  const items = [];
  const seen = new Set();
  for (const row of vehicles) {
    const item = normalizeRow(row);
    if (!item) continue;
    let iid = item.id;
    if (seen.has(iid)) iid = `${iid}-${row.id || items.length}`;
    seen.add(iid);
    items.push({ ...item, id: iid });
  }
  return items;
}

function toJson(items) {
  return JSON.stringify(
    {
      success: true,
      format: 'meta_automotive',
      dealer: DEALER_NAME,
      link: siteBase(),
      count: items.length,
      generated_at: new Date().toISOString(),
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        url: item.url,
        image_link: item.image_link,
        price: item.price,
        availability: item.availability,
        condition: item.condition,
        year: item.year,
        make: item.make,
        model: item.model,
        trim: item.trim,
        vin: item.vin,
        mileage: {
          value: item.mileage.value,
          unit: item.mileage.unit,
        },
      })),
    },
    null,
    2,
  );
}

function toRssXml(items) {
  const dealer = escapeXml(DEALER_NAME);
  const link = escapeXml(siteBase());
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    `    <title>${dealer} Automotive Catalog</title>`,
    `    <link>${link}</link>`,
    `    <description>Meta Commerce Manager automotive inventory feed for ${dealer}</description>`,
  ];
  for (const item of items) {
    parts.push('    <item>');
    parts.push(`      <g:id>${escapeXml(item.id)}</g:id>`);
    parts.push(`      <g:title>${escapeXml(item.title)}</g:title>`);
    parts.push(`      <g:description>${escapeXml(item.description)}</g:description>`);
    parts.push(`      <g:link>${escapeXml(item.url)}</g:link>`);
    parts.push(`      <g:image_link>${escapeXml(item.image_link)}</g:image_link>`);
    parts.push(`      <g:price>${escapeXml(item.price)}</g:price>`);
    parts.push(`      <g:availability>${escapeXml(item.availability)}</g:availability>`);
    parts.push(`      <g:condition>${escapeXml(item.condition)}</g:condition>`);
    parts.push(`      <g:brand>${escapeXml(item.make)}</g:brand>`);
    parts.push(`      <g:year>${escapeXml(item.year)}</g:year>`);
    parts.push(`      <g:make>${escapeXml(item.make)}</g:make>`);
    parts.push(`      <g:model>${escapeXml(item.model)}</g:model>`);
    if (item.trim) parts.push(`      <g:trim>${escapeXml(item.trim)}</g:trim>`);
    if (item.vin) parts.push(`      <g:vin>${escapeXml(item.vin)}</g:vin>`);
    parts.push(`      <g:mileage>${escapeXml(item['mileage.value'])} ${escapeXml(item['mileage.unit'])}</g:mileage>`);
    parts.push(`      <g:mileage.value>${escapeXml(item['mileage.value'])}</g:mileage.value>`);
    parts.push(`      <g:mileage.unit>${escapeXml(item['mileage.unit'])}</g:mileage.unit>`);
    parts.push('    </item>');
  }
  parts.push('  </channel>', '</rss>', '');
  return parts.join('\n');
}

function toListingsXml(items) {
  const dealer = escapeXml(DEALER_NAME);
  const link = escapeXml(siteBase());
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<listings>',
    `  <title>${dealer}</title>`,
    `  <link>${link}</link>`,
  ];
  for (const item of items) {
    parts.push('  <listing>');
    parts.push(`    <id>${escapeXml(item.id)}</id>`);
    parts.push(`    <title>${escapeXml(item.title)}</title>`);
    parts.push(`    <description>${escapeXml(item.description)}</description>`);
    parts.push(`    <url>${escapeXml(item.url)}</url>`);
    parts.push(`    <link>${escapeXml(item.link)}</link>`);
    parts.push(`    <image_link>${escapeXml(item.image_link)}</image_link>`);
    parts.push(`    <price>${escapeXml(item.price)}</price>`);
    parts.push(`    <availability>${escapeXml(item.availability)}</availability>`);
    parts.push(`    <condition>${escapeXml(item.condition)}</condition>`);
    parts.push(`    <year>${escapeXml(item.year)}</year>`);
    parts.push(`    <make>${escapeXml(item.make)}</make>`);
    parts.push(`    <model>${escapeXml(item.model)}</model>`);
    parts.push(`    <trim>${escapeXml(item.trim)}</trim>`);
    parts.push(`    <vin>${escapeXml(item.vin)}</vin>`);
    parts.push('    <mileage>');
    parts.push(`      <value>${escapeXml(item['mileage.value'])}</value>`);
    parts.push(`      <unit>${escapeXml(item['mileage.unit'])}</unit>`);
    parts.push('    </mileage>');
    parts.push('  </listing>');
  }
  parts.push('</listings>', '');
  return parts.join('\n');
}

const CSV_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'make',
  'model',
  'year',
  'mileage.value',
  'mileage.unit',
  'vin',
  'trim',
];

function toCsv(items) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const item of items) {
    lines.push(CSV_COLUMNS.map((c) => csvQuote(item[c] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildCatalogItems,
  normalizeRow,
  toJson,
  toRssXml,
  toListingsXml,
  toCsv,
  CSV_COLUMNS,
  DEALER_NAME,
  siteBase,
};
