/**
 * Regex inventory sanitizer & parser.
 *
 * Extracts structured vehicle fields from raw scraped text/HTML blobs and
 * normalizes already-partial vehicle records before they hit the Marketplace
 * Hub JSON responses or the persistent inventory database.
 *
 * Pipeline:
 *   1. stripDomNoise — remove script/style/header/nav/footer before text extract
 *   2. Regex field extraction (VIN / price / mileage / year-make-model / stock)
 *   3. sanitizeVehicleRecord — typed integers + filled make/model
 */

export type ParsedVehicleFields = {
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  price: number | null;
  mileage: number | null;
  stock_number: string | null;
};

export type SanitizedVehicle = Record<string, unknown> & {
  vin: string;
  year: number;
  make: string;
  model: string;
  price: number;
  mileage: number;
  stock_number: string;
};

/** Standard 17-character VIN (excludes I, O, Q). */
export const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/i;

/** Model years 1900–2099. */
export const YEAR_RE = /\b(19|20)\d{2}\b/;

/** Currency-like numbers, optional leading $ → sanitize to pure integers. */
export const PRICE_RE = /\$?\b\d{1,3}(?:,\d{3})*\b/;

/** Mileage with mi/miles suffix → sanitize to pure integers. */
export const MILEAGE_RE = /\b(\d{1,3}(?:,\d{3})*)\s*(?:mi|miles)\b/i;

/** Stock / STK / STOCK / ID markers. */
export const STOCK_RE = /\b(?:STK|STOCK|ID)?\s*#?\s*([A-Z0-9]{4,10})\b/i;

/** Year Make Model heading pattern. */
export const YMM_RE =
  /\b((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9\-]+)\s+([A-Za-z0-9][A-Za-z0-9 \-/]{1,40})/;

