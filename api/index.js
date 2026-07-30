/**
 * Single Vercel Serverless Function entry for all /api/* traffic.
 *
 * vercel.json rewrites /api and /api/* → /api/index so Hobby plan only
 * counts this one function. Handlers live under api/_routes/.
 */
module.exports = require('./_lib/app');
