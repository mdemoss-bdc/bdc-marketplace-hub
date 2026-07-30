/**
 * In-memory login rate limit: 5 failures per IP per 15 minutes.
 * Note: per-instance on serverless; still blocks brute force on a warm isolate.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

/** @type {Map<string, { failures: number[], }>} */
const buckets = new Map();

function normalizeIp(ip) {
  const raw = String(ip || 'unknown').trim() || 'unknown';
  // X-Forwarded-For may be a list
  return raw.split(',')[0].trim() || 'unknown';
}

function prune(entry, now) {
  entry.failures = entry.failures.filter((t) => now - t < WINDOW_MS);
}

function checkLoginRateLimit(ip) {
  const key = normalizeIp(ip);
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry) {
    return { allowed: true, retryAfterSec: 0 };
  }
  prune(entry, now);
  if (entry.failures.length >= MAX_FAILURES) {
    const oldest = entry.failures[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordLoginFailure(ip) {
  const key = normalizeIp(ip);
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry) {
    entry = { failures: [] };
    buckets.set(key, entry);
  }
  prune(entry, now);
  entry.failures.push(now);
}

function clearLoginFailures(ip) {
  buckets.delete(normalizeIp(ip));
}

module.exports = {
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
};
