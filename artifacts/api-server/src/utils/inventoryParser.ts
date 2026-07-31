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
  exterior_color: string | null;
  interior_color: string | null;
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

/** Decode HTML entities (&amp;, &#x2B;, &#43;, etc.) without external deps. */
export function decodeHtmlEntities(input: unknown): string {
  let s = String(input ?? "");
  s = s.replace(/&#x([0-9a-fA-F]+);?/g, (_, hex: string) => {
    const cp = Number.parseInt(hex, 16);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
  });
  s = s.replace(/&#(\d+);?/g, (_, dec: string) => {
    const cp = Number.parseInt(dec, 10);
    return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
  });
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&plus;/gi, "+");
}

/** Clean dealer text after entity decode — fix F+150 / Mercedes+Benz / GX+460. */
export function cleanVehicleText(input: unknown): string {
  let s = decodeHtmlEntities(input).replace(/\u00a0/g, " ").trim();
  if (!s) return "";
  s = s.replace(/\bF\+(\d{2,3})\b/gi, "F-$1");
  s = s.replace(/\bMercedes\+Benz\b/gi, "Mercedes-Benz");
  s = s.replace(/\b([A-Z]{2,4})\+(\d{2,4})\b/g, "$1 $2");
  s = s.replace(/([A-Za-z]{2,})\+([A-Za-z]{2,})/g, "$1-$2");
  return s.replace(WHITESPACE_RE, " ").trim();
}

/** Strip tags and collapse whitespace for regex scanning. */
export function scrubRawText(raw: string): string {
  return stripDomNoise(cleanVehicleText(String(raw || "")))
    .replace(HTML_TAG_RE, " ")
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

export function extractExteriorColor(text: string): string | null {
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

export function extractInteriorColor(text: string): string | null {
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

export const IN_TRANSIT_STOCK = "In Transit";
export const MISSING_STOCK = "Unavailable";
const IN_TRANSIT_RE =
  /\b(?:in[\s-]?transit|in[\s-]?production|arriving[\s-]?soon|on[\s-]?order|coming[\s-]?soon|building|pipeline|transit)\b/i;

export function isInTransitStock(value: unknown): boolean {
  const s = String(value || "").trim();
  return /^in[\s-]?transit$/i.test(s) || /^transit$/i.test(s) || s === IN_TRANSIT_STOCK;
}

export function detectInTransit(text: unknown): boolean {
  return IN_TRANSIT_RE.test(String(text || ""));
}

/** Reject years, VINs, makes, and empty placeholders as stock numbers. */
export function isValidStockNumber(
  value: unknown,
  year = 0,
  make = "",
  model = "",
): boolean {
  const raw = String(value || "").trim();
  if (isInTransitStock(raw)) return true;
  const stock = raw.toUpperCase();
  if (
    !stock ||
    stock === "N/A" ||
    stock === "NA" ||
    stock === "NONE" ||
    stock === "-" ||
    stock === "—" ||
    stock === "UNAVAILABLE"
  ) {
    return false;
  }
  if (stock.length === 17 && VIN_RE.test(stock)) return false;
  if (/^(?:19|20)\d{2}$/.test(stock)) return false;
  if (year > 0 && stock === String(year)) return false;
  const makeU = String(make || "").toUpperCase().replace(/\s+/g, "");
  const modelU = String(model || "").toUpperCase().replace(/\s+/g, "");
  if (makeU && stock === makeU) return false;
  if (modelU && stock === modelU) return false;
  if (KNOWN_MAKES.has(stock.toLowerCase())) return false;
  if (!/[0-9]/.test(stock) && stock.length < 5) return false;
  if (!/^[A-Z0-9][A-Z0-9\-_/]{2,14}$/i.test(stock)) return false;
  return true;
}

/** @deprecated No synthetic VIN stock — always returns "". */
export function stockFallbackFromVin(_vin: unknown): string {
  return "";
}

export function extractStockNumber(
  text: string,
  year = 0,
  make = "",
  model = "",
): string | null {
  const scrubbed = scrubRawText(text);
  // Only accept explicitly labeled stock tokens — unlabeled matches grab years.
  const labeled = scrubbed.match(/\b(?:STK|STOCK|ID)\s*#?\s*([A-Z0-9]{4,10})\b/i);
  if (labeled?.[1]) {
    const candidate = labeled[1].toUpperCase();
    if (isValidStockNumber(candidate, year, make, model)) return candidate;
  }
  return null;
}

const URL_STOCK_QUERY_KEYS = [
  "stock",
  "stocknumber",
  "stock_number",
  "stk",
  "vin_stock",
];
const URL_PATH_STOCK_PATTERNS = [
  /\/stk-([a-zA-Z0-9]+)/i,
  /\/stock-([a-zA-Z0-9]+)/i,
  /\/stock_([a-zA-Z0-9]+)/i,
  /-stk([a-zA-Z0-9]+)/i,
];

/** Extract stock from a VDP URL (query params then pathname patterns). */
export function extractStockFromUrl(
  url: unknown,
  year = 0,
  make = "",
  model = "",
  vin = "",
): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://example.invalid");
  } catch {
    return "";
  }
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!URL_STOCK_QUERY_KEYS.includes(String(k).toLowerCase())) continue;
    const upper = cleanVehicleText(decodeURIComponent(v || "")).toUpperCase();
    if (isInTransitStock(upper) || upper === "UNAVAILABLE") continue;
    if (
      isValidStockNumber(upper, year, make, model) &&
      (!vin || upper !== String(vin).toUpperCase())
    ) {
      return upper;
    }
  }
  const path = decodeURIComponent(parsed.pathname || "");
  for (const hay of [path, raw]) {
    for (const pat of URL_PATH_STOCK_PATTERNS) {
      const m = hay.match(pat);
      if (!m?.[1]) continue;
      const upper = String(m[1]).toUpperCase();
      if (isInTransitStock(upper) || upper === "UNAVAILABLE") continue;
      if (
        isValidStockNumber(upper, year, make, model) &&
        (!vin || upper !== String(vin).toUpperCase())
      ) {
        return upper;
      }
    }
  }
  return "";
}

