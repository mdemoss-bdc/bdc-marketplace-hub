/**
 * Regex inventory sanitizer & parser (CommonJS mirror for Vercel catch-all).
 * Keep patterns in sync with artifacts/api-server/src/utils/inventoryParser.ts.
 */

const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const PRICE_RE = /\$?\b\d{1,3}(?:,\d{3})*\b/;
const MILEAGE_RE = /\b(\d{1,3}(?:,\d{3})*)\s*(?:mi|miles)\b/i;
const STOCK_LABELED_RE =
  /\b(?:Stock\s*#?\s*:|Stk\s*#?\s*:|Stock\s*Number\s*:|Stock\s*No\.?\s*:|STK\s*#?\s*:|STOCK\s*#|STK\s*#|STOCK|STK|ID)\s*#?\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,14})\b/i;
const STOCK_RE = /\b(?:STK|STOCK|ID)?\s*#?\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,14})\b/i;
const YMM_RE =
  /\b((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9\-]+)\s+([A-Za-z0-9][A-Za-z0-9 \-/]{1,40})/;
const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;
const DOM_NOISE_RE =
  /<(script|style|noscript|header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

const KNOWN_MAKES = new Set([
  'acura', 'alfa', 'aston', 'audi', 'bentley', 'bmw', 'buick', 'cadillac',
  'chevrolet', 'chevy', 'chrysler', 'dodge', 'ferrari', 'fiat', 'ford',
  'genesis', 'gmc', 'honda', 'hyundai', 'infiniti', 'jaguar', 'jeep', 'kia',
  'lamborghini', 'land', 'lexus', 'lincoln', 'lotus', 'maserati', 'mazda',
  'mclaren', 'mercedes', 'mercury', 'mini', 'mitsubishi', 'nissan',
  'porsche', 'ram', 'rivian', 'rolls', 'subaru', 'suzuki', 'tesla',
  'toyota', 'volkswagen', 'vw', 'volvo',
]);

function stripDomNoise(raw) {
  return String(raw || '').replace(DOM_NOISE_RE, ' ');
}

/**
 * Decode HTML entities (&amp;, &#x2B;, &#43;, etc.) without external deps.
 */
function decodeHtmlEntities(input) {
  let s = String(input ?? '');
  // Hex numeric: &#x2B; / &#X2B
  s = s.replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => {
    const cp = Number.parseInt(hex, 16);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
  });
  // Decimal numeric: &#43;
  s = s.replace(/&#(\d+);?/g, (_, dec) => {
    const cp = Number.parseInt(dec, 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
  });
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&plus;/gi, '+');
}

/**
 * Clean dealer text after entity decode — fix "F+150", "Mercedes+Benz", "GX+460".
 */
function cleanVehicleText(input) {
  let s = decodeHtmlEntities(input).replace(/\u00a0/g, ' ').trim();
  if (!s) return '';
  // Ford F-series: F+150 → F-150
  s = s.replace(/\bF\+(\d{2,3})\b/gi, 'F-$1');
  // Mercedes+Benz → Mercedes-Benz
  s = s.replace(/\bMercedes\+Benz\b/gi, 'Mercedes-Benz');
  // Model codes like GX+460 / RX+350 → GX 460
  s = s.replace(/\b([A-Z]{2,4})\+(\d{2,4})\b/g, '$1 $2');
  // Remaining Word+Word → Word-Word
  s = s.replace(/([A-Za-z]{2,})\+([A-Za-z]{2,})/g, '$1-$2');
  // Collapse whitespace
  s = s.replace(WHITESPACE_RE, ' ').trim();
  return s;
}

