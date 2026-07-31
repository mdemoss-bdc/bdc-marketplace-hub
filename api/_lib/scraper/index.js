/**
 * Adaptive, platform-agnostic inventory scraper for Vercel (Node).
 * Uses fetch + cheerio + he + zod. Never loads Playwright/Puppeteer.
 */
const { extractInventory, scrapeUrl, toEngineRows } = require('./pipeline');

module.exports = {
  extractInventory,
  scrapeUrl,
  toEngineRows,
};
