"""
Failure-injection tests for bdc_engine.py write paths.

Each test injects a simulated DB error (via MagicMock) into a write path and
asserts:
  1. conn.rollback() is called.
  2. conn.close() is called (via the finally clause).
  3. The original exception propagates to the caller.

Write paths covered
-------------------
A. EmailQueueManager.create_draft  — INSERT failure / commit failure
B. EmailQueueManager.update_status — INSERT failure / commit failure
C. _persist_token                  — module-level helper
D. _revoke_token                   — module-level helper
E. TikTokTokenManager._revoke_stored_tokens — static method
F. UserManager.register            — IntegrityError on the INSERT branch
G. Server startup smoke            — init_db() runs cleanly on a fresh
                                     in-memory database (and is idempotent)
"""

import os
import sqlite3 as _real_sqlite3
import unittest
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Bootstrap: DATABASE_URL must be set before bdc_engine is imported.
# ---------------------------------------------------------------------------
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/testdb")
os.environ.setdefault("TIKTOK_CLIENT_KEY",    "fake_key")
os.environ.setdefault("TIKTOK_CLIENT_SECRET", "fake_secret")

import pg_compat as _pg_compat_module  # noqa: E402

# Align exception types with what the real sqlite3 module raises so that
# "except sqlite3.IntegrityError" / "except sqlite3.OperationalError" in
# bdc_engine.py correctly catches our injected errors.
_pg_compat_module.OperationalError = _real_sqlite3.OperationalError
_pg_compat_module.IntegrityError   = _real_sqlite3.IntegrityError

import bdc_engine as engine  # noqa: E402


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _conn_cursor_failing_on_execute(exc):
    """Return (mock_conn, mock_cursor) where cursor.execute() raises *exc*.

    conn.execute() also raises so module-level helpers that call conn.execute()
    directly also trigger the error.
    """
    conn   = MagicMock()
    cursor = MagicMock()
    conn.cursor.return_value = cursor
    cursor.execute.side_effect = exc
    conn.execute.side_effect   = exc
    return conn, cursor


def _conn_failing_on_commit(exc):
    """Return mock_conn where conn.commit() raises *exc*."""
    conn   = MagicMock()
    cursor = MagicMock()
    conn.cursor.return_value  = cursor
    cursor.execute.return_value = None          # execute succeeds
    conn.execute.return_value   = None
    conn.commit.side_effect     = exc
    return conn, cursor


# ---------------------------------------------------------------------------
# A. EmailQueueManager.create_draft
# ---------------------------------------------------------------------------

class TestCreateDraftRollback(unittest.TestCase):
    """create_draft() must rollback + close + re-raise on any DB error."""

    def _call(self, mock_conn):
        with patch.object(_pg_compat_module, "connect", return_value=mock_conn):
            engine.EmailQueueManager.create_draft(
                user_id=1,
                phone_number="+15550000",
                customer_name="Test",
                summary="s",
                subject="subj",
                body="body",
            )

    # ── execute() failure ────────────────────────────────────────────────────

    def test_execute_failure_calls_rollback(self):
        conn, _ = _conn_cursor_failing_on_execute(
            _real_sqlite3.OperationalError("disk full"))
        with self.assertRaises(_real_sqlite3.OperationalError):
            self._call(conn)
        conn.rollback.assert_called_once()

    def test_execute_failure_calls_close(self):
        conn, _ = _conn_cursor_failing_on_execute(
            _real_sqlite3.OperationalError("disk full"))
        with self.assertRaises(_real_sqlite3.OperationalError):
            self._call(conn)
        conn.close.assert_called_once()

    def test_execute_failure_reraises_original(self):
        err = _real_sqlite3.OperationalError("disk full")
        conn, _ = _conn_cursor_failing_on_execute(err)
        with self.assertRaises(_real_sqlite3.OperationalError) as ctx:
            self._call(conn)
        self.assertIs(ctx.exception, err)

    # ── commit() failure ────────────────────────────────────────────────────

    def test_commit_failure_calls_rollback(self):
        conn, _ = _conn_failing_on_commit(
            _real_sqlite3.OperationalError("commit error"))
        with self.assertRaises(_real_sqlite3.OperationalError):
            self._call(conn)
        conn.rollback.assert_called_once()

    def test_commit_failure_calls_close(self):
        conn, _ = _conn_failing_on_commit(
            _real_sqlite3.OperationalError("commit error"))
        with self.assertRaises(_real_sqlite3.OperationalError):
            self._call(conn)
        conn.close.assert_called_once()


