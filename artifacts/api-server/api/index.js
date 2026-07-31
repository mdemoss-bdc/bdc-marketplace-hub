/**
 * Single Hobby-plan-safe serverless entry when this package is the Vercel
 * Root Directory. Delegates to the monorepo catch-all Express app.
 *
 * Keep this folder to exactly one .js file — extra files become extra functions.
 * Do NOT place TypeScript / Playwright / Python scrapers here.
 */
module.exports = require('../../../api/_lib/app');
