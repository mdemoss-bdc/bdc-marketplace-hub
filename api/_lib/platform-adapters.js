/**
 * Multi-platform inventory adapters for the Big 4 dealer website stacks:
 * Dealer.com, DealerOn, DealerSpike, and Sincro/Ansira.
 *
 * Flow: detectPlatform(html, url) → adapter.parse(html, url, condition)
 *     → normalizeVehicle() → Neon-ready rows.
 */
const { sanitizeInventoryList, parseInventoryText, scrubRawText } = require('./inventoryParser');

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/i;

const PLATFORM_SIGS = {
  dealercom: [
    'ddc.inventory',
    'ddc.pagedata',
    'window.ddc',
    'static.dealer.com',
    'cdn.dealer.com',
    'dealer.com/js/',
    'ddc.partialstate',
    'data-ddc-widget',
    'ddc-wrapper',
  ],
  dealeron: [
    'dealeron',
    'window.dealeronsrpconfig',
    'window.dealeronsrp',
    'data-vehicle-id=',
    'vehicle-card',
    '/api/inventory/',
    'dealeronwidgets',
    'knockoutroot',
  ],
  dealerspike: [
    'dealerspike',
    'window.vehicles',
    'ds-inventory',
    'cdn.dealerspike',
    'dealerspike.com',
    'dsinv',
  ],
  sincro: [
    'sincro',
    'ansira',
    '__next_data__',
    'sincrodigital.com',
    'cdn.sincrodigital',
    'window.srp_data',
    'window.server_data',
    'sincro-srp',
  ],
};

const PLATFORM_URL_SIGS = {
  dealeron: ['.aspx', 'searchnew', 'searchused', 'dlron.us', 'dealeron'],
  dealercom: ['dealer.com', 'ddc'],
  dealerspike: ['dealerspike'],
  sincro: ['sincro', 'ansira'],
};

function digits(value) {
  const n = Number.parseInt(String(value ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function asStr(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    return String(value.name || value.value || value.url || '').trim();
  }
  return String(value).trim();
}

function firstDefined(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    return v;
  }
  return '';
}

function normCondition(raw, fallback = 'Used') {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '');
  if (['new', 'newvehicle', 'n'].includes(s)) return 'New';
  if (['used', 'preowned', 'certifiedpreowned', 'certified', 'cpo', 'u'].includes(s)) {
    return 'Used';
  }
  return fallback === 'New' ? 'New' : 'Used';
}

function absoluteUrl(base, href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  try {
    return new URL(h, base).toString();
  } catch {
    return h;
  }
}

/**
 * Unified normalizer → Neon marketplace_inventory shape.
 */
