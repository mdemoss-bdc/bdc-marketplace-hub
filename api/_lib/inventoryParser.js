/**
 * Regex inventory sanitizer & parser (CommonJS mirror for Vercel catch-all).
 * Keep patterns in sync with artifacts/api-server/src/utils/inventoryParser.ts.
 */

const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/i;
const YEAR_RE = /\b(19|20)\d{2}\b/;
const PRICE_RE = /\$?\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/;
const PRICE_DOLLAR_RE = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b/;
const MILEAGE_RE = /\b(\d{1,3}(?:,\d{3})*)\s*(?:mi|miles)\b/i;
const STOCK_LABELED_RE = /\b(?:STK|STOCK|ID)\s*#?\s*([A-Z0-9]{4,10})\b/i;
const STOCK_RE = /\b(?:STK|STOCK|ID)?\s*#?\s*([A-Z0-9]{4,10})\b/i;
const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

function scrubRawText(raw) {
  return String(raw || '')
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
  const dollarRe = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/g;
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

function extractStockNumber(text) {
  const scrubbed = scrubRawText(text);
  const labeled = scrubbed.match(STOCK_LABELED_RE);
  if (labeled?.[1]) {
    const candidate = labeled[1].toUpperCase();
    if (!VIN_RE.test(candidate)) return candidate;
  }
  const m = scrubbed.match(STOCK_RE);
  if (!m?.[1]) return null;
  const candidate = m[1].toUpperCase();
  if (candidate.length === 17 && VIN_RE.test(candidate)) return null;
  return candidate;
}

function parseInventoryText(raw) {
  const text = scrubRawText(raw);
  return {
    vin: extractVin(text),
    year: extractYear(text),
    price: extractPrice(text),
    mileage: extractMileage(text),
    stock_number: extractStockNumber(text),
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
      vehicle.price,
      vehicle.mileage,
    ]
      .filter((v) => v != null && String(v).trim() !== '')
      .map(String)
      .join(' ');

  const parsed = parseInventoryText(blob);

  const vin =
    extractVin(asNonEmptyString(vehicle.vin)) ||
    parsed.vin ||
    asNonEmptyString(vehicle.vin).toUpperCase();

  const year = asPositiveInt(vehicle.year) || parsed.year || 0;
  const price = asPositiveInt(vehicle.price) || parsed.price || 0;
  const mileage = asPositiveInt(vehicle.mileage) || parsed.mileage || 0;

  let stock = asNonEmptyString(vehicle.stock_number).toUpperCase();
  if (!stock || (stock.length === 17 && VIN_RE.test(stock))) {
    stock = parsed.stock_number || stock;
  } else {
    const fromField = extractStockNumber(stock);
    if (fromField) stock = fromField;
  }

  return {
    ...vehicle,
    vin,
    year,
    price,
    mileage,
    stock_number: stock,
  };
}

function sanitizeInventoryList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => sanitizeVehicleRecord(row || {}));
}

module.exports = {
  VIN_RE,
  YEAR_RE,
  PRICE_RE,
  MILEAGE_RE,
  STOCK_RE,
  scrubRawText,
  extractVin,
  extractYear,
  extractPrice,
  extractMileage,
  extractStockNumber,
  parseInventoryText,
  sanitizeVehicleRecord,
  sanitizeInventoryList,
};
