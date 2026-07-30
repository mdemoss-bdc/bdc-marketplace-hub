/**
 * Account profiles + credential verification.
 * Backed by PostgreSQL when DATABASE_URL/POSTGRES_URL is set, else SQLite.
 */
const {
  authenticate: dbAuthenticate,
  getUserByUsername: dbGetUserByUsername,
  createUser: dbCreateUser,
  listUsersForAdmin,
  openDb,
} = require('./db');

/** Ensure schema + seed run before any auth call. */
async function ensureReady() {
  await openDb();
}

async function getUserByUsername(username) {
  await ensureReady();
  return dbGetUserByUsername(username);
}

async function authenticate(username, password) {
  await ensureReady();
  return dbAuthenticate(username, password);
}

async function createUser(payload) {
  await ensureReady();
  return dbCreateUser(payload);
}

function requireRole(user, roles) {
  if (!user || !Array.isArray(roles) || roles.length === 0) return false;
  const role = String(user.role || '');
  return roles.map(String).includes(role);
}

async function adminDirectoryUsers() {
  await ensureReady();
  return listUsersForAdmin();
}

module.exports = {
  authenticate,
  getUserByUsername,
  requireRole,
  adminDirectoryUsers,
  createUser,
};
