"""
pg_compat.py — Drop-in SQLite3 compatibility shim over psycopg2.

Exposes the minimal sqlite3 API used by bdc_engine.py so the engine can
connect to PostgreSQL with a single import swap:

    import pg_compat as sqlite3

Handles automatically:
  • ? → %s placeholder translation
  • INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
  • INSERT OR IGNORE INTO … → INSERT INTO … ON CONFLICT DO NOTHING
  • INSERT OR REPLACE INTO … → ON CONFLICT (pk_cols) DO UPDATE SET …
  • conn.row_factory = sqlite3.Row → dict-based rows with int+str indexing
  • cursor.lastrowid → captured via RETURNING id
  • PRAGMA table_info(tbl) → information_schema.columns query
  • ALTER TABLE ADD COLUMN failures → re-raised as OperationalError
  • IntegrityError from constraint violations
  • datetime('now', '-N days') → (NOW() - INTERVAL 'N days')
"""

import re
import psycopg2
import psycopg2.extras
import psycopg2.errors
import psycopg2.extensions

# ── Exception aliases (match sqlite3 names) ──────────────────────────────────

class OperationalError(Exception):
    """Raised for recoverable schema errors (duplicate column, missing table)."""
    pass


class IntegrityError(Exception):
    """Raised for constraint violations (UNIQUE, NOT NULL, FK, etc.)."""
    pass


# ── Row sentinel ─────────────────────────────────────────────────────────────

# Assigned as: conn.row_factory = sqlite3.Row
# Signals that cursors on this connection should return dict-like rows.
Row = object()  # singleton sentinel value


# ── DictRow — supports both row['col'] and row[0] indexing ──────────────────

