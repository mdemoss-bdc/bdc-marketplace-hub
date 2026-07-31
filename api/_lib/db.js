/**
 * Auth database facade.
 *
 * On Vercel / serverless: ALWAYS PostgreSQL (DATABASE_URL / POSTGRES_URL).
 * SQLite file storage is never used in production — it fails on the
 * read-only filesystem and wipes /tmp state between invocations.
 *
 * Locally without DATABASE_URL: SQLite fallback for offline development.
 */
function databaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    ''
  ).trim();
}

function isServerless() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function usePostgres() {
  if (isServerless()) return true;
  return Boolean(databaseUrl());
}

if (isServerless() && !databaseUrl()) {
  console.error(
    '[auth-db] FATAL: Vercel requires DATABASE_URL / POSTGRES_URL — SQLite disabled',
  );
}

const impl = usePostgres() ? require('./db-pg') : require('./db-sqlite');

/** Methods that stay synchronous (env helpers / constants). */
const SYNC_KEYS = new Set(['adminEnvPassword', 'databaseUrl', 'usePostgres', 'backend']);

function asAsync(fn) {
  if (typeof fn !== 'function') return fn;
  return async (...args) => fn(...args);
}

const exported = {
  usePostgres,
  databaseUrl,
  backend: usePostgres() ? 'postgresql' : 'sqlite',
};

for (const key of Object.keys(impl)) {
  if (SYNC_KEYS.has(key)) {
    exported[key] = impl[key];
    continue;
  }
  const value = impl[key];
  exported[key] = typeof value === 'function' ? asAsync(value) : value;
}

if (usePostgres()) {
  console.log('[auth-db] backend=postgresql (DATABASE_URL/POSTGRES_URL)');
} else {
  console.log('[auth-db] backend=sqlite (local only — set DATABASE_URL for Postgres)');
}

module.exports = exported;
