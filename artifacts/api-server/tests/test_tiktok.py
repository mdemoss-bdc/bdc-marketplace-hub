"""
TikTok integration tests for BDC Engine.

Covers:
  1. _run_migrations() — all four tiktok_* ALTER TABLE columns are present.
  2. /api/tiktok/oauth/callback — unknown state token redirects to
     ?tiktok=error&reason=state_mismatch.
  3. /api/tiktok/oauth/callback (SUCCESS PATH) — valid state + successful token
     exchange persists all four tiktok fields and redirects to ?tiktok=connected.
  4. /api/tiktok/disconnect — nullifies all four tiktok columns for the correct
     user_id and does not affect other users.
  5. /api/tiktok/publish/init — happy path returns upload_url, publish_id,
     chunk_size, total_chunks; error cases return 403/502 as appropriate.
  6. /api/tiktok/publish/status — PUBLISH_COMPLETE and FAILED paths are
     returned correctly.

The test module patches pg_compat.connect with an in-memory SQLite3
connection so no live database is required.
"""

import io
import json
import os
import sys
import sqlite3 as _real_sqlite3
import threading
import unittest
from io import BytesIO
from unittest.mock import MagicMock, patch, call

# ---------------------------------------------------------------------------
# Bootstrap: set DATABASE_URL before bdc_engine is imported so the guard
# doesn't raise RuntimeError.
# ---------------------------------------------------------------------------
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/testdb")
# Pre-seed TIKTOK_CLIENT_KEY so routes that check it don't short-circuit.
os.environ.setdefault("TIKTOK_CLIENT_KEY",    "fake_test_client_key")
os.environ.setdefault("TIKTOK_CLIENT_SECRET", "fake_test_client_secret")


# ---------------------------------------------------------------------------
# Lightweight in-memory DB shim
# ---------------------------------------------------------------------------
_MEM_DB_URI = "file:bdc_test_mem?mode=memory&cache=shared"

# Keep a persistent connection open so the in-memory database is never dropped
# between test cases.  SQLite destroys a shared-cache in-memory DB when the
# last connection closes, so we hold one open for the entire test session.
_ANCHOR_CONN = _real_sqlite3.connect(_MEM_DB_URI, uri=True, check_same_thread=False)


def _make_mem_conn(*args, **kwargs):
    """Return a real sqlite3 connection to the shared in-memory database."""
    conn = _real_sqlite3.connect(_MEM_DB_URI, uri=True, check_same_thread=False)
    conn.row_factory = _real_sqlite3.Row
    return conn


# Patch pg_compat *before* bdc_engine is imported.
import pg_compat as _pg_compat_module  # noqa: E402

# Align exception types: bdc_engine catches pg_compat.OperationalError, but the
# real sqlite3 raises _real_sqlite3.OperationalError.  Make them the same class
# so the migration loop's "except sqlite3.OperationalError: pass" swallows
# duplicate-column errors on the second init_db() call.
_pg_compat_module.OperationalError = _real_sqlite3.OperationalError
_pg_compat_module.IntegrityError   = _real_sqlite3.IntegrityError


def _patched_connect(dsn: str):
    return _make_mem_conn(dsn)


_pg_compat_module.connect = _patched_connect

# Now import bdc_engine.
import bdc_engine as engine  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed_user(conn, *, user_id: int = 1, username: str = "testuser",
               subscription_status: str = "active",
               tiktok_access_token: str | None = "tok",
               tiktok_refresh_token: str | None = "ref",
               tiktok_open_id: str | None = "oid",
               tiktok_token_expires_at: str | None = "2099-01-01"):
    """Insert a minimal user row for tests that need a real DB user."""
    conn.execute(
        """
        INSERT OR REPLACE INTO users
            (id, username, password_hash, email, subscription_status,
             tiktok_access_token, tiktok_refresh_token,
             tiktok_open_id, tiktok_token_expires_at)
        VALUES (?, ?, 'x', 'a@b.com', ?, ?, ?, ?, ?)
        """,
        (user_id, username, subscription_status,
         tiktok_access_token, tiktok_refresh_token,
         tiktok_open_id, tiktok_token_expires_at),
    )
    conn.commit()


