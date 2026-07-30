---
name: SQLite → PostgreSQL migration
description: bdc_engine.py was migrated from sqlite3 to psycopg2 via a drop-in shim. Key decisions and gotchas preserved here.
---

## Migration summary

`bdc_engine.py` (~7300 lines, ~100 sqlite3 usages) was migrated to PostgreSQL by:
- Installing `python313Packages.psycopg2` via Nix
- Creating `artifacts/api-server/pg_compat.py` — a drop-in shim (`import pg_compat as sqlite3`)
- Changing `DB_FILE` from a file path to `os.environ['DATABASE_URL']`
- Running `artifacts/api-server/migrate_sqlite_to_pg.py` once to copy SQLite data

## pg_compat.py — what it translates automatically

- `?` → `%s` placeholders
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`
- `INSERT OR IGNORE INTO` → `INSERT INTO … ON CONFLICT DO NOTHING`
- `INSERT OR REPLACE INTO user_sessions (token, user_id)` → conflict on `(token)` DO UPDATE
- `INSERT OR REPLACE INTO posting_cycle (user_id, vin, posted_date)` → conflict on `(user_id, vin)` DO UPDATE
- `PRAGMA table_info(tbl)` → `information_schema.columns` query returning same column positions
- `ALTER TABLE ADD COLUMN` failures → wrapped in SAVEPOINT, re-raised as `OperationalError`
- `sqlite3.IntegrityError` → `pg_compat.IntegrityError`
- `sqlite3.OperationalError` → `pg_compat.OperationalError`
- `datetime('now', '-N days')` → `(NOW() - INTERVAL 'N days')`
- `FOREIGN KEY … REFERENCES …` stripped from CREATE TABLE (SQLite never enforced them; avoids table-order dependency errors)
- `conn.row_factory = sqlite3.Row` → `_DictCursor` (RealDictCursor subclass returning `DictRow` supporting both `row['col']` and `row[0]` indexing)
- `cursor.lastrowid` → captured via `RETURNING id` + SAVEPOINT (so tables without `id` column fall back gracefully)

**Why:** bdc_engine.py had 100+ sqlite3.connect() calls scattered through 7300 lines; a shim was far less risky than surgical edits throughout.

## Known safe-to-ignore startup warning

`PostingQueueWorker` and `MosesScraperWorker` log `type object 'UserManager' has no attribute 'get_all_users'` — pre-existing, unrelated to this migration.

## Upsert conflict targets (must stay in sync with schema)

```python
_UPSERT_TARGETS = {
    "user_sessions": ("token",),       # token is PK
    "posting_cycle": ("user_id", "vin"),  # composite PK
}
```

If new INSERT OR REPLACE statements are added for other tables, add them here.
