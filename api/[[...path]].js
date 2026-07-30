/**
 * Single Vercel Serverless Function (optional catch-all).
 *
 * Matches /api and every /api/* path so the Hobby plan only counts 1 function.
 * Handlers live under api/_routes/ (private; not deployed as separate functions).
 */
module.exports = require('./_lib/app');