function normalizeVehicle(raw, conditionFallback = 'Used', pageUrl = '') {
  if (!raw || typeof raw !== 'object') return null;

  const vin = String(
    firstDefined(
      raw.vin,
      raw.VIN,
      raw.vehicleIdentificationNumber,
      raw.VehicleVin,
      raw.vehicleVin,
    ),
  )
    .trim()
    .toUpperCase();
  if (!VIN_RE.test(vin)) return null;

  const year = digits(
    firstDefined(raw.year, raw.Year, raw.vehicleModelDate, raw.modelDate, raw.model_year),
  );
  const make = asStr(firstDefined(raw.make, raw.Make, raw.brand, raw.manufacturer));
  const model = asStr(firstDefined(raw.model, raw.Model, raw.modelName));
  const trim = asStr(
    firstDefined(raw.trim, raw.Trim, raw.vehicleConfiguration, raw.bodyType, raw.trimLevel),
  );
  const price = digits(
    firstDefined(
      raw.price,
      raw.Price,
      raw.internetPrice,
      raw.askingPrice,
      raw.salePrice,
      raw.msrp,
      raw.MSRP,
      raw.sellingPrice,
    ),
  );
  const stockNumber = asStr(
    firstDefined(
      raw.stockNumber,
      raw.stock_number,
      raw.StockNumber,
      raw.stock,
      raw.sku,
      raw.productID,
    ),
  );
  const mileage = digits(
    firstDefined(
      raw.mileage,
      raw.Mileage,
      raw.odometer,
      typeof raw.mileageFromOdometer === 'object'
        ? raw.mileageFromOdometer?.value
        : raw.mileageFromOdometer,
    ),
  );
  let imageUrl = firstDefined(
    raw.imageUrl,
    raw.image_url,
    raw.ImageUrl,
    raw.photo,
    raw.thumbnail,
    raw.image,
  );
  if (Array.isArray(imageUrl)) imageUrl = imageUrl[0] || '';
  imageUrl = asStr(imageUrl);

  const vdpUrl = absoluteUrl(
    pageUrl,
    firstDefined(raw.vdpUrl, raw.vdp_url, raw.url, raw.link, raw.detailUrl, raw.href),
  );
  const status = asStr(raw.status) || 'ACTIVE';
  const condition = normCondition(
    firstDefined(raw.condition, raw.Condition, raw.type, raw.inventoryType),
    conditionFallback,
  );

  return {
    vin,
    year,
    make,
    model,
    trim,
    price,
    stock_number: stockNumber || 'N/A',
    stockNumber: stockNumber || 'N/A',
    mileage,
    image_url: imageUrl,
    imageUrl,
    vdp_url: vdpUrl,
    vdpUrl,
    status: status.toUpperCase() === 'SOLD' ? 'SOLD' : 'ACTIVE',
    condition,
    exterior_color: asStr(firstDefined(raw.exterior_color, raw.exteriorColor, raw.color)),
    interior_color: asStr(firstDefined(raw.interior_color, raw.interiorColor)),
    location: asStr(firstDefined(raw.location, raw.Location, raw.city)),
  };
}

function looksLikeVehicleObj(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const vin = firstDefined(obj.vin, obj.VIN, obj.vehicleIdentificationNumber, obj.VehicleVin);
  return Boolean(vin && VIN_RE.test(String(vin)));
}

function extractVehiclesRecursive(node, condition, out = [], depth = 0) {
  if (depth > 12 || out.length > 5000) return out;
  if (Array.isArray(node)) {
    for (const item of node) extractVehiclesRecursive(item, condition, out, depth + 1);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (looksLikeVehicleObj(node)) {
    const v = normalizeVehicle(node, condition);
    if (v) out.push(v);
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') {
      extractVehiclesRecursive(val, condition, out, depth + 1);
    }
  }
  return out;
}