const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;
const DOM_NOISE_RE =
  /<(script|style|noscript|header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

const KNOWN_MAKES = new Set([
  "acura", "alfa", "aston", "audi", "bentley", "bmw", "buick", "cadillac",
  "chevrolet", "chevy", "chrysler", "dodge", "ferrari", "fiat", "ford",
  "genesis", "gmc", "honda", "hyundai", "infiniti", "jaguar", "jeep", "kia",
  "lamborghini", "land", "lexus", "lincoln", "lotus", "maserati", "mazda",
  "mclaren", "mercedes", "mercury", "mini", "mitsubishi", "nissan",
  "porsche", "ram", "rivian", "rolls", "subaru", "suzuki", "tesla",
  "toyota", "volkswagen", "vw", "volvo",
]);

/**
 * Explicitly strip script/style/header/nav/footer noise before text extraction.
 * Cheerio/jsdom-equivalent step for Node (regex DOM strip — no native HTML DOM).
 */
export function stripDomNoise(raw: string): string {
  return String(raw || "").replace(DOM_NOISE_RE, " ");
}

/** Strip tags and collapse whitespace for regex scanning. */
export function scrubRawText(raw: string): string {
  return stripDomNoise(String(raw || ""))
    .replace(HTML_TAG_RE, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

function digitsOnly(value: string): number {
  const cleaned = value.replace(/[^0-9]/g, "");
  if (!cleaned) return 0;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

export function extractVin(text: string): string | null {
  const m = scrubRawText(text).match(VIN_RE);
  return m ? m[0].toUpperCase() : null;
}

export function extractYear(text: string): number | null {
  const m = scrubRawText(text).match(YEAR_RE);
  if (!m) return null;
  const year = Number.parseInt(m[0], 10);
  const now = new Date().getFullYear() + 2;
  if (year < 1980 || year > now) return null;
  return year;
}

export function extractPrice(text: string): number | null {
  const scrubbed = scrubRawText(text);
  // Prefer an explicit $-prefixed match when present.
  const dollarMatches = [...scrubbed.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*)\b/g)];
  for (const m of dollarMatches) {
    const n = digitsOnly(m[1] || m[0]);
    if (n >= 500 && n <= 5_000_000) return n;
  }

  for (const m of scrubbed.matchAll(new RegExp(PRICE_RE.source, "g"))) {
    const full = m[0];
    if (full.startsWith("$")) continue;
    const idx = m.index ?? 0;
    const after = scrubbed.slice(idx + full.length, idx + full.length + 12).toLowerCase();
    if (/\b(mi|miles)\b/.test(after)) continue;
    const n = digitsOnly(full);
    // Skip year-looking 4-digit values and tiny fragments.
    if (n >= 1900 && n <= 2100) continue;
    if (n < 1000 || n > 5_000_000) continue;
    return n;
  }
  return null;
}

export function extractMileage(text: string): number | null {
  const m = scrubRawText(text).match(MILEAGE_RE);
  if (!m) return null;
  const n = digitsOnly(m[1] || m[0]);
  if (n < 0 || n > 1_000_000) return null;
  return n;
}

export function extractStockNumber(text: string): string | null {
  const scrubbed = scrubRawText(text);
  // Prefer explicit STK/STOCK/ID labels.
  const labeled = scrubbed.match(/\b(?:STK|STOCK|ID)\s*#?\s*([A-Z0-9]{4,10})\b/i);
  if (labeled?.[1]) {
    const candidate = labeled[1].toUpperCase();
    if (!VIN_RE.test(candidate)) return candidate;
  }
  const m = scrubbed.match(STOCK_RE);
  if (!m?.[1]) return null;
  const candidate = m[1].toUpperCase();
  // Avoid treating a VIN fragment as a stock number.
  if (candidate.length === 17 && VIN_RE.test(candidate)) return null;
  return candidate;
}

/** Standard keyword extraction for Year / Make / Model. */
export function extractYearMakeModel(text: string): {
  year: number | null;
  make: string | null;
  model: string | null;
} {
  const scrubbed = scrubRawText(text);
  const m = scrubbed.match(YMM_RE);
  if (!m) return { year: null, make: null, model: null };

  let year = Number.parseInt(m[1], 10);
  let make = m[2].trim();
  let modelRaw = m[3].trim();
  modelRaw = modelRaw.split(
    /\s+(?:\$|\d{1,3}(?:,\d{3})+\s*(?:mi|miles)|stock|stk|vin)\b/i,
  )[0].replace(/[-|/]+$/g, "").trim();

  const makeL = make.toLowerCase();
  if (makeL === "land" && modelRaw.toLowerCase().startsWith("rover")) {
    const parts = modelRaw.split(/\s+/);
    make = "Land Rover";
    modelRaw = parts.slice(1).join(" ") || "Rover";
  } else if (makeL === "alfa" && modelRaw.toLowerCase().startsWith("romeo")) {
    const parts = modelRaw.split(/\s+/);
    make = "Alfa Romeo";
    modelRaw = parts.slice(1).join(" ") || "Romeo";
  } else if (!KNOWN_MAKES.has(makeL)) {
    // Accept unknown OEM tokens from dealer SRP headings.
  }

  const now = new Date().getFullYear() + 2;
  if (year < 1980 || year > now) {
    return { year: null, make: null, model: null };
  }

  const model = modelRaw.split(/\s+/).slice(0, 4).join(" ").trim();
  const makeOut = make === make.toLowerCase()
    ? make.replace(/\b\w/g, (c) => c.toUpperCase())
    : make;

  return { year, make: makeOut, model };
}

/**
 * Isolate primary vehicle listing card containers from scraped HTML.
 * Uses card class / data-vin markers after DOM noise stripping.
 */
export function isolateListingCardTexts(html: string): string[] {
  const cleaned = stripDomNoise(html);
  const cardRe =
    /<(?:div|li|article|section)[^>]*(?:data-vin=["'][^"']+["']|class=["'][^"']*(?:srp-vehicle-card|vehicle-card|inventory-item|inventory-card|vehicle-listing|srp-card|listing-card)[^"']*["'])[^>]*>[\s\S]{0,4000}?<\/(?:div|li|article|section)>/gi;
  const cards: string[] = [];
  for (const m of cleaned.matchAll(cardRe)) {
    cards.push(scrubRawText(m[0]));
  }
  return cards;
}

/** Parse all supported attributes from a raw scraper blob. */
export function parseInventoryText(raw: string): ParsedVehicleFields {
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
  };
}

/**
 * Full HTML → vehicles pipeline:
 * DOM noise strip → listing card isolate → regex sanitize → typed JSON.
 */
export function parseVehiclesFromHtml(html: string): SanitizedVehicle[] {
  const cardTexts = isolateListingCardTexts(html);
  const blobs = cardTexts.length > 0 ? cardTexts : [scrubRawText(html)];
  const seen = new Set<string>();
  const out: SanitizedVehicle[] = [];
  for (const blob of blobs) {
    const parsed = parseInventoryText(blob);
    if (!parsed.vin || seen.has(parsed.vin)) continue;
    seen.add(parsed.vin);
    out.push(sanitizeVehicleRecord(parsed as unknown as Record<string, unknown>, blob));
  }
  return out;
}

function asNonEmptyString(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function asPositiveInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    return Math.max(0, digitsOnly(value));
  }
  return 0;
}

/**
 * Merge regex extractions into a vehicle record.
 * Existing non-empty structured fields win; missing/invalid values are filled
 * from `rawText` (or from stringified field values as a fallback).
 * Price/mileage are always pure integers.
 */
export function sanitizeVehicleRecord(
  vehicle: Record<string, unknown>,
  rawText?: string,
): SanitizedVehicle {
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
      vehicle.mileage,
    ]
      .filter((v) => v != null && String(v).trim() !== "")
      .map(String)
      .join(" ");

  const parsed = parseInventoryText(blob);

  const vin =
    extractVin(asNonEmptyString(vehicle.vin)) ||
    parsed.vin ||
    asNonEmptyString(vehicle.vin).toUpperCase();

  const year =
    asPositiveInt(vehicle.year) ||
    parsed.year ||
    0;

  const price =
    asPositiveInt(vehicle.price) ||
    parsed.price ||
    0;

  const mileage =
    asPositiveInt(vehicle.mileage) ||
    parsed.mileage ||
    0;

  const make =
    asNonEmptyString(vehicle.make) ||
    parsed.make ||
    "";

  const model =
    asNonEmptyString(vehicle.model) ||
    parsed.model ||
    "";

  let stock = asNonEmptyString(vehicle.stock_number).toUpperCase();
  if (!stock || (stock.length === 17 && VIN_RE.test(stock))) {
    stock = parsed.stock_number || stock;
  } else {
    // Clean accidental labels/prefixes from stock fields.
    const fromField = extractStockNumber(stock);
    if (fromField) stock = fromField;
  }

  return {
    ...vehicle,
    vin,
    year,
    make,
    model,
    price,
    mileage,
    stock_number: stock,
  };
}

/** Sanitize a list of inventory rows for API responses / persistence. */
export function sanitizeInventoryList(
  rows: Array<Record<string, unknown>>,
): SanitizedVehicle[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => sanitizeVehicleRecord(row));
}