class DictRow(dict):
    """Dict row that also supports integer (positional) indexing."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)

    def keys(self):           # pragma: no cover
        return super().keys()


# ── Internal: DictCursor factory ─────────────────────────────────────────────

class _DictCursor(psycopg2.extras.RealDictCursor):
    """RealDictCursor whose rows support integer indexing via DictRow."""

    def fetchone(self):
        row = super().fetchone()
        return DictRow(row) if row is not None else None

    def fetchall(self):
        return [DictRow(r) for r in super().fetchall()]

    def __iter__(self):
        for row in super().__iter__():
            yield DictRow(row)


# ── INSERT OR REPLACE conflict targets (table → pk column tuple) ─────────────

_UPSERT_TARGETS: dict[str, tuple[str, ...]] = {
    "user_sessions": ("token",),
    "posting_cycle": ("user_id", "vin"),
}


# ── SQL translator ───────────────────────────────────────────────────────────

def _translate(sql: str) -> str:
    """Translate SQLite-dialect SQL to PostgreSQL-compatible SQL."""
    s = sql.strip()
    if not s:
        return sql

    # ── PRAGMA table_info(tbl) ─────────────────────────────────────────
    m = re.match(r"PRAGMA\s+table_info\s*\(\s*(\w+)\s*\)\s*$", s, re.I)
    if m:
        tbl = m.group(1)
        # Return rows with columns at matching SQLite positions:
        #   [0]=cid  [1]=name  [2]=type  [3]=notnull  [4]=dflt_value  [5]=pk
        return (
            "SELECT ordinal_position - 1 AS cid, column_name AS name, "
            "       data_type AS type, "
            "       CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS notnull, "
            "       column_default, 0 AS pk "
            f"FROM information_schema.columns "
            f"WHERE table_name = '{tbl}' AND table_schema = 'public' "
            "ORDER BY ordinal_position"
        )

    # ── Placeholder ? → %s ────────────────────────────────────────────
    result = re.sub(r"\?", "%s", sql)

    # ── DDL: AUTOINCREMENT → SERIAL ───────────────────────────────────
    result = re.sub(
        r"INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT",
        "SERIAL PRIMARY KEY",
        result, flags=re.I,
    )

    # ── INSERT OR IGNORE → ON CONFLICT DO NOTHING ─────────────────────
    if re.search(r"\bINSERT\s+OR\s+IGNORE\s+INTO\b", sql, re.I):
        result = re.sub(
            r"\bINSERT\s+OR\s+IGNORE\s+INTO\b",
            "INSERT INTO",
            result, flags=re.I,
        )
        result = result.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
        return result

    # ── INSERT OR REPLACE → ON CONFLICT (pk) DO UPDATE SET … ─────────
    m_rep = re.match(
        r"(\s*INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\))",
        result, re.I | re.S,
    )
    if m_rep:
        tbl = m_rep.group(2).lower()
        all_cols = [c.strip() for c in m_rep.group(3).split(",")]
        conflict = _UPSERT_TARGETS.get(tbl)
        result = re.sub(
            r"\bINSERT\s+OR\s+REPLACE\s+INTO\b",
            "INSERT INTO",
            result, flags=re.I,
        )
        result = result.rstrip().rstrip(";")
        if conflict:
            pk_set = set(conflict)
            upd_cols = [c for c in all_cols if c not in pk_set]
            set_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in upd_cols)
            conflict_str = ", ".join(conflict)
            result += f" ON CONFLICT ({conflict_str}) DO UPDATE SET {set_clause}"
        else:
            result += " ON CONFLICT DO NOTHING"
        return result

    # ── SQLite datetime('now', '-N days') → PostgreSQL interval ───────
    result = re.sub(
        r"datetime\s*\(\s*'now'\s*,\s*'(-?\d+)\s+days?'\s*\)",
        lambda m: f"(NOW() - INTERVAL '{abs(int(m.group(1)))} days')",
        result, flags=re.I,
    )

    # ── REAL → FLOAT ──────────────────────────────────────────────────
    result = re.sub(r"\bREAL\b", "FLOAT", result)

    # ── Strip FOREIGN KEY constraints from CREATE TABLE ────────────────
    # SQLite does not enforce FK constraints without PRAGMA foreign_keys=ON.
    # The engine relies entirely on application-level integrity, so removing
    # them keeps CREATE TABLE order-independent (no referencing non-existent
    # tables) while preserving all data integrity logic in Python.
    if re.search(r"\bCREATE\s+TABLE\b", result, re.I) and \
       re.search(r"\bFOREIGN\s+KEY\b", result, re.I):
        result = re.sub(
            r",?\s*FOREIGN\s+KEY\s*\([^)]+\)\s*REFERENCES\s+\w+\s*\([^)]+\)",
            "",
            result, flags=re.I | re.S,
        )

    return result


# ── PgCursor ─────────────────────────────────────────────────────────────────

class PgCursor:
    """sqlite3.Cursor-compatible wrapper around a psycopg2 cursor."""

    def __init__(self, raw_cur):
        self._cur = raw_cur
        self.lastrowid: int | None = None
        self.rowcount: int = 0

    # ── core execute ──────────────────────────────────────────────────

    def execute(self, sql: str, params=None) -> None:
        translated = _translate(sql)
        params = params if params else None

        is_insert = bool(re.match(r"\s*INSERT\b", translated, re.I))
        is_alter  = bool(re.match(r"\s*ALTER\s+TABLE\b", translated, re.I))
        has_returning = bool(re.search(r"\bRETURNING\b", translated, re.I))

        # ── ALTER TABLE: wrap in savepoint so a DuplicateColumn error
        #    doesn't abort the outer transaction ─────────────────────
        if is_alter:
            self._cur.execute("SAVEPOINT _compat_alter")
            try:
                self._cur.execute(translated, params)
                self.rowcount = self._cur.rowcount
                self._cur.execute("RELEASE SAVEPOINT _compat_alter")
            except (psycopg2.errors.DuplicateColumn,
                    psycopg2.errors.UndefinedColumn,
                    psycopg2.ProgrammingError) as exc:
                self._cur.execute("ROLLBACK TO SAVEPOINT _compat_alter")
                self._cur.execute("RELEASE SAVEPOINT _compat_alter")
                raise OperationalError(str(exc)) from None
            return

        # ── INSERT: attempt RETURNING id to capture lastrowid ─────────
        if is_insert and not has_returning:
            sql_ret = translated.rstrip().rstrip(";") + " RETURNING id"
            self._cur.execute("SAVEPOINT _compat_insert")
            try:
                self._cur.execute(sql_ret, params)
                self.rowcount = self._cur.rowcount
                row = self._cur.fetchone()
                if row is not None:
                    self.lastrowid = (
                        row["id"] if isinstance(row, dict) else row[0]
                    )
                self._cur.execute("RELEASE SAVEPOINT _compat_insert")
                return
            except psycopg2.Error:
                # Table has no 'id' column — fall through to plain execute
                self._cur.execute("ROLLBACK TO SAVEPOINT _compat_insert")
                self._cur.execute("RELEASE SAVEPOINT _compat_insert")

        # ── Default path ──────────────────────────────────────────────
        try:
            self._cur.execute(translated, params)
            self.rowcount = self._cur.rowcount
        except psycopg2.IntegrityError as exc:
            raise IntegrityError(str(exc)) from exc

    def executemany(self, sql: str, seq_of_params) -> None:
        translated = _translate(sql)
        self._cur.executemany(translated, seq_of_params)
        self.rowcount = self._cur.rowcount

    # ── fetch ──────────────────────────────────────────────────────────

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def __iter__(self):
        return iter(self._cur)


# ── PgConnection ─────────────────────────────────────────────────────────────

class PgConnection:
    """sqlite3.Connection-compatible wrapper around a psycopg2 connection."""

    def __init__(self, dsn: str):
        self._conn = psycopg2.connect(dsn)
        self._conn.autocommit = False
        self.row_factory = None  # set to Row sentinel to enable dict rows

    def cursor(self) -> PgCursor:
        if self.row_factory is not None:
            raw = self._conn.cursor(cursor_factory=_DictCursor)
        else:
            raw = self._conn.cursor()
        return PgCursor(raw)

    def execute(self, sql: str, params=None) -> PgCursor:
        """Shorthand: create cursor, execute, return cursor (mirrors sqlite3 API)."""
        cur = self.cursor()
        cur.execute(sql, params)
        return cur

    def commit(self) -> None:
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self._conn.rollback()
        else:
            self._conn.commit()
        self._conn.close()


# ── Public API ────────────────────────────────────────────────────────────────

def connect(dsn: str) -> PgConnection:
    """Drop-in replacement for sqlite3.connect().

    Pass DATABASE_URL (postgres://…) instead of a file path.
    """
    return PgConnection(dsn)