# ---------------------------------------------------------------------------
# B. EmailQueueManager.update_status
# ---------------------------------------------------------------------------

class TestUpdateStatusRollback(unittest.TestCase):
    """update_status() must rollback + close + re-raise on any DB error."""

    def _call(self, mock_conn):
        with patch.object(_pg_compat_module, "connect", return_value=mock_conn):
            engine.EmailQueueManager.update_status(
                email_id=1, user_id=1, status="sent")

    def test_execute_failure_calls_rollback_and_close(self):
        conn, _ = _conn_cursor_failing_on_execute(
            _real_sqlite3.OperationalError("io error"))
        with self.assertRaises(_real_sqlite3.OperationalError):
            self._call(conn)
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()

    def test_execute_failure_reraises(self):
        err = _real_sqlite3.OperationalError("io error")
        conn, _ = _conn_cursor_failing_on_execute(err)
        with self.assertRaises(_real_sqlite3.OperationalError) as ctx:
            self._call(conn)
        self.assertIs(ctx.exception, err)

    def test_commit_failure_calls_rollback_and_close(self):
        conn, _ = _conn_failing_on_commit(
            _real_sqlite3.OperationalError("commit error"))
        with self.assertRaises(_real_sqlite3.OperationalError):
            self._call(conn)
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()


# ---------------------------------------------------------------------------
# C. _persist_token
# ---------------------------------------------------------------------------

class TestPersistTokenRollback(unittest.TestCase):
    """`_persist_token` must rollback + close + re-raise on execute failure."""

    def test_execute_failure_calls_rollback_and_close(self):
        conn = MagicMock()
        conn.execute.side_effect = _real_sqlite3.OperationalError("write failed")
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(_real_sqlite3.OperationalError):
                engine._persist_token("tok", user_id=42)
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()

    def test_execute_failure_reraises(self):
        err = _real_sqlite3.OperationalError("write failed")
        conn = MagicMock()
        conn.execute.side_effect = err
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(_real_sqlite3.OperationalError) as ctx:
                engine._persist_token("tok", user_id=42)
        self.assertIs(ctx.exception, err)


# ---------------------------------------------------------------------------
# D. _revoke_token
# ---------------------------------------------------------------------------

class TestRevokeTokenRollback(unittest.TestCase):
    """`_revoke_token` must rollback + close + re-raise on execute failure."""

    def test_execute_failure_calls_rollback_and_close(self):
        conn = MagicMock()
        conn.execute.side_effect = _real_sqlite3.OperationalError("write failed")
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(_real_sqlite3.OperationalError):
                engine._revoke_token("tok")
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()

    def test_execute_failure_reraises(self):
        err = _real_sqlite3.OperationalError("write failed")
        conn = MagicMock()
        conn.execute.side_effect = err
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(_real_sqlite3.OperationalError) as ctx:
                engine._revoke_token("tok")
        self.assertIs(ctx.exception, err)


# ---------------------------------------------------------------------------
# E. TikTokTokenManager._revoke_stored_tokens
# ---------------------------------------------------------------------------