class _FakeWFile:
    """Absorbs bytes written to the response socket."""
    def __init__(self):
        self.buf = BytesIO()
    def write(self, data):
        self.buf.write(data)
    def flush(self):
        pass


class _FakeRFile:
    def __init__(self, body: bytes = b""):
        self._body = body
    def read(self, n=-1):
        return self._body
    def readline(self):
        return b""


def _make_handler(path: str, method: str = "GET",
                  body: bytes = b"",
                  headers: dict | None = None) -> engine.BDCRequestHandler:
    """Construct a BDCRequestHandler without a real HTTP socket."""
    handler = engine.BDCRequestHandler.__new__(engine.BDCRequestHandler)
    handler.path = path
    handler.command = method
    handler.request_version = "HTTP/1.1"
    handler.headers = headers or {}
    handler.rfile = _FakeRFile(body)
    handler.wfile = _FakeWFile()
    handler._test_status = None
    handler._test_headers: dict = {}
    handler._test_chunks: list[bytes] = []

    def _send_response(code, message=None):
        handler._test_status = code

    def _send_header(name, value):
        handler._test_headers[name] = value

    def _end_headers():
        pass

    def _log_message(fmt, *args):
        pass

    handler.send_response = _send_response
    handler.send_header = _send_header
    handler.end_headers = _end_headers
    handler.log_message = _log_message
    handler.wfile.write = lambda b: handler._test_chunks.append(b)
    return handler


def _response_json(handler: engine.BDCRequestHandler) -> dict:
    """Decode the JSON body captured by the fake handler."""
    return json.loads(b"".join(handler._test_chunks))


def _ensure_schema():
    """Run init_db() once to ensure the in-memory schema is up to date."""
    with patch.object(_pg_compat_module, "connect", _patched_connect):
        engine.init_db()


# ---------------------------------------------------------------------------
# Test 1 — migrations include all four tiktok_* columns
# ---------------------------------------------------------------------------

class TestMigrations(unittest.TestCase):
    """Verify _run_migrations() SQL list covers every TikTok column."""

    EXPECTED_COLUMNS = [
        "tiktok_access_token",
        "tiktok_refresh_token",
        "tiktok_open_id",
        "tiktok_token_expires_at",
    ]

    def test_all_tiktok_columns_in_migrations(self):
        """All four tiktok_* ALTER TABLE statements must appear in the
        migration SQL list that init_db() executes."""
        executed_sql: list[str] = []

        class _CapturingCursor:
            def execute(self, sql, *args, **kwargs):
                executed_sql.append(sql)
            def fetchone(self):
                return None
            def fetchall(self):
                return []

        class _CapturingConn:
            def cursor(self):
                return _CapturingCursor()
            def execute(self, sql, *args, **kwargs):
                executed_sql.append(sql)
            def commit(self):
                pass
            def close(self):
                pass

        with patch.object(_pg_compat_module, "connect", lambda *a, **kw: _CapturingConn()):
            try:
                engine.init_db()
            except Exception:
                pass  # ignore errors from missing tables — we only need the SQL

        all_sql = "\n".join(executed_sql)
        for col in self.EXPECTED_COLUMNS:
            self.assertIn(
                col, all_sql,
                msg=f"Column '{col}' not found in any migration SQL executed by init_db().",
            )


# ---------------------------------------------------------------------------
# Test 2 — /api/tiktok/oauth/callback rejects unknown state token
# ---------------------------------------------------------------------------

