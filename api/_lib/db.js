/**
 * Auth database facade.
 *
 * Prefers persistent PostgreSQL when DATABASE_URL / POSTGRES_URL is set
 * (Vercel Postgres / Neon). Falls back to the local SQLite + vault store
 * for offline development without a cloud database.
 *
 * All exported methods are async so route handlers can `await` uniformly.
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

function usePostgres() {
  return Boolean(databaseUrl());
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
  console.log('[auth-db] backend=sqlite (set DATABASE_URL for persistent Postgres)');
}

module.exports = exported;