class TestRevokeStoredTokensRollback(unittest.TestCase):
    """`_revoke_stored_tokens` must rollback + close + re-raise on failure."""

    def test_execute_failure_calls_rollback_and_close(self):
        conn = MagicMock()
        conn.execute.side_effect = _real_sqlite3.OperationalError("write failed")
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(_real_sqlite3.OperationalError):
                engine.TikTokTokenManager._revoke_stored_tokens(user_id=7)
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()

    def test_execute_failure_reraises(self):
        err = _real_sqlite3.OperationalError("write failed")
        conn = MagicMock()
        conn.execute.side_effect = err
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(_real_sqlite3.OperationalError) as ctx:
                engine.TikTokTokenManager._revoke_stored_tokens(user_id=7)
        self.assertIs(ctx.exception, err)


# ---------------------------------------------------------------------------
# F. UserManager.register — IntegrityError on the INSERT branch
# ---------------------------------------------------------------------------

class TestRegisterRollback(unittest.TestCase):
    """When the INSERT raises IntegrityError, rollback() and close() must be
    called and ValueError("Username already exists.") must propagate."""

    def _make_register_conn(self):
        """Return a mock connection that succeeds on SELECT checks but raises
        IntegrityError on the INSERT INTO users statement."""
        conn   = MagicMock()
        cursor = MagicMock()
        conn.cursor.return_value  = cursor
        conn.row_factory          = None

        def _execute(sql, *args, **kwargs):
            if sql.lstrip().upper().startswith("INSERT INTO USERS"):
                raise _real_sqlite3.IntegrityError(
                    "UNIQUE constraint failed: users.username")
            # All other statements (SELECTs) succeed silently.

        cursor.execute.side_effect = _execute
        cursor.fetchone.return_value = None   # no duplicate found in checks
        return conn

    def test_integrity_error_calls_rollback(self):
        conn = self._make_register_conn()
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(ValueError):
                engine.UserManager.register(
                    username="newuser",
                    password="password123",
                    email="newuser@example.com",
                )
        conn.rollback.assert_called()

    def test_integrity_error_calls_close(self):
        conn = self._make_register_conn()
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(ValueError):
                engine.UserManager.register(
                    username="newuser",
                    password="password123",
                    email="newuser@example.com",
                )
        conn.close.assert_called()

    def test_integrity_error_raises_value_error(self):
        conn = self._make_register_conn()
        with patch.object(_pg_compat_module, "connect", return_value=conn):
            with self.assertRaises(ValueError) as ctx:
                engine.UserManager.register(
                    username="newuser",
                    password="password123",
                    email="newuser@example.com",
                )
        self.assertIn("already exists", str(ctx.exception).lower())


# ---------------------------------------------------------------------------
# G. Server startup smoke — init_db() on a fresh in-memory database
# ---------------------------------------------------------------------------

_SMOKE_MEM_URI = "file:bdc_rollback_smoke?mode=memory&cache=shared"
# Hold one connection open so the in-memory DB persists across test methods.
_SMOKE_ANCHOR  = _real_sqlite3.connect(_SMOKE_MEM_URI, uri=True,
                                       check_same_thread=False)


def _make_smoke_conn(*args, **kwargs):
    c = _real_sqlite3.connect(_SMOKE_MEM_URI, uri=True, check_same_thread=False)
    c.row_factory = _real_sqlite3.Row
    return c


class TestServerStartupSmoke(unittest.TestCase):
    """init_db() must complete without raising on a fresh in-memory database."""

    def setUp(self):
        _pg_compat_module.OperationalError = _real_sqlite3.OperationalError
        _pg_compat_module.IntegrityError   = _real_sqlite3.IntegrityError

    def test_init_db_starts_cleanly(self):
        """init_db() must not raise on a brand-new database."""
        with patch.object(_pg_compat_module, "connect", _make_smoke_conn):
            try:
                engine.init_db()
            except Exception as exc:
                self.fail(f"init_db() raised unexpectedly: {exc}")

    def test_init_db_is_idempotent(self):
        """Calling init_db() a second time (IF NOT EXISTS) must not raise."""
        with patch.object(_pg_compat_module, "connect", _make_smoke_conn):
            try:
                engine.init_db()
                engine.init_db()
            except Exception as exc:
                self.fail(f"Second init_db() raised unexpectedly: {exc}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