class TestOAuthCallbackStateMismatch(unittest.TestCase):
    """Unknown state token must redirect to ?tiktok=error&reason=state_mismatch."""

    def test_unknown_state_redirects_to_state_mismatch(self):
        engine._TIKTOK_OAUTH_STATES.clear()
        handler = _make_handler(
            "/api/tiktok/oauth/callback?code=authcode123&state=TOTALLY_UNKNOWN_STATE"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            handler.do_GET()

        self.assertEqual(302, handler._test_status)
        location = handler._test_headers.get("Location", "")
        self.assertIn("tiktok=error",        location)
        self.assertIn("reason=state_mismatch", location)

    def test_known_state_proceeds_past_state_check(self):
        """A valid state token must NOT produce a state_mismatch redirect."""
        engine._TIKTOK_OAUTH_STATES["VALID_STATE_XYZ"] = 42
        handler = _make_handler(
            "/api/tiktok/oauth/callback?code=authcode456&state=VALID_STATE_XYZ"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch("urllib.request.urlopen", side_effect=Exception("network mocked")):
                handler.do_GET()

        location = handler._test_headers.get("Location", "")
        self.assertNotIn("state_mismatch", location)
        engine._TIKTOK_OAUTH_STATES.pop("VALID_STATE_XYZ", None)


# ---------------------------------------------------------------------------
# Test 3 — /api/tiktok/oauth/callback SUCCESS PATH
# ---------------------------------------------------------------------------

class TestOAuthCallbackSuccess(unittest.TestCase):
    """Valid state + successful token exchange must persist tokens and redirect
    to ?tiktok=connected."""

    def setUp(self):
        _ensure_schema()
        self._conn = _make_mem_conn("unused")
        _seed_user(self._conn, user_id=77, tiktok_access_token=None,
                   tiktok_refresh_token=None, tiktok_open_id=None,
                   tiktok_token_expires_at=None)

    def _fake_urlopen(self, req, timeout=None):
        """Return a fake TikTok token-exchange response."""
        body = json.dumps({
            "access_token":  "new_access_token_abc",
            "refresh_token": "new_refresh_token_xyz",
            "open_id":       "tiktok_open_id_999",
            "expires_in":    86400,
        }).encode("utf-8")
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda s: s
        resp.__exit__  = MagicMock(return_value=False)
        return resp

    def test_success_redirects_to_connected(self):
        """Successful token exchange must redirect to ?tiktok=connected."""
        engine._TIKTOK_OAUTH_STATES["STATE_SUCCESS_77"] = 77

        handler = _make_handler(
            "/api/tiktok/oauth/callback?code=authcode_ok&state=STATE_SUCCESS_77"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch("urllib.request.urlopen", side_effect=self._fake_urlopen):
                handler.do_GET()

        self.assertEqual(302, handler._test_status,
                         "Expected 302 redirect on successful OAuth callback")
        location = handler._test_headers.get("Location", "")
        self.assertIn("tiktok=connected", location,
                      f"Expected ?tiktok=connected in redirect, got: {location!r}")

    def test_success_persists_all_four_token_fields(self):
        """After a successful callback all four tiktok_* columns must be
        non-null in the users table for the correct user_id."""
        engine._TIKTOK_OAUTH_STATES["STATE_PERSIST_77"] = 77

        handler = _make_handler(
            "/api/tiktok/oauth/callback?code=authcode_ok&state=STATE_PERSIST_77"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch("urllib.request.urlopen", side_effect=self._fake_urlopen):
                handler.do_GET()

        row = self._conn.execute(
            "SELECT tiktok_access_token, tiktok_refresh_token, "
            "tiktok_open_id, tiktok_token_expires_at "
            "FROM users WHERE id = 77"
        ).fetchone()

        self.assertIsNotNone(row, "User row must exist")
        self.assertEqual("new_access_token_abc",  row["tiktok_access_token"])
        self.assertEqual("new_refresh_token_xyz", row["tiktok_refresh_token"])
        self.assertEqual("tiktok_open_id_999",    row["tiktok_open_id"])
        self.assertIsNotNone(row["tiktok_token_expires_at"],
                             "tiktok_token_expires_at must be set after successful OAuth")

    def test_state_token_consumed_after_use(self):
        """The state token must be removed from _TIKTOK_OAUTH_STATES after a
        successful callback so it cannot be replayed."""
        engine._TIKTOK_OAUTH_STATES["STATE_CONSUME_77"] = 77

        handler = _make_handler(
            "/api/tiktok/oauth/callback?code=authcode_ok&state=STATE_CONSUME_77"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch("urllib.request.urlopen", side_effect=self._fake_urlopen):
                handler.do_GET()

        self.assertNotIn("STATE_CONSUME_77", engine._TIKTOK_OAUTH_STATES,
                         "State token must be consumed after successful callback")


# ---------------------------------------------------------------------------
# Test 4 — /api/tiktok/disconnect nullifies all four tiktok columns
# ---------------------------------------------------------------------------

class TestDisconnect(unittest.TestCase):
    """DELETE /api/tiktok/disconnect must NULL all four tiktok_* columns."""

    TIKTOK_COLUMNS = [
        "tiktok_access_token",
        "tiktok_refresh_token",
        "tiktok_open_id",
        "tiktok_token_expires_at",
    ]

    def setUp(self):
        _ensure_schema()
        self._conn = _make_mem_conn("unused")
        _seed_user(self._conn, user_id=99)

    def test_disconnect_nullifies_all_tiktok_columns(self):
        """After calling disconnect, all four tiktok_* columns must be NULL."""
        fake_user = {
            "id": 99, "username": "testuser",
            "tiktok_access_token": "tok", "tiktok_refresh_token": "ref",
            "tiktok_open_id": "oid", "tiktok_token_expires_at": "2099-01-01",
        }
        handler = _make_handler("/api/tiktok/disconnect", method="DELETE")
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch("urllib.request.urlopen", side_effect=Exception("mocked")):
                    handler.do_DELETE()

        row = self._conn.execute(
            "SELECT tiktok_access_token, tiktok_refresh_token, "
            "tiktok_open_id, tiktok_token_expires_at FROM users WHERE id = 99"
        ).fetchone()
        self.assertIsNotNone(row)
        for col in self.TIKTOK_COLUMNS:
            self.assertIsNone(row[col],
                              f"Column '{col}' should be NULL after disconnect")

    def test_disconnect_returns_success(self):
        """Disconnect endpoint must return {"success": True}."""
        fake_user = {
            "id": 99, "username": "testuser",
            "tiktok_access_token": "tok", "tiktok_refresh_token": "ref",
            "tiktok_open_id": "oid", "tiktok_token_expires_at": "2099-01-01",
        }
        handler = _make_handler("/api/tiktok/disconnect", method="DELETE")
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch("urllib.request.urlopen", side_effect=Exception("mocked")):
                    handler.do_DELETE()

        self.assertEqual(200, handler._test_status)
        data = _response_json(handler)
        self.assertTrue(data.get("success"), f"Expected success=True, got: {data}")

    def test_disconnect_does_not_affect_other_users(self):
        """Disconnecting user 99 must not change TikTok columns for user 98."""
        _seed_user(self._conn, user_id=98, username="otheruser",
                   tiktok_access_token="other_tok", tiktok_open_id="other_oid")

        fake_user = {
            "id": 99, "username": "testuser",
            "tiktok_access_token": "tok", "tiktok_refresh_token": "ref",
            "tiktok_open_id": "oid", "tiktok_token_expires_at": "2099-01-01",
        }
        handler = _make_handler("/api/tiktok/disconnect", method="DELETE")
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch("urllib.request.urlopen", side_effect=Exception("mocked")):
                    handler.do_DELETE()

        row98 = self._conn.execute(
            "SELECT tiktok_access_token FROM users WHERE id = 98"
        ).fetchone()
        self.assertIsNotNone(row98)
        self.assertEqual("other_tok", row98["tiktok_access_token"])


# ---------------------------------------------------------------------------
# Test 5 — /api/tiktok/publish/init
# ---------------------------------------------------------------------------

class TestPublishInit(unittest.TestCase):
    """POST /api/tiktok/publish/init returns upload details or appropriate errors."""

    def setUp(self):
        _ensure_schema()
        self._conn = _make_mem_conn("unused")
        _seed_user(self._conn, user_id=55, subscription_status="active")

    def _fake_urlopen_init(self, req, timeout=None):
        """Return a fake TikTok publish/video/init/ response."""
        body = json.dumps({
            "data": {
                "publish_id":  "pub_id_abc123",
                "upload_url":  "https://upload.tiktok.example.com/video/slot/abc",
            },
            "error": {"code": "ok", "message": ""},
        }).encode("utf-8")
        resp = MagicMock()
        resp.read.return_value = body
        resp.__enter__ = lambda s: s
        resp.__exit__  = MagicMock(return_value=False)
        return resp

    def test_happy_path_returns_upload_fields(self):
        """Happy path: TikTok init succeeds → response includes all required fields."""
        fake_user = {
            "id": 55, "username": "pro_user",
            "subscription_status": "active", "is_admin": False,
            "tiktok_access_token": "pro_tok",
        }
        body = json.dumps({"title": "Cool Car", "video_size": 5_000_000}).encode()
        handler = _make_handler(
            "/api/tiktok/publish/init",
            method="POST", body=body,
            headers={"Content-Length": str(len(body))},
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  return_value="pro_tok"):
                    with patch("urllib.request.urlopen", side_effect=self._fake_urlopen_init):
                        handler.do_POST()

        self.assertEqual(200, handler._test_status)
        data = _response_json(handler)
        self.assertTrue(data.get("success"), f"Expected success=True, got: {data}")
        self.assertIn("upload_url",   data)
        self.assertIn("publish_id",   data)
        self.assertIn("chunk_size",   data)
        self.assertIn("total_chunks", data)
        self.assertEqual("pub_id_abc123", data["publish_id"])
        self.assertGreater(data["total_chunks"], 0)

    def test_chunk_count_computed_from_video_size(self):
        """total_chunks must be ceil(video_size / 10MB)."""
        fake_user = {
            "id": 55, "username": "pro_user",
            "subscription_status": "active", "is_admin": False,
            "tiktok_access_token": "pro_tok",
        }
        # 25 MB video → ceil(25/10) = 3 chunks
        body = json.dumps({"title": "Video", "video_size": 25 * 1024 * 1024}).encode()
        handler = _make_handler(
            "/api/tiktok/publish/init",
            method="POST", body=body,
            headers={"Content-Length": str(len(body))},
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  return_value="pro_tok"):
                    with patch("urllib.request.urlopen", side_effect=self._fake_urlopen_init):
                        handler.do_POST()

        data = _response_json(handler)
        self.assertEqual(3, data.get("total_chunks"),
                         "25 MB video should produce 3 chunks of 10 MB each")

    def test_no_tiktok_token_returns_403(self):
        """User with no tiktok_access_token must receive a 403 error."""
        fake_user = {
            "id": 55, "username": "pro_user",
            "subscription_status": "active", "is_admin": False,
            "tiktok_access_token": "",   # ← not connected
        }
        body = json.dumps({"title": "Video", "video_size": 1_000_000}).encode()
        handler = _make_handler(
            "/api/tiktok/publish/init",
            method="POST", body=body,
            headers={"Content-Length": str(len(body))},
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  side_effect=engine.TikTokTokenExpiredError("not connected")):
                    handler.do_POST()

        self.assertEqual(403, handler._test_status)
        data = _response_json(handler)
        self.assertIn("error", data)

    def test_tiktok_api_failure_returns_502(self):
        """When TikTok's init API returns an empty upload_url, a 502 is sent."""
        fake_user = {
            "id": 55, "username": "pro_user",
            "subscription_status": "active", "is_admin": False,
            "tiktok_access_token": "pro_tok",
        }
        def _bad_tiktok(req, timeout=None):
            body = json.dumps({"data": {}, "error": {"code": "spam_risk", "message": "Spam risk"}}).encode()
            resp = MagicMock()
            resp.read.return_value = body
            resp.__enter__ = lambda s: s
            resp.__exit__  = MagicMock(return_value=False)
            return resp

        body = json.dumps({"title": "Video", "video_size": 1_000_000}).encode()
        handler = _make_handler(
            "/api/tiktok/publish/init",
            method="POST", body=body,
            headers={"Content-Length": str(len(body))},
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  return_value="pro_tok"):
                    with patch("urllib.request.urlopen", side_effect=_bad_tiktok):
                        handler.do_POST()

        self.assertEqual(502, handler._test_status)
        data = _response_json(handler)
        self.assertFalse(data.get("success", True))


# ---------------------------------------------------------------------------
# Test 6 — /api/tiktok/publish/status
# ---------------------------------------------------------------------------

class TestPublishStatus(unittest.TestCase):
    """GET /api/tiktok/publish/status correctly surfaces TikTok publish results."""

    def setUp(self):
        _ensure_schema()
        self._conn = _make_mem_conn("unused")
        _seed_user(self._conn, user_id=44, username="poster",
                   subscription_status="active")

    def _make_status_urlopen(self, status: str, fail_reason: str = ""):
        """Return a fake urlopen that responds with the given TikTok status."""
        body = json.dumps({
            "data": {"status": status, "fail_reason": fail_reason}
        }).encode("utf-8")
        def _urlopen(req, timeout=None):
            resp = MagicMock()
            resp.read.return_value = body
            resp.__enter__ = lambda s: s
            resp.__exit__  = MagicMock(return_value=False)
            return resp
        return _urlopen

    def _fake_user(self):
        return {
            "id": 44, "username": "poster",
            "subscription_status": "active",
            "tiktok_access_token": "tok44",
        }

    def test_publish_complete_returned_correctly(self):
        """PUBLISH_COMPLETE status from TikTok must be forwarded as-is."""
        handler = _make_handler(
            "/api/tiktok/publish/status?publish_id=pub_abc"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=self._fake_user()):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  return_value="tok44"):
                    with patch("urllib.request.urlopen",
                               side_effect=self._make_status_urlopen("PUBLISH_COMPLETE")):
                        handler.do_GET()

        self.assertEqual(200, handler._test_status)
        data = _response_json(handler)
        self.assertEqual("PUBLISH_COMPLETE", data.get("status"))

    def test_failed_status_includes_fail_reason(self):
        """FAILED status must include the fail_reason from TikTok's response."""
        handler = _make_handler(
            "/api/tiktok/publish/status?publish_id=pub_xyz"
        )
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=self._fake_user()):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  return_value="tok44"):
                    with patch("urllib.request.urlopen",
                               side_effect=self._make_status_urlopen("FAILED", "video_too_long")):
                        handler.do_GET()

        self.assertEqual(200, handler._test_status)
        data = _response_json(handler)
        self.assertEqual("FAILED",         data.get("status"))
        self.assertEqual("video_too_long", data.get("fail_reason"))

    def test_missing_publish_id_returns_400(self):
        """Missing publish_id query param must return 400."""
        handler = _make_handler("/api/tiktok/publish/status")  # no publish_id
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=self._fake_user()):
                handler.do_GET()

        self.assertEqual(400, handler._test_status)

    def test_no_tiktok_token_returns_403(self):
        """User without tiktok_access_token must get 403."""
        handler = _make_handler("/api/tiktok/publish/status?publish_id=pub_abc")
        fake_user = {
            "id": 44, "username": "poster",
            "subscription_status": "active",
            "tiktok_access_token": "",  # ← not connected
        }
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=fake_user):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  side_effect=engine.TikTokTokenExpiredError("not connected")):
                    handler.do_GET()

        self.assertEqual(403, handler._test_status)

    def test_tiktok_api_error_returns_502(self):
        """Network/TikTok error on status check must return 502."""
        handler = _make_handler("/api/tiktok/publish/status?publish_id=pub_abc")
        with patch.object(_pg_compat_module, "connect", _patched_connect):
            with patch.object(handler, "_require_auth", return_value=self._fake_user()):
                with patch.object(engine.TikTokTokenManager, "refresh_if_needed",
                                  return_value="tok44"):
                    with patch("urllib.request.urlopen", side_effect=Exception("TikTok down")):
                        handler.do_GET()

        self.assertEqual(502, handler._test_status)