function scrubRawText(raw) {
  return stripDomNoise(cleanVehicleText(String(raw || '')))
    .replace(HTML_TAG_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

function digitsOnly(value) {
  const cleaned = String(value || '').replace(/[^0-9]/g, '');
  if (!cleaned) return 0;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

function extractVin(text) {
  const m = scrubRawText(text).match(VIN_RE);
  return m ? m[0].toUpperCase() : null;
}

function extractYear(text) {
  const m = scrubRawText(text).match(YEAR_RE);
  if (!m) return null;
  const year = Number.parseInt(m[0], 10);
  const now = new Date().getFullYear() + 2;
  if (year < 1980 || year > now) return null;
  return year;
}

function extractPrice(text) {
  const scrubbed = scrubRawText(text);
  const dollarRe = /\$\s*(\d{1,3}(?:,\d{3})*)\b/g;
  let m;
  while ((m = dollarRe.exec(scrubbed))) {
    const n = digitsOnly(m[1] || m[0]);
    if (n >= 500 && n <= 5_000_000) return n;
  }
  const re = new RegExp(PRICE_RE.source, 'g');
  while ((m = re.exec(scrubbed))) {
    const full = m[0];
    if (full.startsWith('$')) continue;
    const after = scrubbed.slice(m.index + full.length, m.index + full.length + 12).toLowerCase();
    if (/\b(mi|miles)\b/.test(after)) continue;
    const n = digitsOnly(full);
    if (n >= 1900 && n <= 2100) continue;
    if (n < 1000 || n > 5_000_000) continue;
    return n;
  }
  return null;
}

function extractMileage(text) {
  const m = scrubRawText(text).match(MILEAGE_RE);
  if (!m) return null;
  const n = digitsOnly(m[1] || m[0]);
  if (n < 0 || n > 1_000_000) return null;
  return n;
}

function extractExteriorColor(text) {
  const scrubbed = scrubRawText(text);
  const labeled = scrubbed.match(
    /(?:Exterior(?:\s*Color)?|Ext\.?\s*Color|Color)\s*[:\-]\s*([A-Za-z][A-Za-z0-9 \-/]{1,40})/i,
  );
  if (labeled?.[1]) {
    const c = labeled[1].trim();
    if (!/^(n\/?a|none|unknown|select)$/i.test(c)) return c;
  }
  return null;
}

function extractInteriorColor(text) {
  const scrubbed = scrubRawText(text);
  const labeled = scrubbed.match(
    /(?:Interior(?:\s*Color)?|Int\.?\s*Color)\s*[:\-]\s*([A-Za-z][A-Za-z0-9 \-/]{1,40})/i,
  );
  if (labeled?.[1]) {
    const c = labeled[1].trim();
    if (!/^(n\/?a|none|unknown|select)$/i.test(c)) return c;
  }
  return null;
}

/** Reject years, VINs, makes, and empty placeholders as stock numbers. */
const IN_TRANSIT_STOCK = 'In Transit';
const IN_TRANSIT_RE =
  /\b(?:in[\s-]?transit|in[\s-]?production|building|arriving[\s-]?soon|on[\s-]?order|coming[\s-]?soon|pipeline)\b/i;

function isInTransitStock(value) {
  const s = String(value || '').trim();
  return /^in[\s-]?transit$/i.test(s) || s === IN_TRANSIT_STOCK;
}

function detectInTransit(text) {
  return IN_TRANSIT_RE.test(String(text || ''));
}

function isValidStockNumber(value, year = 0, make = '', model = '') {
  const stock = String(value || '').trim();
  if (isInTransitStock(stock)) return true;
  const upper = stock.toUpperCase();
  if (!upper || upper === 'N/A' || upper === 'NA' || upper === 'NONE' || upper === '-' || upper === '—') {
    return false;
  }
  if (upper.length === 17 && VIN_RE.test(upper)) return false;
  // Never treat a model year as a stock number (the "#2020" bug).
  if (/^(?:19|20)\d{2}$/.test(upper)) return false;
  if (year > 0 && upper === String(year)) return false;
  const makeU = String(make || '').toUpperCase().replace(/\s+/g, '');
  const modelU = String(model || '').toUpperCase().replace(/\s+/g, '');
  if (makeU && upper === makeU) return false;
  if (modelU && (upper === modelU || (modelU.startsWith(upper) && upper.length <= 4))) return false;
  if (KNOWN_MAKES.has(upper.toLowerCase())) return false;
  // Require at least one digit for numeric dealer stocks, or alphanumeric mix.
  if (!/[0-9]/.test(upper) && upper.length < 5) return false;
  if (!/^[A-Z0-9][A-Z0-9\-_/]{2,14}$/i.test(upper)) return false;
  return true;
}

/** @deprecated No synthetic VIN stock — always returns "". Kept for API compat. */
function stockFallbackFromVin(_vin) {
  return '';
}

function extractStockNumber(text, year = 0, make = '', model = '') {
  const scrubbed = scrubRawText(text);
  // Only accept explicitly labeled stock tokens — unlabeled matches grab years.
  const labeled = scrubbed.match(STOCK_LABELED_RE);
  if (labeled && labeled[1]) {
    const candidate = labeled[1].toUpperCase();
    if (isValidStockNumber(candidate, year, make, model)) return candidate;
  }
  return null;
}

/**
 * Resolve dealer stock from payload aliases.
 * Missing → "In Transit" if status indicates it, else "" (never VIN/year).
 */
function resolveStockNumber(vehicle, year, make, model, _vin) {
  const candidates = [
    vehicle.stock_number,
    vehicle.stockNumber,
    vehicle.StockNumber,
    vehicle.stockNo,
    vehicle.stock_no,
    vehicle.stock_num,
    vehicle.stockNum,
    vehicle.stock,
    vehicle.Stock,
    vehicle.sku,
    vehicle.SKU,
    vehicle.dealerStockNumber,
    vehicle.dealer_stock_number,
  ];
  for (const c of candidates) {
    const raw = cleanVehicleText(asNonEmptyString(c));
    if (isInTransitStock(raw)) return IN_TRANSIT_STOCK;
    const upper = raw.toUpperCase();
    if (isValidStockNumber(upper, year, make, model)) return upper;
  }
  const statusBlob = [
    vehicle.raw,
    vehicle.raw_html,
    vehicle.raw_text,
    vehicle.description,
    vehicle.title,
    vehicle.availability,
    vehicle.status_label,
    vehicle.badge,
    vehicle.vehicle_status,
  ]
    .map((v) => asNonEmptyString(v))
    .join(' ');
  if (detectInTransit(statusBlob)) return IN_TRANSIT_STOCK;
  return '';
}

function extractYearMakeModel(text) {
  const scrubbed = scrubRawText(text);
  const m = scrubbed.match(YMM_RE);
  if (!m) return { year: null, make: null, model: null };

  const year = Number.parseInt(m[1], 10);
  let make = m[2].trim();
  let modelRaw = m[3].trim();
  modelRaw = modelRaw
    .split(/\s+(?:\$|\d{1,3}(?:,\d{3})+\s*(?:mi|miles)|stock|stk|vin)\b/i)[0]
    .replace(/[-|/]+$/g, '')
    .trim();

  const makeL = make.toLowerCase();
  if (makeL === 'land' && modelRaw.toLowerCase().startsWith('rover')) {
    const parts = modelRaw.split(/\s+/);
    make = 'Land Rover';
    modelRaw = parts.slice(1).join(' ') || 'Rover';
  } else if (makeL === 'alfa' && modelRaw.toLowerCase().startsWith('romeo')) {
    const parts = modelRaw.split(/\s+/);
    make = 'Alfa Romeo';
    modelRaw = parts.slice(1).join(' ') || 'Romeo';
  } else if (!KNOWN_MAKES.has(makeL)) {
    // Accept unknown OEM tokens from dealer SRP headings.
  }

  const now = new Date().getFullYear() + 2;
  if (year < 1980 || year > now) {
    return { year: null, make: null, model: null };
  }

  const model = modelRaw.split(/\s+/).slice(0, 4).join(' ').trim();
  const makeOut =
    make === make.toLowerCase()
      ? make.replace(/\b\w/g, (c) => c.toUpperCase())
      : make;

  return { year, make: makeOut, model };
}

function isolateListingCardTexts(html) {
  const cleaned = stripDomNoise(html);
  const cardRe =
    /<(?:div|li|article|section)[^>]*(?:data-vin=["'][^"']+["']|class=["'][^"']*(?:srp-vehicle-card|vehicle-card|inventory-item|inventory-card|vehicle-listing|srp-card|listing-card)[^"']*["'])[^>]*>[\s\S]{0,4000}?<\/(?:div|li|article|section)>/gi;
  const cards = [];
  let m;
  while ((m = cardRe.exec(cleaned))) {
    cards.push(scrubRawText(m[0]));
  }
  return cards;
}

function parseInventoryText(raw) {
  const text = scrubRawText(raw);
  const ymm = extractYearMakeModel(text);
  return {
    vin: extractVin(text),
    year: ymm.year || extractYear(text),
    make: ymm.make,
    model: ymm.model,
    price: extractPrice(text),
    mileage: extractMileage(text),
    stock_number: extractStockNumber(text),
    exterior_color: extractExteriorColor(text),
    interior_color: extractInteriorColor(text),
  };
}

function asNonEmptyString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function asPositiveInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim()) {
    return Math.max(0, digitsOnly(value));
  }
  return 0;
}

/** Coerce model year to a full 4-digit integer (e.g. 27 → 2027). */
function normalizeYear(value) {
  if (value == null || value === '') return 0;
  const raw = String(value).trim();
  // Prefer an explicit 19xx/20xx token inside date-like strings ("2027-01-01").
  const yyyy = raw.match(/\b((?:19|20)\d{2})\b/);
  let n = yyyy ? Number.parseInt(yyyy[1], 10) : asPositiveInt(value);
  if (!n) return 0;
  // Two-digit years from dealer SRP data-* attrs
  if (n >= 0 && n <= 99) {
    const pivot = (new Date().getFullYear() + 2) % 100;
    n = n <= pivot ? 2000 + n : 1900 + n;
  }
  // Accidental YYYYMMDD / epoch-ish leftovers → first 4 digits if valid
  if (n > 2100) {
    const head = Number.parseInt(String(n).slice(0, 4), 10);
    if (head >= 1980 && head <= new Date().getFullYear() + 2) n = head;
    else return 0;
  }
  const max = new Date().getFullYear() + 2;
  if (n < 1980 || n > max) return 0;
  return n;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    return v;
  }
  return '';
}

function titleCaseColor(value) {
  const s = asNonEmptyString(value);
  if (!s) return '';
  return s
    .toLowerCase()
    .split(/([\s\-/]+)/)
    .map((part) =>
      /^[\s\-/]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join('');
}

function sanitizeVehicleRecord(vehicle, rawText) {
  const blob =
    rawText ||
    [
      vehicle.raw,
      vehicle.raw_html,
      vehicle.raw_text,
      vehicle.description,
      vehicle.title,
      vehicle.vin,
      vehicle.stock_number,
      vehicle.stockNumber,
      vehicle.stockNo,
      vehicle.stock,
      vehicle.year,
      vehicle.make,
      vehicle.model,
      vehicle.trim,
      vehicle.price,
      vehicle.internetPrice,
      vehicle.listPrice,
      vehicle.selling_price,
      vehicle.retail_price,
      vehicle.mileage,
      vehicle.miles,
      vehicle.odometer,
      vehicle.distance,
      vehicle.exterior_color,
      vehicle.exteriorColor,
      vehicle.color,
      vehicle.ext_color_generic,
    ]
      .filter((v) => v != null && String(v).trim() !== '')
      .map((v) => cleanVehicleText(String(v)))
      .join(' ');

  const parsed = parseInventoryText(blob);

  const vin =
    extractVin(asNonEmptyString(vehicle.vin)) ||
    parsed.vin ||
    asNonEmptyString(vehicle.vin).toUpperCase();

  const year =
    normalizeYear(
      firstNonEmpty(vehicle.year, vehicle.Year, vehicle.model_year, vehicle.vehicleModelDate, vehicle.modelDate),
    ) ||
    parsed.year ||
    0;

  const price =
    asPositiveInt(
      firstNonEmpty(
        vehicle.price,
        vehicle.internetPrice,
        vehicle.internet_price,
        vehicle.selling_price,
        vehicle.sellingPrice,
        vehicle.retail_price,
        vehicle.retailPrice,
        vehicle.listPrice,
        vehicle.list_price,
        vehicle.askingPrice,
        vehicle.asking_price,
        vehicle.salePrice,
        vehicle.sale_price,
        vehicle.msrp,
        vehicle.MSRP,
      ),
    ) ||
    parsed.price ||
    0;

  const mileage =
    asPositiveInt(
      firstNonEmpty(
        vehicle.mileage,
        vehicle.miles,
        vehicle.Miles,
        vehicle.odometer,
        vehicle.Odometer,
        vehicle.distance,
        vehicle.Distance,
        vehicle.odometerReading,
        vehicle.odometer_reading,
        vehicle.mileageFromOdometer,
      ),
    ) ||
    parsed.mileage ||
    0;

  const make = cleanVehicleText(asNonEmptyString(vehicle.make) || parsed.make || '');
  const model = cleanVehicleText(asNonEmptyString(vehicle.model) || parsed.model || '');
  const trim = cleanVehicleText(
    asNonEmptyString(vehicle.trim) || asNonEmptyString(vehicle.Trim) || '',
  );
  const title = cleanVehicleText(
    asNonEmptyString(vehicle.title) || [year, make, model, trim].filter(Boolean).join(' '),
  );
  const description = cleanVehicleText(
    asNonEmptyString(vehicle.description) || asNonEmptyString(vehicle.ai_description) || '',
  );

  // Prefer structured dealer stock; "In Transit" status; else empty (no VIN/year).
  let stock = resolveStockNumber(vehicle, year, make, model, vin);
  if (!isValidStockNumber(stock, year, make, model)) {
    const labeled = extractStockNumber(blob, year, make, model);
    stock = labeled || (detectInTransit(blob) ? IN_TRANSIT_STOCK : '');
  }

  const exterior = titleCaseColor(
    cleanVehicleText(
      firstNonEmpty(
        vehicle.exterior_color,
        vehicle.exteriorColor,
        vehicle.ExteriorColor,
        vehicle.ext_color,
        vehicle.extColor,
        vehicle.ext_color_generic,
        vehicle.extColorGeneric,
        vehicle.color,
        vehicle.Color,
        parsed.exterior_color,
      ),
    ),
  );
  const interior = titleCaseColor(
    cleanVehicleText(
      firstNonEmpty(
        vehicle.interior_color,
        vehicle.interiorColor,
        vehicle.InteriorColor,
        vehicle.int_color,
        vehicle.intColor,
        parsed.interior_color,
      ),
    ),
  );

  return {
    ...vehicle,
    vin,
    year,
    make,
    model,
    trim,
    title,
    description,
    price,
    mileage,
    miles: mileage,
    stock_number: stock,
    stockNumber: stock,
    exterior_color: exterior,
    exteriorColor: exterior,
    color: exterior,
    interior_color: interior,
    interiorColor: interior,
  };
}

function sanitizeInventoryList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => sanitizeVehicleRecord(row || {}));
}

function parseVehiclesFromHtml(html) {
  const cardTexts = isolateListingCardTexts(html);
  const blobs = cardTexts.length > 0 ? cardTexts : [scrubRawText(html)];
  const seen = new Set();
  const out = [];
  for (const blob of blobs) {
    const parsed = parseInventoryText(blob);
    if (!parsed.vin || seen.has(parsed.vin)) continue;
    seen.add(parsed.vin);
    out.push(sanitizeVehicleRecord(parsed, blob));
  }
  return out;
}

module.exports = {
  VIN_RE,
  YEAR_RE,
  PRICE_RE,
  MILEAGE_RE,
  STOCK_RE,
  YMM_RE,
  stripDomNoise,
  scrubRawText,
  decodeHtmlEntities,
  cleanVehicleText,
  extractVin,
  extractYear,
  extractPrice,
  extractMileage,
  extractStockNumber,
  extractYearMakeModel,
  isolateListingCardTexts,
  parseInventoryText,
  parseVehiclesFromHtml,
  sanitizeVehicleRecord,
  sanitizeInventoryList,
  normalizeYear,
  titleCaseColor,
  isValidStockNumber,
  resolveStockNumber,
  stockFallbackFromVin,
  detectInTransit,
  isInTransitStock,
  IN_TRANSIT_STOCK,
};