function extractBalanced(source, startIdx, openChar, closeChar) {
  const start = source.indexOf(openChar, startIdx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let strQuote = '';
  let esc = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === strQuote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strQuote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractBalancedJson(source, startIdx) {
  return extractBalanced(source, startIdx, '{', '}');
}

/**
 * Parse JSON or JS object/array literals (Dealer sites often omit quotes on keys).
 */
function parseJsLiteral(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }
  try {
    const quoted = raw
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"');
    return JSON.parse(quoted);
  } catch {
    /* continue */
  }
  try {
    // Last resort for true JS literals (no user input — scraper-owned HTML slices).
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${raw});`)();
  } catch {
    return null;
  }
}

function extractAssignedObject(html, assignPattern) {
  const re = new RegExp(assignPattern, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(html))) {
    const from = m.index + m[0].length - 1;
    const slice = html.slice(from);
    const objStart = slice.indexOf('{');
    const arrStart = slice.indexOf('[');
    let literal = null;
    if (arrStart >= 0 && (objStart < 0 || arrStart < objStart)) {
      literal = extractBalanced(html, from + arrStart, '[', ']');
    } else if (objStart >= 0) {
      literal = extractBalancedJson(html, from + objStart);
    }
    if (!literal) continue;
    const parsed = parseJsLiteral(literal);
    if (parsed != null) results.push(parsed);
  }
  return results;
}

function detectPlatform(html, url = '') {
  const urlL = String(url || '').toLowerCase();
  const head = String(html || '').slice(0, 120_000).toLowerCase();

  for (const [platform, sigs] of Object.entries(PLATFORM_URL_SIGS)) {
    if (sigs.some((s) => urlL.includes(s))) return platform;
  }

  // Ordered checks matching user-requested signature priority
  const ordered = ['dealercom', 'dealeron', 'dealerspike', 'sincro'];
  for (const platform of ordered) {
    const sigs = PLATFORM_SIGS[platform] || [];
    if (sigs.some((s) => head.includes(s) || urlL.includes(s))) return platform;
  }

  // Extra Dealer.com markers called out explicitly
  if (
    head.includes('ddc.inventory') ||
    head.includes('ddc.pagedata') ||
    head.includes('dealer.com')
  ) {
    return 'dealercom';
  }
  if (head.includes('dealeron') || /vehicle-card[^>]*data-vin/i.test(html)) {
    return 'dealeron';
  }
  if (head.includes('dealerspike') || head.includes('window.vehicles')) {
    return 'dealerspike';
  }
  if (head.includes('sincro') || head.includes('ansira') || head.includes('__next_data__')) {
    return 'sincro';
  }

  return 'unknown';
}

/** Dealer.com — DDC.inventory / window.DDC JSON blobs */
function parseDealerCom(html, pageUrl, condition) {
  const blobs = [
    ...extractAssignedObject(html, String.raw`DDC\.inventory\s*=\s*`),
    ...extractAssignedObject(html, String.raw`DDC\.pageData\s*=\s*`),
    ...extractAssignedObject(html, String.raw`window\.DDC\s*=\s*`),
    ...extractAssignedObject(html, String.raw`window\.DDC\.inventory\s*=\s*`),
  ];
  const out = [];
  for (const blob of blobs) {
    extractVehiclesRecursive(blob, condition, out);
  }
  // Also scan script tags containing "inventory" arrays with VIN keys
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html))) {
    const body = sm[1] || '';
    if (!/ddc|inventory/i.test(body) || !VIN_RE.test(body)) continue;
    const objs = body.match(/\{[^{}]{0,200}"vin"\s*:\s*"[A-HJ-NPR-Z0-9]{17}"[\s\S]{0,1200}?\}/gi) || [];
    for (const chunk of objs) {
      try {
        const v = normalizeVehicle(JSON.parse(chunk), condition, pageUrl);
        if (v) out.push(v);
      } catch {
        /* ignore */
      }
    }
  }
  return dedupeByVin(out);
}

/** DealerOn — JSON-LD + .vehicle-card / [data-vin] */
function parseDealerOn(html, pageUrl, condition) {
  const out = [];

  // Config blobs
  for (const pat of [
    String.raw`window\.DealerOnSrpConfig\s*=\s*`,
    String.raw`window\.DealerOnSrp\s*=\s*`,
    String.raw`window\.dealerOnConfig\s*=\s*`,
    String.raw`window\.DealerOnInventory\s*=\s*`,
  ]) {
    for (const blob of extractAssignedObject(html, pat)) {
      extractVehiclesRecursive(blob, condition, out);
    }
  }

  // data-vin cards
  const cardRe =
    /<(?:div|li|article|section)[^>]*data-vin=["']([A-HJ-NPR-Z0-9]{17})["'][^>]*>/gi;
  let cm;
  while ((cm = cardRe.exec(html))) {
    const vin = cm[1].toUpperCase();
    const tag = cm[0];
    const da = (name) => {
      const a = tag.match(new RegExp(`data-${name}=["']([^"']*)["']`, 'i'));
      return a ? a[1].trim() : '';
    };
    let vdp = da('href') || da('vdp-url') || da('vdp') || '';
    if (!vdp) {
      const scan = html.slice(cm.index, cm.index + 900);
      const am = scan.match(/<a\s[^>]*href=["']([^"']+)["']/i);
      if (am) vdp = am[1];
    }
    const priceRaw = da('internet-price') || da('asking-price') || da('price') || da('msrp');
    const v = normalizeVehicle(
      {
        vin,
        year: da('year'),
        make: da('make'),
        model: da('model'),
        trim: da('trim'),
        price: priceRaw,
        stockNumber: da('stock') || da('stock-number') || da('stocknum'),
        mileage: da('mileage'),
        imageUrl: da('image-url') || da('image'),
        vdpUrl: vdp,
        condition: da('condition') || condition,
        exteriorColor: da('exterior-color') || da('color'),
      },
      condition,
      pageUrl,
    );
    if (v) out.push(v);
  }

  // JSON-LD often present on DealerOn VDP/SRP
  out.push(...parseJsonLd(html, pageUrl, condition));
  return dedupeByVin(out);
}

/** DealerSpike — window.vehicles or public inventory JSON hints */
function parseDealerSpike(html, pageUrl, condition) {
  const out = [];
  for (const pat of [
    String.raw`window\.vehicles\s*=\s*`,
    String.raw`window\.DSInventory\s*=\s*`,
    String.raw`var\s+vehicles\s*=\s*`,
  ]) {
    for (const payload of extractAssignedObject(html, pat)) {
      extractVehiclesRecursive(payload, condition, out);
    }
  }

  // Common DealerSpike inventory API path embedded in page
  const apiM = html.match(
    /["']((?:https?:)?\/\/[^"']*dealerspike[^"']*\/(?:inventory|vehicles|api)[^"']*)["']/i,
  );
  const rows = dedupeByVin(out);
  if (apiM && rows.length < 5) {
    rows.apiHint = apiM[1].startsWith('//') ? `https:${apiM[1]}` : apiM[1];
  }
  return rows;
}

async function fetchDealerSpikeApi(apiUrl, condition) {
  if (!apiUrl) return [];
  try {
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/json,text/javascript,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; BDCMarketplaceHub/1.0)',
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const out = [];
    extractVehiclesRecursive(data, condition, out);
    return dedupeByVin(out);
  } catch (err) {
    console.warn('[platform-adapters] dealerspike api', err.message || err);
    return [];
  }
}

/** Sincro / Ansira — __NEXT_DATA__ + SRP_DATA */
function parseSincro(html, pageUrl, condition) {
  const out = [];
  for (const pat of [
    String.raw`window\.__NEXT_DATA__\s*=\s*`,
    String.raw`__NEXT_DATA__\s*=\s*`,
    String.raw`window\.SRP_DATA\s*=\s*`,
    String.raw`window\.SERVER_DATA\s*=\s*`,
    String.raw`window\.initialState\s*=\s*`,
  ]) {
    for (const blob of extractAssignedObject(html, pat)) {
      extractVehiclesRecursive(blob, condition, out);
    }
  }
  // <script id="__NEXT_DATA__" type="application/json">
  const nextTag = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextTag) {
    try {
      extractVehiclesRecursive(JSON.parse(nextTag[1]), condition, out);
    } catch {
      /* ignore */
    }
  }
  return dedupeByVin(out);
}

/** Fallback — Schema.org Vehicle / Car JSON-LD */
function parseJsonLd(html, pageUrl, condition) {
  const out = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let blob;
    try {
      blob = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const items = Array.isArray(blob) ? blob : [blob];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const type = String(item['@type'] || '').toLowerCase();
      if (['car', 'vehicle', 'product', 'offer'].includes(type)) {
        const v = normalizeVehicle(
          {
            vin: item.vehicleIdentificationNumber,
            year: item.vehicleModelDate || item.modelDate,
            make: typeof item.brand === 'object' ? item.brand?.name : item.brand,
            model: item.model,
            trim: item.vehicleConfiguration || item.bodyType,
            price: typeof item.offers === 'object' ? item.offers?.price : item.offers,
            stockNumber: item.productID || item.sku,
            mileage:
              typeof item.mileageFromOdometer === 'object'
                ? item.mileageFromOdometer?.value
                : item.mileageFromOdometer,
            imageUrl: Array.isArray(item.image) ? item.image[0] : item.image,
            vdpUrl: item.url,
            exteriorColor: item.color,
          },
          condition,
          pageUrl,
        );
        if (v) out.push(v);
      }
      if (Array.isArray(item['@graph'])) {
        for (const node of item['@graph']) {
          if (node && typeof node === 'object') {
            out.push(
              ...parseJsonLd(
                `<script type="application/ld+json">${JSON.stringify(node)}</script>`,
                pageUrl,
                condition,
              ),
            );
          }
        }
      }
      if (['itemlist', 'offercatalog'].includes(type)) {
        for (const li of item.itemListElement || []) {
          const inner = li?.item || li;
          if (inner && typeof inner === 'object') {
            const v = normalizeVehicle(
              {
                vin: inner.vehicleIdentificationNumber,
                year: inner.vehicleModelDate || inner.modelDate,
                make: typeof inner.brand === 'object' ? inner.brand?.name : inner.brand,
                model: inner.model,
                price: typeof inner.offers === 'object' ? inner.offers?.price : undefined,
                stockNumber: inner.productID || inner.sku,
                imageUrl: Array.isArray(inner.image) ? inner.image[0] : inner.image,
                vdpUrl: inner.url,
              },
              condition,
              pageUrl,
            );
            if (v) out.push(v);
          }
        }
      }
    }
  }
  return dedupeByVin(out);
}

function parseGenericHtml(html, pageUrl, condition) {
  const out = [];
  const text = scrubRawText(html);
  const chunks = text.split(/(?=[A-HJ-NPR-Z0-9]{17})/i).slice(0, 500);
  for (const chunk of chunks) {
    const parsed = parseInventoryText(chunk);
    if (!parsed.vin) continue;
    const v = normalizeVehicle({ ...parsed, condition }, condition, pageUrl);
    if (v) out.push(v);
  }
  return dedupeByVin(out);
}

function dedupeByVin(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.vin) continue;
    const key = String(row.vin).toUpperCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, row);
      continue;
    }
    // Prefer richer row
    map.set(key, {
      ...prev,
      ...Object.fromEntries(
        Object.entries(row).filter(([, val]) => val !== '' && val !== 0 && val != null),
      ),
    });
  }
  return [...map.values()];
}

/**
 * Parse a single inventory/homepage HTML document with auto platform detection.
 */
async function parseInventoryPage(html, pageUrl, condition = 'Used') {
  const platform = detectPlatform(html, pageUrl);
  console.log(`[platform-adapters] detected=${platform} url=${pageUrl}`);

  let vehicles = [];
  switch (platform) {
    case 'dealercom':
      vehicles = parseDealerCom(html, pageUrl, condition);
      break;
    case 'dealeron':
      vehicles = parseDealerOn(html, pageUrl, condition);
      break;
    case 'dealerspike': {
      vehicles = parseDealerSpike(html, pageUrl, condition);
      const apiHint = vehicles.apiHint;
      if (apiHint) {
        const apiRows = await fetchDealerSpikeApi(apiHint, condition);
        vehicles = dedupeByVin([...vehicles, ...apiRows]);
      }
      break;
    }
    case 'sincro':
      vehicles = parseSincro(html, pageUrl, condition);
      break;
    default:
      vehicles = [];
  }

  if (!vehicles.length) {
    vehicles = parseJsonLd(html, pageUrl, condition);
  }
  if (!vehicles.length) {
    vehicles = parseGenericHtml(html, pageUrl, condition);
  }

  const normalized = sanitizeInventoryList(
    vehicles.map((v) => normalizeVehicle(v, condition, pageUrl)).filter(Boolean),
  );

  return {
    platform,
    vehicles: normalized,
    count: normalized.length,
  };
}

module.exports = {
  PLATFORM_SIGS,
  detectPlatform,
  normalizeVehicle,
  parseDealerCom,
  parseDealerOn,
  parseDealerSpike,
  parseSincro,
  parseJsonLd,
  parseGenericHtml,
  parseInventoryPage,
  fetchDealerSpikeApi,
  extractVehiclesRecursive,
  dedupeByVin,
};
