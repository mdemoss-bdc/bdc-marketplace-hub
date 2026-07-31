/**
 * Regex inventory sanitizer & parser (CommonJS mirror for Vercel catch-all).
 * Keep patterns in sync with artifacts/api-server/src/utils/inventoryParser.ts.
 */

const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const PRICE_RE = /\$?\b\d{1,3}(?:,\d{3})*\b/;
const MILEAGE_RE = /\b(\d{1,3}(?:,\d{3})*)\s*(?:mi|miles)\b/i;
const STOCK_LABELED_RE = /\b(?:STK|STOCK|ID)\s*#?\s*([A-Z0-9]{4,10})\b/i;
const STOCK_RE = /\b(?:STK|STOCK|ID)?\s*#?\s*([A-Z0-9]{4,10})\b/i;
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

function scrubRawText(raw) {
  return stripDomNoise(String(raw || ''))
    .replace(HTML_TAG_RE, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
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

function extractStockNumber(text) {
  const scrubbed = scrubRawText(text);
  const labeled = scrubbed.match(STOCK_LABELED_RE);
  if (labeled && labeled[1]) {
    const candidate = labeled[1].toUpperCase();
    if (!VIN_RE.test(candidate)) return candidate;
  }
  const m = scrubbed.match(STOCK_RE);
  if (!m || !m[1]) return null;
  const candidate = m[1].toUpperCase();
  if (candidate.length === 17 && VIN_RE.test(candidate)) return null;
  return candidate;
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
      vehicle.year,
      vehicle.make,
      vehicle.model,
      vehicle.price,
      vehicle.internetPrice,
      vehicle.listPrice,
      vehicle.mileage,
      vehicle.miles,
      vehicle.odometer,
      vehicle.exterior_color,
      vehicle.exteriorColor,
      vehicle.color,
    ]
      .filter((v) => v != null && String(v).trim() !== '')
      .map(String)
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
        vehicle.listPrice,
        vehicle.list_price,
        vehicle.askingPrice,
        vehicle.asking_price,
        vehicle.salePrice,
        vehicle.sale_price,
        vehicle.sellingPrice,
        vehicle.msrp,
        vehicle.MSRP,
        vehicle.retailPrice,
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
        vehicle.odometerReading,
        vehicle.odometer_reading,
        vehicle.mileageFromOdometer,
      ),
    ) ||
    parsed.mileage ||
    0;

  const make = asNonEmptyString(vehicle.make) || parsed.make || '';
  const model = asNonEmptyString(vehicle.model) || parsed.model || '';

  let stock = asNonEmptyString(vehicle.stock_number || vehicle.stockNumber).toUpperCase();
  if (!stock || (stock.length === 17 && VIN_RE.test(stock))) {
    const candidate = (parsed.stock_number || '').toUpperCase();
    // Avoid treating make/model tokens (e.g. CHEVROLET) as stock numbers.
    const makeU = make.toUpperCase().replace(/\s+/g, '');
    const modelU = model.toUpperCase().replace(/\s+/g, '');
    if (
      candidate &&
      candidate !== makeU &&
      candidate !== modelU &&
      !KNOWN_MAKES.has(candidate.toLowerCase())
    ) {
      stock = candidate;
    }
  } else {
    const fromField = extractStockNumber(stock);
    if (fromField) stock = fromField;
  }

  const exterior = titleCaseColor(
    firstNonEmpty(
      vehicle.exterior_color,
      vehicle.exteriorColor,
      vehicle.ExteriorColor,
      vehicle.ext_color,
      vehicle.extColor,
      vehicle.color,
      vehicle.Color,
      parsed.exterior_color,
    ),
  );
  const interior = titleCaseColor(
    firstNonEmpty(
      vehicle.interior_color,
      vehicle.interiorColor,
      vehicle.InteriorColor,
      vehicle.int_color,
      vehicle.intColor,
      parsed.interior_color,
    ),
  );

  return {
    ...vehicle,
    vin,
    year,
    make,
    model,
    price,
    mileage,
    miles: mileage,
    stock_number: stock,
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
};
