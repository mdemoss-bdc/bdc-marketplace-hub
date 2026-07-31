/**
 * Lightweight HTML fetch + entity decode for Vercel serverless.
 * No Playwright / Puppeteer — fetch + cheerio + he only.
 */
const he = require('he');

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; BDCMarketplaceHub/1.0; +https://bdcmanager.com)',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function decodeHtml(value) {
  if (value == null) return '';
  try {
    return he.decode(String(value));
  } catch {
    return String(value);
  }
}

async function fetchHtml(url, { timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: DEFAULT_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const html = await res.text();
    return decodeHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchHtml, decodeHtml, DEFAULT_HEADERS };
