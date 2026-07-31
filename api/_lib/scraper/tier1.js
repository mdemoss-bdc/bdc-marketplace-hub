/**
 * Tier 1 — JSON-LD / data-* attributes / VDP anchors (fast, free).
 */
const cheerio = require('cheerio');
const { decodeHtml } = require('./html');
const { VehicleSchema } = require('./schema');

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/i;

function absUrl(href, base) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw.startsWith('http') ? raw : '';
  }
}

function digits(value) {
  const m = String(value || '').replace(/[^\d.]/g, '');
  if (!m) return 0;
  const n = Math.round(Number(m));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pushVehicle(map, raw, pageUrl) {
  const vin = String(raw.vin || '').toUpperCase();
  if (!vin || vin.length < 10) return;
  const candidate = {
    stockNumber: decodeHtml(raw.stockNumber || raw.stock_number || 'N/A') || 'N/A',
    year: digits(raw.year),
    make: decodeHtml(raw.make || ''),
    model: decodeHtml(raw.model || ''),
    trim: decodeHtml(raw.trim || ''),
    price: digits(raw.price),
    mileage: digits(raw.mileage || raw.miles),
    exteriorColor: decodeHtml(raw.exteriorColor || raw.color || ''),
    link: absUrl(raw.link || raw.vdp_url || '', pageUrl),
    imageUrl: absUrl(raw.imageUrl || raw.image || '', pageUrl),
    vin,
  };
  const parsed = VehicleSchema.safeParse(candidate);
  if (!parsed.success) return;
  const prev = map.get(vin);
  if (!prev) {
    map.set(vin, parsed.data);
    return;
  }
  const merged = { ...prev };
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === '' || v === 0 || v === 'N/A') continue;
    if (merged[k] === '' || merged[k] === 0 || merged[k] === 'N/A') merged[k] = v;
  }
  map.set(vin, merged);
}

function extractJsonLd($, pageUrl, map) {
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).html() || '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const nodes = Array.isArray(data) ? data : [data];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(walk);
      const types = []
        .concat(node['@type'] || [])
        .map((t) => String(t).toLowerCase());
      const isVehicle = types.some((t) =>
        ['car', 'vehicle', 'product', 'cars', 'automobile'].includes(t),
      );
      if (!isVehicle && !node.vehicleIdentificationNumber && !node.vin) return;
      const vin =
        node.vehicleIdentificationNumber ||
        node.vin ||
        (typeof node.sku === 'string' && VIN_RE.test(node.sku) ? node.sku : '');
      pushVehicle(
        map,
        {
          vin,
          stockNumber: node.sku || node.mpn || node.productID || 'N/A',
          year: node.vehicleModelDate || node.modelDate || node.productionDate,
          make: node.brand?.name || node.brand || node.manufacturer,
          model: node.model || node.name,
          trim: node.vehicleConfiguration || node.trim,
          price: node.offers?.price || node.price,
          mileage: node.mileageFromOdometer?.value || node.mileage,
          exteriorColor: node.color || node.vehicleColor,
          link: node.url || node['@id'],
          imageUrl: Array.isArray(node.image) ? node.image[0] : node.image,
        },
        pageUrl,
      );
    };
    nodes.forEach(walk);
  });
}

function extractDataAttrs($, pageUrl, map) {
  $('[data-vin], [data-year][data-price], [data-stocknumber], [data-stock-number]').each(
    (_, el) => {
      const $el = $(el);
      const vin = $el.attr('data-vin') || '';
      pushVehicle(
        map,
        {
          vin,
          year: $el.attr('data-year'),
          price: $el.attr('data-price') || $el.attr('data-internet-price'),
          stockNumber:
            $el.attr('data-stocknumber') ||
            $el.attr('data-stock-number') ||
            $el.attr('data-stock'),
          make: $el.attr('data-make'),
          model: $el.attr('data-model'),
          trim: $el.attr('data-trim'),
          mileage: $el.attr('data-mileage') || $el.attr('data-miles'),
          exteriorColor: $el.attr('data-color') || $el.attr('data-ext-color'),
          link: $el.attr('data-url') || $el.attr('data-vdp-url') || $el.find('a[href]').attr('href'),
          imageUrl: $el.attr('data-image') || $el.find('img').attr('src'),
        },
        pageUrl,
      );
    },
  );
}

function bindVdpLinks($, pageUrl, map) {
  $('a[href*="vin="], a[href*="/vehicle"], a[href*="/vdp"], a[href*="inventory"]').each(
    (_, el) => {
      const href = absUrl($(el).attr('href'), pageUrl);
      const blob = `${href} ${$(el).text()}`;
      const m = blob.match(VIN_RE);
      if (!m) return;
      const vin = m[1].toUpperCase();
      const prev = map.get(vin);
      if (prev && !prev.link) {
        map.set(vin, { ...prev, link: href });
      }
    },
  );
}

function extractTier1(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const map = new Map();
  extractJsonLd($, pageUrl, map);
  extractDataAttrs($, pageUrl, map);
  bindVdpLinks($, pageUrl, map);
  return [...map.values()];
}

module.exports = { extractTier1, absUrl, digits };