# ---------------------------------------------------------------------------
# Test 7 — _expire_stale_tiktok_posts() sweep behaviour
# ---------------------------------------------------------------------------

import re as _re
from datetime import datetime as _datetime, timedelta as _timedelta


class _TranslatingConn:
    """Wraps a real SQLite connection and translates the one PostgreSQL-ism
    used by _expire_stale_tiktok_posts() so the function can run end-to-end
    against an in-memory SQLite database.

    Specifically it rewrites:
        NOW() - INTERVAL 'N hours'
    to:
        datetime('FIXED_NOW', '-N hours')
    where FIXED_NOW is the deterministic timestamp supplied at construction
    time, giving tests complete control over which rows fall inside or outside
    the timeout window.
    """

    _INTERVAL_RE = _re.compile(
        r"NOW\(\)\s*-\s*INTERVAL\s*'(\d+)\s*hours'",
        _re.IGNORECASE,
    )

    def __init__(self, real_conn: "_real_sqlite3.Connection", fixed_now: str):
        self._conn = real_conn
        self._fixed_now = fixed_now

    def _translate(self, sql: str) -> str:
        return self._INTERVAL_RE.sub(
            lambda m: f"datetime('{self._fixed_now}', '-{m.group(1)} hours')",
            sql,
        )

    def execute(self, sql: str, *args, **kwargs):
        return self._conn.execute(self._translate(sql), *args, **kwargs)

    def cursor(self):
        return self._conn.cursor()

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        pass  # never close the shared anchor connection


