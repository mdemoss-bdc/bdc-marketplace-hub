/**
 * Lead Center helpers — PostgreSQL via api/_lib/pg.js.
 *
 * Mirrors artifacts/api-server/leads_engine.py response shape so the
 * dashboard Lead Center works on Vercel the same as on the local Python engine.
 */
const {
  query,
  queryAll,
  ensureCoreSchema,
  databaseUrl,
  isServerless,
} = require('./pg');
const { getTokenFromRequest, verifyJwt } = require('./jwt');
const { getUserByUsername } = require('./users');

const SLA_MINUTES = 15;

let _ready = null;

async function openLeadsDb() {
  if (!databaseUrl()) {
    if (isServerless()) {
      throw new Error(
        'DATABASE_URL / POSTGRES_URL required — SQLite is disabled on Vercel.',
      );
    }
    throw new Error('DATABASE_URL / POSTGRES_URL is not configured for leads storage.');
  }
  if (_ready) return _ready;
  _ready = ensureLeadsSchema().catch((err) => {
    _ready = null;
    throw err;
  });
  return _ready;
}

async function ensureLeadsSchema() {
  await ensureCoreSchema();
  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      requested_vin TEXT NOT NULL DEFAULT '',
      vehicle_interest TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'Web Form',
      status TEXT NOT NULL DEFAULT 'New',
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_action_at TIMESTAMPTZ DEFAULT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      organization_id INTEGER DEFAULT NULL,
      rooftop_id INTEGER DEFAULT NULL
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS lead_actions (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL DEFAULT 'call',
      note TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const alters = [
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS vehicle_interest TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_demo INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS organization_id INTEGER DEFAULT NULL',
    'ALTER TABLE leads ADD COLUMN IF NOT EXISTS rooftop_id INTEGER DEFAULT NULL',
  ];
  for (const ddl of alters) {
    try {
      await query(ddl);
    } catch (err) {
      console.warn('[leads] alter skipped:', err.message || err);
    }
  }
}

function emptyLeadsPayload() {
  return { leads: [], total: 0 };
}

function parseTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(value) {
  const d = parseTime(value);
  if (!d) return value == null ? null : String(value);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function slaFlag(row) {
  const status = row.status || '';
  if (status === 'Scheduled' || status === 'Closed' || status === 'Lost') {
    return false;
  }
  const ref = parseTime(row.last_action_at) || parseTime(row.created_at);
  if (!ref) return true;
  const ageMins = (Date.now() - ref.getTime()) / 60000;
  return ageMins > SLA_MINUTES;
}

function minutesSinceAction(row) {
  const ref = parseTime(row.last_action_at) || parseTime(row.created_at);
  if (!ref) return null;
  return Math.round(((Date.now() - ref.getTime()) / 60000) * 10) / 10;
}

function rowToLead(row) {
  return {
    id: Number(row.id),
    customer_name: row.customer_name || '',
    phone: row.phone || '',
    email: row.email || '',
    requested_vin: row.requested_vin || '',
    vehicle_interest: row.vehicle_interest || '',
    source: row.source || 'Web Form',
    status: row.status || 'New',
    notes: row.notes || '',
    created_at: iso(row.created_at) || '',
    last_action_at: row.last_action_at ? iso(row.last_action_at) : null,
    is_unanswered_sla: slaFlag(row),
    minutes_since_action: minutesSinceAction(row),
    organization_id: row.organization_id ?? null,
    rooftop_id: row.rooftop_id ?? row.organization_id ?? null,
  };
}

/**
 * Resolve optional tenant scope from JWT (organization_id / rooftop_id).
 * Lead Center often calls without a token — then scope is null (all leads).
 */
async function resolveTenantScope(req) {
  try {
    const token = getTokenFromRequest(req);
    const payload = verifyJwt(token);
    if (!payload || !payload.sub) return null;
    const user = await getUserByUsername(payload.sub);
    if (!user) return null;
    const orgId = user.organization_id ?? user.rooftop_id ?? null;
    if (orgId == null || orgId === '' || Number(orgId) === 0) return null;
    return Number(orgId);
  } catch {
    return null;
  }
}

/**
 * @param {{ status?: string|null, source?: string|null, sla_only?: boolean, organization_id?: number|null }} opts
 */
async function getLeads(opts = {}) {
  await openLeadsDb();
  const clauses = [];
  const params = [];
  let i = 1;

  if (opts.status) {
    clauses.push(`status = $${i++}`);
    params.push(opts.status);
  }
  if (opts.source) {
    clauses.push(`source = $${i++}`);
    params.push(opts.source);
  }
  if (opts.organization_id != null) {
    // Include unscoped legacy rows so empty tenant boards still surface data.
    clauses.push(
      `(organization_id = $${i} OR rooftop_id = $${i} OR (organization_id IS NULL AND rooftop_id IS NULL))`,
    );
    params.push(opts.organization_id);
    i += 1;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await queryAll(
    `SELECT * FROM leads ${where} ORDER BY created_at DESC`,
    params,
  );
  let leads = rows.map(rowToLead);
  if (opts.sla_only) {
    leads = leads.filter((l) => l.is_unanswered_sla);
  }
  return { leads, total: leads.length };
}

/**
 * Best-effort list that never throws — missing table / DB → empty board.
 */
async function getLeadsSafe(opts = {}) {
  try {
    return await getLeads(opts);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    // Undefined table / relation — treat as empty, not a red banner.
    if (
      /does not exist|no such table|relation .* does not exist/i.test(msg) ||
      /not configured/i.test(msg)
    ) {
      console.warn('[leads] falling back to empty list:', msg);
      return emptyLeadsPayload();
    }
    console.error('[leads] getLeads failed:', err);
    return emptyLeadsPayload();
  }
}

module.exports = {
  SLA_MINUTES,
  openLeadsDb,
  ensureLeadsSchema,
  emptyLeadsPayload,
  getLeads,
  getLeadsSafe,
  resolveTenantScope,
  rowToLead,
};
