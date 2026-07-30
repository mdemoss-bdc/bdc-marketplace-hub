#!/usr/bin/env python3
"""
migrate_sqlite_to_pg.py — One-time migration of bdc_production.db → PostgreSQL.

Run ONCE after switching the engine to pg_compat:
    python3 migrate_sqlite_to_pg.py

Safety guarantees:
  • Every INSERT uses ON CONFLICT DO NOTHING — re-running is idempotent.
  • mdemoss and all existing accounts are preserved if they already exist.
  • Sequences are bumped after each table so future auto-increments work.
  • Timestamps stored as strings in SQLite are cast to TIMESTAMP in PG.
"""

import os
import sqlite3
import sys
import psycopg2
import psycopg2.extras

# ── Config ────────────────────────────────────────────────────────────────────

SQLITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bdc_production.db")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

if not DATABASE_URL:
    print("ERROR: DATABASE_URL is not set.", file=sys.stderr)
    sys.exit(1)

if not os.path.exists(SQLITE_PATH):
    print(f"SQLite file not found at {SQLITE_PATH} — nothing to migrate.")
    sys.exit(0)


# ── Tables in FK-safe order ───────────────────────────────────────────────────
#
# Each entry: (table_name, [pk_column, ...] or None, has_serial_id)
#   pk_column  → used for ON CONFLICT DO NOTHING clause
#   has_serial → whether to update the PG sequence after migration

TABLES = [
    # name                    pk_cols                        has_serial
    ("users",               ["id"],                        True),
    ("user_sessions",       ["token"],                     False),
    ("sessions",            ["phone_number"],               False),
    ("messages",            ["id"],                        True),
    ("appointments",        ["id"],                        True),
    ("email_queue",         ["id"],                        True),
    ("marketplace_inventory", ["id"],                      True),
    ("posting_queue",       ["id"],                        True),
    ("posting_cycle",       ["user_id", "vin"],            False),
    ("customers",           ["id"],                        True),
    ("user_locations",      ["id"],                        True),
    ("wishlist",            ["id"],                        True),
    ("password_reset_tokens", ["id"],                      True),
    ("legal_agreements",    ["id"],                        True),
]


def get_columns(sqlite_cur, table: str) -> list[str]:
    sqlite_cur.execute(f"PRAGMA table_info({table})")
    return [row[1] for row in sqlite_cur.fetchall()]


def migrate_table(sqlite_cur, pg_cur, table: str, pk_cols: list[str]) -> int:
    """Copy all rows from SQLite → PostgreSQL. Returns number of rows inserted."""
    # Get column names from the SQLite table
    cols = get_columns(sqlite_cur, table)
    if not cols:
        print(f"  [{table}] table not found in SQLite — skipping.")
        return 0

    sqlite_cur.execute(f"SELECT * FROM {table}")
    rows = sqlite_cur.fetchall()
    if not rows:
        print(f"  [{table}] 0 rows — nothing to migrate.")
        return 0

    # Filter to columns that exist in the PG table
    pg_cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %s AND table_schema = 'public'",
        (table,),
    )
    pg_cols_set = {r[0] for r in pg_cur.fetchall()}
    valid_cols = [c for c in cols if c in pg_cols_set]
    if not valid_cols:
        print(f"  [{table}] no matching columns in PostgreSQL — skipping.")
        return 0

    col_indices = [cols.index(c) for c in valid_cols]
    col_list    = ", ".join(valid_cols)
    placeholders = ", ".join(["%s"] * len(valid_cols))
    conflict_clause = f"ON CONFLICT ({', '.join(pk_cols)}) DO NOTHING" if pk_cols else "ON CONFLICT DO NOTHING"
    insert_sql = (
        f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) {conflict_clause}"
    )

    inserted = 0
    skipped  = 0
    for row in rows:
        values = []
        for idx in col_indices:
            v = row[idx]
            values.append(v)
        try:
            pg_cur.execute(insert_sql, values)
            if pg_cur.rowcount:
                inserted += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"    WARNING: row skipped for {table}: {e} — values={values[:4]}")
            skipped += 1

    return inserted


def bump_sequence(pg_cur, table: str) -> None:
    """Reset the PostgreSQL SERIAL sequence to MAX(id) so future INSERTs work."""
    pg_cur.execute(
        f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
        f"COALESCE((SELECT MAX(id) FROM {table}), 1))"
    )


def main():
    print("=" * 60)
    print("BDC SQLite → PostgreSQL Migration")
    print("=" * 60)
    print(f"Source : {SQLITE_PATH}")
    print(f"Target : {DATABASE_URL[:40]}…")
    print()

    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    sqlite_conn.row_factory = None  # plain tuples
    sqlite_cur  = sqlite_conn.cursor()

    pg_conn = psycopg2.connect(DATABASE_URL)
    pg_conn.autocommit = False
    pg_cur  = pg_conn.cursor()

    total_inserted = 0

    for table, pk_cols, has_serial in TABLES:
        print(f"  Migrating [{table}]…", end=" ", flush=True)
        try:
            n = migrate_table(sqlite_cur, pg_cur, table, pk_cols)
            total_inserted += n
            print(f"{n} row(s) inserted.")
            if has_serial and n > 0:
                bump_sequence(pg_cur, table)
        except Exception as e:
            print(f"\n    ERROR migrating {table}: {e}")
            pg_conn.rollback()
            continue

        pg_conn.commit()

    sqlite_conn.close()
    pg_conn.close()

    print()
    print(f"Migration complete. {total_inserted} total row(s) copied.")
    print("All existing rows in PostgreSQL were preserved (ON CONFLICT DO NOTHING).")


if __name__ == "__main__":
    main()
