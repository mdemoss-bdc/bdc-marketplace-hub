#!/usr/bin/env node
/**
 * Seed the persistent SQLite auth DB (api/_data/auth.db) from
 * DASHBOARD_PASSWORD / TESTER_PASSWORD / JDEMOSS_PASSWORD.
 *
 * Usage: node scripts/seed-auth-users.mjs
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env) || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

loadDotEnv(path.join(root, '.env'));

const dashboard = String(process.env.DASHBOARD_PASSWORD || '').trim();
const tester = String(process.env.TESTER_PASSWORD || '').trim();
const jdemoss = String(process.env.JDEMOSS_PASSWORD || '').trim();

if (!dashboard && !tester && !jdemoss) {
  console.error(
    'No passwords found. Set DASHBOARD_PASSWORD and/or TESTER_PASSWORD (and optional JDEMOSS_PASSWORD) in env or .env',
  );
  process.exit(1);
}

const { openDb, dbPath, listUsersForAdmin } = require('../api/_lib/db.js');
const db = openDb();
const users = listUsersForAdmin();
console.log(`Auth DB: ${dbPath()}`);
console.log(`Seeded/synced ${users.length} user(s): ${users.map((u) => `${u.username}(${u.role})`).join(', ')}`);
db.close?.();
