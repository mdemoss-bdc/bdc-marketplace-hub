#!/usr/bin/env node
/**
 * Seed api/_data/users.hashed.json from DASHBOARD_PASSWORD / TESTER_PASSWORD.
 * Reads process.env and optional project-root .env (no dotenv dependency).
 *
 * Usage: node scripts/seed-auth-users.mjs
 */
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { hashPassword } = require('../api/_lib/crypto-passwords.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'api', '_data');
const outFile = path.join(outDir, 'users.hashed.json');

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

const hashes = {};
if (dashboard) hashes.mdemoss = hashPassword(dashboard);
if (tester) hashes.testreviewer = hashPassword(tester);
if (jdemoss) hashes.jdemoss = hashPassword(jdemoss);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(hashes, null, 2)}\n`, 'utf8');
console.log(`Wrote ${Object.keys(hashes).length} hash(es) to ${outFile}`);