/** Resolve dealer stock: explicit → VDP URL → In Transit → Unavailable. */
export function resolveStockNumber(
  vehicle: Record<string, unknown>,
  year: number,
  make: string,
  model: string,
  _vin: string,
  link = "",
): string {
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
  const vdp =
    cleanVehicleText(asNonEmptyString(link)) ||
    asNonEmptyString(vehicle.link) ||
    asNonEmptyString(vehicle.vdp_url) ||
    asNonEmptyString(vehicle.vdpUrl) ||
    asNonEmptyString(vehicle.url) ||
    asNonEmptyString(vehicle.href) ||
    "";
  const fromUrl = extractStockFromUrl(vdp, year, make, model, _vin);
  if (fromUrl) return fromUrl;
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
    .join(" ");
  if (detectInTransit(statusBlob)) return IN_TRANSIT_STOCK;
  return MISSING_STOCK;
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
    exterior_color: extractExteriorColor(text),
    interior_color: extractInteriorColor(text),
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

function firstNonEmpty(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (v == null || v === "") continue;
    return v;
  }
  return "";
}

/** Coerce model year to a full 4-digit integer (e.g. 27 → 2027). */
export function normalizeYear(value: unknown): number {
  if (value == null || value === "") return 0;
  const raw = String(value).trim();
  const yyyy = raw.match(/\b((?:19|20)\d{2})\b/);
  let n = yyyy ? Number.parseInt(yyyy[1], 10) : asPositiveInt(value);
  if (!n) return 0;
  if (n >= 0 && n <= 99) {
    const pivot = (new Date().getFullYear() + 2) % 100;
    n = n <= pivot ? 2000 + n : 1900 + n;
  }
  if (n > 2100) {
    const head = Number.parseInt(String(n).slice(0, 4), 10);
    if (head >= 1980 && head <= new Date().getFullYear() + 2) n = head;
    else return 0;
  }
  const max = new Date().getFullYear() + 2;
  if (n < 1980 || n > max) return 0;
  return n;
}

export function titleCaseColor(value: unknown): string {
  const s = asNonEmptyString(value);
  if (!s) return "";
  return s
    .toLowerCase()
    .split(/([\s\-/]+)/)
    .map((part) =>
      /^[\s\-/]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join("");
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
      .filter((v) => v != null && String(v).trim() !== "")
      .map((v) => cleanVehicleText(String(v)))
      .join(" ");

  const parsed = parseInventoryText(blob);

  const vin =
    extractVin(asNonEmptyString(vehicle.vin)) ||
    parsed.vin ||
    asNonEmptyString(vehicle.vin).toUpperCase();

  const year =
    normalizeYear(
      firstNonEmpty(
        vehicle.year,
        vehicle.Year,
        vehicle.model_year,
        vehicle.vehicleModelDate,
        vehicle.modelDate,
      ),
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
        vehicle.salePrice,
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
        vehicle.mileageFromOdometer,
      ),
    ) ||
    parsed.mileage ||
    0;

  const make = cleanVehicleText(asNonEmptyString(vehicle.make) || parsed.make || "");
  const model = cleanVehicleText(asNonEmptyString(vehicle.model) || parsed.model || "");
  const trim = cleanVehicleText(
    asNonEmptyString(vehicle.trim) || asNonEmptyString(vehicle.Trim) || "",
  );

  const link =
    asNonEmptyString(vehicle.link) ||
    asNonEmptyString(vehicle.vdp_url) ||
    asNonEmptyString(vehicle.vdpUrl) ||
    asNonEmptyString(vehicle.url) ||
    asNonEmptyString(vehicle.href) ||
    "";
  let stock = resolveStockNumber(vehicle, year, make, model, vin, link);
  if (!isValidStockNumber(stock, year, make, model)) {
    const labeled = extractStockNumber(blob, year, make, model);
    const fromUrl = extractStockFromUrl(link, year, make, model, vin);
    stock =
      labeled ||
      fromUrl ||
      (detectInTransit(blob) ? IN_TRANSIT_STOCK : MISSING_STOCK);
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
  const image =
    asNonEmptyString(vehicle.image_url) ||
    asNonEmptyString(vehicle.imageUrl) ||
    asNonEmptyString(vehicle.image_link) ||
    "";

  return {
    ...vehicle,
    vin,
    year,
    make,
    model,
    trim,
    price,
    mileage,
    miles: mileage,
    stock_number: stock || MISSING_STOCK,
    stockNumber: stock || MISSING_STOCK,
    exterior_color: exterior,
    exteriorColor: exterior,
    color: exterior,
    interior_color: interior,
    interiorColor: interior,
    link,
    vdp_url: link,
    image_url: image,
    imageUrl: image,
  };
}

/** Sanitize a list of inventory rows for API responses / persistence. */
export function sanitizeInventoryList(
  rows: Array<Record<string, unknown>>,
): SanitizedVehicle[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => sanitizeVehicleRecord(row));
}