class TestExpireStalePostsSweep(unittest.TestCase):
    """_expire_stale_tiktok_posts() must age out overdue PROCESSING rows to
    FAILED while leaving rows that are recent, already FAILED, or
    PUBLISH_COMPLETE entirely unchanged.

    Test strategy
    -------------
    We fix a synthetic 'now' timestamp so the cutoff is deterministic and
    independent of the real wall clock.  A _TranslatingConn wrapper rewrites
    the one PostgreSQL-specific expression in the UPDATE query
    (``NOW() - INTERVAL 'N hours'``) into the equivalent SQLite
    ``datetime('FIXED_NOW', '-N hours')`` form so the function executes
    against a real in-memory database and produces real row mutations.

    Rows inserted
    -------------
    id=1  PROCESSING  posted 48 h before fixed_now  → must become FAILED
    id=2  PROCESSING  posted 25 h before fixed_now  → must become FAILED
    id=3  PROCESSING  posted  1 h before fixed_now  → must stay  PROCESSING
    id=4  PROCESSING  posted  0 h before fixed_now  → must stay  PROCESSING
    id=5  FAILED      posted 48 h before fixed_now  → must stay  FAILED
    id=6  PUBLISH_COMPLETE posted 48 h before       → must stay  PUBLISH_COMPLETE
    """

    # Freeze "now" to a fixed UTC string so every assertion is deterministic.
    FIXED_NOW: str = "2026-01-15 12:00:00"
    TIMEOUT_H: int = 24  # mirrors engine.TIKTOK_PROCESSING_TIMEOUT_HOURS

    def setUp(self):
        _ensure_schema()
        # Open a live connection to the shared in-memory DB.
        self._conn = _make_mem_conn("unused")

        # Ensure tiktok_posts has at least one seed user to satisfy FK.
        _seed_user(self._conn, user_id=1)

        # Clear any leftover tiktok_posts rows from previous tests.
        self._conn.execute("DELETE FROM tiktok_posts")
        self._conn.commit()

        fixed = _datetime.strptime(self.FIXED_NOW, "%Y-%m-%d %H:%M:%S")

        def ts(hours_ago: float) -> str:
            return (fixed - _timedelta(hours=hours_ago)).strftime(
                "%Y-%m-%d %H:%M:%S"
            )

        rows = [
            # (publish_id, status, posted_at)
            ("pub_old_proc_1",  "PROCESSING",       ts(48)),   # id=1, must expire
            ("pub_old_proc_2",  "PROCESSING",       ts(25)),   # id=2, must expire
            ("pub_fresh_proc",  "PROCESSING",       ts(1)),    # id=3, must NOT expire
            ("pub_now_proc",    "PROCESSING",       ts(0)),    # id=4, must NOT expire
            ("pub_old_fail",    "FAILED",           ts(48)),   # id=5, must stay FAILED
            ("pub_old_done",    "PUBLISH_COMPLETE", ts(48)),   # id=6, must stay PUBLISH_COMPLETE
        ]
        self._conn.executemany(
            "INSERT INTO tiktok_posts (user_id, publish_id, title, status, posted_at) "
            "VALUES (1, ?, '', ?, ?)",
            rows,
        )
        self._conn.commit()

        # Remember the publish_ids so assertions are index-independent.
        self._ids: dict[str, int] = {}
        for row in self._conn.execute(
            "SELECT id, publish_id FROM tiktok_posts"
        ).fetchall():
            self._ids[row["publish_id"]] = row["id"]

    def _run_sweep(self) -> int:
        """Invoke _expire_stale_tiktok_posts() with a patched DB connection
        that uses the fixed 'now' timestamp.

        The engine constant TIKTOK_PROCESSING_TIMEOUT_HOURS is temporarily
        overridden to self.TIMEOUT_H so the test is self-contained even if
        the constant ever changes.
        """
        translating_conn = _TranslatingConn(self._conn, self.FIXED_NOW)

        with patch.object(engine, "TIKTOK_PROCESSING_TIMEOUT_HOURS", self.TIMEOUT_H):
            with patch.object(_pg_compat_module, "connect",
                              return_value=translating_conn):
                return engine._expire_stale_tiktok_posts()

    def _status(self, publish_id: str) -> str:
        row = self._conn.execute(
            "SELECT status FROM tiktok_posts WHERE publish_id = ?",
            (publish_id,),
        ).fetchone()
        self.assertIsNotNone(row, f"Row for publish_id={publish_id!r} not found")
        return row["status"]

    # ── assertions ───────────────────────────────────────────────────────────

    def test_overdue_processing_rows_become_failed(self):
        """PROCESSING rows older than TIMEOUT_H must be updated to FAILED."""
        self._run_sweep()
        self.assertEqual("FAILED", self._status("pub_old_proc_1"),
                         "48-h-old PROCESSING row must be aged out to FAILED")
        self.assertEqual("FAILED", self._status("pub_old_proc_2"),
                         "25-h-old PROCESSING row must be aged out to FAILED")

    def test_recent_processing_rows_unchanged(self):
        """PROCESSING rows younger than TIMEOUT_H must NOT be touched."""
        self._run_sweep()
        self.assertEqual("PROCESSING", self._status("pub_fresh_proc"),
                         "1-h-old PROCESSING row must not be expired")
        self.assertEqual("PROCESSING", self._status("pub_now_proc"),
                         "Just-inserted PROCESSING row must not be expired")

    def test_already_failed_rows_unchanged(self):
        """Rows already in FAILED status must not be altered by the sweep."""
        self._run_sweep()
        self.assertEqual("FAILED", self._status("pub_old_fail"),
                         "Pre-existing FAILED row must remain FAILED (not re-written)")

    def test_publish_complete_rows_unchanged(self):
        """PUBLISH_COMPLETE rows must not be touched regardless of age."""
        self._run_sweep()
        self.assertEqual("PUBLISH_COMPLETE", self._status("pub_old_done"),
                         "PUBLISH_COMPLETE row must never be modified by the sweep")

    def test_return_value_equals_expired_count(self):
        """_expire_stale_tiktok_posts() must return the count of rows it updated."""
        count = self._run_sweep()
        self.assertEqual(2, count,
                         "Expected exactly 2 PROCESSING rows to be expired")

    def test_second_sweep_is_idempotent(self):
        """Running the sweep twice must not change any more rows on the second pass."""
        self._run_sweep()
        second_count = self._run_sweep()
        self.assertEqual(0, second_count,
                         "Second sweep must return 0; no new rows should be expirable")
        # And all statuses must still be correct after the second pass.
        self.assertEqual("FAILED",           self._status("pub_old_proc_1"))
        self.assertEqual("FAILED",           self._status("pub_old_proc_2"))
        self.assertEqual("PROCESSING",       self._status("pub_fresh_proc"))
        self.assertEqual("FAILED",           self._status("pub_old_fail"))
        self.assertEqual("PUBLISH_COMPLETE", self._status("pub_old_done"))


if __name__ == "__main__":
    unittest.main()
