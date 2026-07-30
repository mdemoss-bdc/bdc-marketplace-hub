/**
 * Account profiles + credential verification backed by persistent SQLite
 * (api/_lib/db.js). Passwords are scrypt-hashed; bootstrap accounts are
 * seeded from ADMIN_PASSWORD / TESTER_PASSWORD on cold start.
 */
const {
  authenticate: dbAuthenticate,
  getUserByUsername: dbGetUserByUsername,
  createUser,
  listUsersForAdmin,
  openDb,
} = require('./db');

/** Ensure schema + seed run before any auth call. */
function ensureReady() {
  openDb();
}

function getUserByUsername(username) {
  ensureReady();
  return dbGetUserByUsername(username);
}

function authenticate(username, password) {
  ensureReady();
  return dbAuthenticate(username, password);
}

function requireRole(user, roles) {
  if (!user || !Array.isArray(roles) || roles.length === 0) return false;
  const role = String(user.role || '');
  return roles.map(String).includes(role);
}

function adminDirectoryUsers() {
  ensureReady();
  return listUsersForAdmin();
}

module.exports = {
  authenticate,
  getUserByUsername,
  requireRole,
  adminDirectoryUsers,
  createUser,
};
