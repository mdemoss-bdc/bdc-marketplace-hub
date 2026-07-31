/**
 * Tier 2 — structural DOM heuristics (platform-agnostic fallback).
 */
const cheerio = require('cheerio');
const { decodeHtml } = require('./html');
const { absUrl, digits } = require('./tier1');
const { VehicleSchema } = require('./schema');

const VIN_RE = /\b([A-HJ-NPR-Z0-9]{17})\b/i;
const CONTAINER_SEL = [
  '[class*="vehicle"]',
  '[class*="inventory"]',
  '[class*="card"]',
  '[id*="srp"]',
  '[class*="srp"]',
  '[data-vehicle]',
  'article',
].join(', ');

function extractTier2(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const map = new Map();

  $(CONTAINER_SEL).each((_, el) => {
    const $el = $(el);
    const text = decodeHtml($el.text().replace(/\s+/g, ' ').trim());
    if (text.length < 20 || text.length > 4000) return;
    const vinMatch = text.match(VIN_RE) || String($el.html() || '').match(VIN_RE);
    if (!vinMatch) return;
    const vin = vinMatch[1].toUpperCase();
    const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);
    const priceMatch = text.match(/\$\s*([\d,]+)/);
    const milesMatch = text.match(/([\d,]+)\s*(?:mi|miles)\b/i);
    const stockMatch =
      text.match(/stock\s*#?\s*([A-Z0-9\-_/]{3,14})/i) ||
      text.match(/#\s*([A-Z0-9\-_/]{3,14})/i);
    const link =
      absUrl($el.find('a[href]').first().attr('href'), pageUrl) ||
      absUrl($el.attr('data-href'), pageUrl);
    const imageUrl = absUrl(
      $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src'),
      pageUrl,
    );
    const candidate = {
      stockNumber: stockMatch ? stockMatch[1] : 'N/A',
      year: yearMatch ? digits(yearMatch[1]) : 0,
      make: '',
      model: '',
      trim: '',
      price: priceMatch ? digits(priceMatch[1]) : 0,
      mileage: milesMatch ? digits(milesMatch[1]) : 0,
      exteriorColor: '',
      link,
      imageUrl,
      vin,
    };
    // Best-effort make/model from leading "YYYY Make Model …"
    const title = text.match(
      /\b((?:19|20)\d{2})\s+([A-Za-z][A-Za-z\-]+)\s+([A-Za-z0-9][A-Za-z0-9\-]+)/,
    );
    if (title) {
      candidate.year = digits(title[1]);
      candidate.make = decodeHtml(title[2]);
      candidate.model = decodeHtml(title[3]);
    }
    const parsed = VehicleSchema.safeParse(candidate);
    if (!parsed.success) return;
    if (!map.has(vin)) map.set(vin, parsed.data);
  });

  return [...map.values()];
}

module.exports = { extractTier2 };
