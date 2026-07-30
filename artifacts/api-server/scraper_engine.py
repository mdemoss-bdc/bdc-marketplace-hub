"""Inventory scraper sync-session registry, cancellation, and rooftop helpers.

Multi-user scrape jobs are tracked in ``sync_sessions`` so any account
(mdemoss, jdemoss, new rooftops, …) can cancel their own running sync
cooperatively.  Multi-location scraper source configs
(``inventory_locations`` JSON on ``users``) and location / dealership-group
resolution for multi-rooftop networks also live here so ``bdc_engine`` and
future scrapers share one implementation.  ``main.py`` still boots
``bdc_engine.py`` unchanged.
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import unquote, urlparse

# Populated by bdc_engine after DB_FILE is known (avoids circular import at
# module load).  Call ``configure(db_path)`` once during engine startup.
_DB_FILE: str = ""
_CTX = threading.local()

_VALID_STATUSES = frozenset({"running", "cancelling", "cancelled", "completed"})

# In-memory cancel flags — set by POST /api/scrape/cancel so workers see the
# abort on the next line without waiting on a SQLite round-trip.
# Keyed by session_id and by ``user:{user_id}``.
_CANCEL_FLAGS: dict[str, bool] = {}
_CANCEL_LOCK = threading.Lock()
_ABORT_LOGGED: set[str] = set()

# Host → default dealership group / rooftop when the SRP does not ship a
# per-vehicle branch attribute (single-location dealers).
_HOST_DEALERSHIP_DEFAULTS: dict[str, tuple[str, str]] = {
    "universityfordwv.com": ("University Ford", "University Ford - St. Albans"),
    "mosescars.com": ("Moses Auto Group", ""),
    "glockner.com": ("Glockner", ""),
}

_DEFAULT_UF_LOT = "University Ford - Main Lot"


def configure(db_path: str) -> None:
    """Point the registry at the live SQLite / Postgres-compat file."""
    global _DB_FILE
    _DB_FILE = db_path


def _conn() -> sqlite3.Connection:
    if not _DB_FILE:
        raise RuntimeError("scraper_engine.configure(db_path) was not called")
    return sqlite3.connect(_DB_FILE, timeout=30)


def ensure_schema(conn: sqlite3.Connection | None = None) -> None:
    """Create ``sync_sessions`` and inventory rooftop columns if missing."""
    own = conn is None
    if own:
        conn = _conn()
    assert conn is not None
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_sessions (
                session_id    TEXT PRIMARY KEY,
                user_id       TEXT NOT NULL,
                status        TEXT NOT NULL DEFAULT 'running',
                scraped_count INTEGER NOT NULL DEFAULT 0,
                updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sync_sessions_user_status "
            "ON sync_sessions (user_id, status)"
        )
        # marketplace_inventory rooftop columns (idempotent ALTERs).
        for sql in (
            "ALTER TABLE marketplace_inventory ADD COLUMN location TEXT DEFAULT ''",
            "ALTER TABLE marketplace_inventory ADD COLUMN dealership_group TEXT DEFAULT ''",
            "ALTER TABLE marketplace_inventory ADD COLUMN condition TEXT DEFAULT 'Used'",
        ):
            try:
                conn.execute(sql)
            except sqlite3.OperationalError:
                pass
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def format_dealer_location(group: str, city_or_lot: str) -> str:
    """Build a Hub-friendly rooftop label: ``University Ford - St. Albans``."""
    city = re.sub(r"\s+", " ", (city_or_lot or "").strip())
    brand = re.sub(r"\s+", " ", (group or "").strip())
    if not city:
        return ""
    # Strip a trailing " Location" suffix from older scrapes.
    if city.lower().endswith(" location"):
        city = city[: -len(" location")].strip()
    if brand and city.lower().startswith(brand.lower()):
        return city
    if brand:
        return f"{brand} - {city}"
    return city


def format_rooftop_label(raw: str) -> str:
    """Normalise a city / store name into a Hub dropdown label."""
    return format_dealer_location("", raw)



def infer_location_from_vdp(vdp_url: str) -> str:
    """Pull rooftop city from DealerOn-style VDP slugs.

    Example:
      ``/used-Huntington-2025-Ford-F-150-…`` → ``Huntington Location``
      ``/new-St+Albans-2026-Ford-…`` → ``St Albans Location``
    """
    if not vdp_url:
        return ""
    path = unquote(urlparse(vdp_url).path or "")
    m = re.search(
        r"/(?:new|used|certified)-([A-Za-z][A-Za-z0-9+._ -]*?)-\d{4}-",
        path,
        re.I,
    )
    if not m:
        return ""
    city = m.group(1).replace("+", " ").replace("_", " ").replace(".", " ").strip()
    city = re.sub(r"\s+", " ", city)
    if not city or city.lower() in ("inventory", "vehicle", "detail"):
        return ""
    return format_rooftop_label(city)


def dealership_defaults_for_url(url_or_host: str) -> tuple[str, str]:
    """Return ``(dealership_group, default_location)`` for a site host."""
    if not url_or_host:
        return ("", "")
    host = url_or_host.strip().lower()
    if "://" in host:
        host = (urlparse(host).netloc or host).lower()
    host = host[4:] if host.startswith("www.") else host
    for domain, pair in _HOST_DEALERSHIP_DEFAULTS.items():
        if host == domain or host.endswith("." + domain):
            return pair
    # Single-location fallback: use the registrable-looking host label.
    label = host.split(".")[0].replace("-", " ").strip().title() if host else ""
    return (label, format_rooftop_label(label) if label else "")


def resolve_vehicle_rooftop(
    *,
    card: dict | None = None,
    vdp_url: str = "",
    base_url: str = "",
    fallback_location: str = "",
) -> tuple[str, str]:
    """Resolve ``(location, dealership_group)`` for one scraped vehicle.

    Priority for location:
      1. Explicit card branch / city fields (DealerLocatedAtCity, …)
      2. City token embedded in the VDP URL slug
      3. Caller fallback / host default for single-location sites

    Dealership group prefers the dealer brand name over the rooftop city.
    """
    card = card or {}
    group = ""
    loc = ""

    for key in (
        "DealerName", "dealerName", "dealership_group", "DealershipGroup",
        "dealer_group", "rooftopGroup",
    ):
        val = str(card.get(key) or "").strip()
        if val:
            group = val
            break

    # Prefer explicit city / branch fields over the brand-name VehicleLocation.
    city_hint = ""
    for key in (
        "DealerLocatedAtCity", "dealerLocatedAtCity",
        "VehicleLocationName", "VehicleLocationLabel",
        "branchName", "BranchName", "storeName", "StoreName",
        "rooftopName", "dealerLocation", "DealerLocation",
        "location", "Location", "lot",
    ):
        val = str(card.get(key) or "").strip()
        if not val:
            continue
        if group and val.lower() == group.lower():
            continue  # brand name, not a rooftop
        city_hint = val
        break

    if not group:
        vl = str(card.get("VehicleLocation") or "").strip()
        if vl:
            group = vl

    host_group, host_loc = dealership_defaults_for_url(base_url or vdp_url)
    if not group:
        group = host_group

    if city_hint:
        if "/" in city_hint or (group and city_hint.lower().startswith(group.lower())):
            loc = city_hint
        else:
            loc = format_dealer_location(group, city_hint)
    if not loc:
        vdp_city = infer_location_from_vdp(vdp_url)
        # infer_location_from_vdp may return a bare city via format_rooftop_label
        if vdp_city:
            # Re-parse raw city from VDP for branded label
            path = unquote(urlparse(vdp_url).path or "")
            m = re.search(
                r"/(?:new|used|certified)-([A-Za-z][A-Za-z0-9+._ -]*?)-\d{4}-",
                path,
                re.I,
            )
            raw_city = (
                m.group(1).replace("+", " ").replace("_", " ").strip()
                if m else vdp_city
            )
            loc = format_dealer_location(group, raw_city)
    if not loc:
        loc = (fallback_location or "").strip() or host_loc
    if not loc and "universityford" in (base_url or vdp_url or "").lower():
        loc = _DEFAULT_UF_LOT

    return loc, group


def backfill_inventory_rooftops(user_id: int | None = None) -> int:
    """Fill blank location / dealership_group from VDP URLs + host defaults.

    Returns the number of rows updated.  Safe to run on every sync.
    """
    ensure_schema()
    conn = _conn()
    try:
        clauses = [
            "(COALESCE(location,'') = '' OR COALESCE(dealership_group,'') = '')",
            "status = 'ACTIVE'",
        ]
        params: list[Any] = []
        if user_id is not None:
            clauses.append("user_id = ?")
            params.append(user_id)
        rows = conn.execute(
            f"SELECT id, vdp_url, location, dealership_group FROM marketplace_inventory "
            f"WHERE {' AND '.join(clauses)}",
            params,
        ).fetchall()
        updated = 0
        for row_id, vdp, loc, group in rows:
            new_loc, new_group = resolve_vehicle_rooftop(vdp_url=vdp or "")
            final_loc = (loc or "").strip() or new_loc
            final_group = (group or "").strip() or new_group
            # Last-resort default so the Hub Location dropdown always has options.
            if not final_loc:
                if "universityford" in (vdp or "").lower():
                    final_loc = _DEFAULT_UF_LOT
                elif final_group:
                    final_loc = f"{final_group} - Main Lot"
                else:
                    final_loc = "Main Lot"
            if not final_group and "universityford" in (vdp or "").lower():
                final_group = "University Ford"
            if final_loc == (loc or "") and final_group == (group or ""):
                continue
            conn.execute(
                "UPDATE marketplace_inventory "
                "SET location = ?, dealership_group = ? WHERE id = ?",
                (final_loc, final_group, row_id),
            )
            updated += 1
        # Also rewrite legacy "Huntington Location" labels to branded form.
        try:
            conn.execute(
                """
                UPDATE marketplace_inventory
                   SET location = 'University Ford - Huntington'
                 WHERE status = 'ACTIVE'
                   AND (
                        location = 'Huntington Location'
                     OR location = 'Huntington'
                   )
                   AND (
                        lower(COALESCE(dealership_group,'')) LIKE '%university ford%'
                     OR lower(COALESCE(vdp_url,'')) LIKE '%universityford%'
                   )
                """
            )
            # Empty/NULL locations → Main Lot for UF inventory.
            conn.execute(
                """
                UPDATE marketplace_inventory
                   SET location = ?,
                       dealership_group = CASE
                         WHEN COALESCE(dealership_group,'') = ''
                         THEN 'University Ford'
                         ELSE dealership_group END
                 WHERE status = 'ACTIVE'
                   AND (location IS NULL OR trim(location) = '')
                   AND (
                        lower(COALESCE(dealership_group,'')) LIKE '%university ford%'
                     OR lower(COALESCE(vdp_url,'')) LIKE '%universityford%'
                   )
                """,
                (_DEFAULT_UF_LOT,),
            )
        except Exception:
            pass
        conn.commit()
        return updated
    finally:
        conn.close()


def _flag_keys(session_id: str | None = None, user_id: int | str | None = None) -> list[str]:
    keys: list[str] = []
    if session_id:
        keys.append(str(session_id))
    uid = str(user_id) if user_id is not None else (current_user_id() or "")
    if uid:
        keys.append(f"user:{uid}")
    return keys


def set_cancel_sync_requested(
    value: bool = True,
    session_id: str | None = None,
    user_id: int | str | None = None,
) -> None:
    """No-op setter — cancellation is disabled; flags are always cleared."""
    keys = _flag_keys(session_id, user_id)
    if not keys and session_id is None and user_id is None:
        keys = _flag_keys(current_session_id(), current_user_id())
    with _CANCEL_LOCK:
        for k in keys:
            _CANCEL_FLAGS.pop(k, None)


def clear_cancel_flags(session_id: str | None = None, user_id: int | str | None = None) -> None:
    set_cancel_sync_requested(False, session_id=session_id, user_id=user_id)


def clear_all_cancel_flags_for_user(user_id: int | str) -> None:
    """Wipe every in-memory cancel flag for this user (user key + any session keys).

    Used when starting a brand-new sync so leftover Cancel Sync clicks cannot
    abort the next run.
    """
    uid = str(user_id)
    user_key = f"user:{uid}"
    ensure_schema()
    session_ids: list[str] = []
    try:
        conn = _conn()
        try:
            rows = conn.execute(
                "SELECT session_id FROM sync_sessions WHERE user_id = ?",
                (uid,),
            ).fetchall()
            session_ids = [str(r[0]) for r in rows if r and r[0]]
        finally:
            conn.close()
    except Exception:
        session_ids = []
    with _CANCEL_LOCK:
        _CANCEL_FLAGS.pop(user_key, None)
        for sid in session_ids:
            _CANCEL_FLAGS.pop(sid, None)
            _ABORT_LOGGED.discard(sid)


def reset_sync_cancellation(user_id: int | str) -> None:
    """Explicitly set ``cancel_sync_requested = False`` before a new scrape.

    Clears leftover flags and forces any stale running/cancelling DB rows to a
    terminal state so the next ``start_session`` begins on a clean slate.
    """
    uid = str(user_id)
    clear_all_cancel_flags_for_user(uid)
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        conn.execute(
            """
            UPDATE sync_sessions
               SET status = 'completed', updated_at = ?
             WHERE user_id = ?
               AND status IN ('running', 'cancelling')
            """,
            (now, uid),
        )
        conn.commit()
    finally:
        conn.close()
    # Belt-and-suspenders: ensure the user-level flag is off.
    set_cancel_sync_requested(False, user_id=uid)


def bind_session(session_id: str | None, user_id: int | str | None = None) -> None:
    """Attach the active scrape session to this worker thread."""
    _CTX.session_id = session_id or ""
    _CTX.user_id = str(user_id) if user_id is not None else ""


def current_session_id() -> str | None:
    sid = getattr(_CTX, "session_id", "") or ""
    return sid or None


def current_user_id() -> str | None:
    uid = getattr(_CTX, "user_id", "") or ""
    return uid or None


def start_session(user_id: int | str) -> str:
    """Create a new ``running`` sync session and return its ``session_id``.

    Always clears leftover cancellation flags first so a fresh Sync All never
    inherits a prior Cancel Sync click.
    """
    ensure_schema()
    uid = str(user_id)
    # Absolute clean slate before inserting the new running row.
    reset_sync_cancellation(uid)
    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        conn.execute(
            """
            INSERT INTO sync_sessions (session_id, user_id, status, scraped_count, updated_at)
            VALUES (?, ?, 'running', 0, ?)
            """,
            (session_id, uid, now),
        )
        conn.commit()
    finally:
        conn.close()
    # Explicitly force cancel_sync_requested = False for this session + user.
    set_cancel_sync_requested(False, session_id=session_id, user_id=uid)
    clear_cancel_flags(session_id=session_id, user_id=uid)
    bind_session(session_id, uid)
    with _CANCEL_LOCK:
        _ABORT_LOGGED.discard(session_id)
    return session_id


def ensure_session_running(session_id: str | None, user_id: int | str | None = None) -> None:
    """Force DB status back to ``running`` and clear cancel flags (post-init)."""
    sid = session_id or current_session_id()
    if not sid:
        return
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        conn.execute(
            """
            UPDATE sync_sessions
               SET status = 'running', updated_at = ?
             WHERE session_id = ?
            """,
            (now, sid),
        )
        conn.commit()
        row = conn.execute(
            "SELECT user_id FROM sync_sessions WHERE session_id = ?",
            (sid,),
        ).fetchone()
    finally:
        conn.close()
    uid = (row[0] if row else None) or user_id
    set_cancel_sync_requested(False, session_id=sid, user_id=uid)
    clear_cancel_flags(session_id=sid, user_id=uid)


def request_cancel(
    session_id: str | None = None,
    user_id: int | str | None = None,
) -> dict[str, Any]:
    """Mark a session (or the user's active session) as ``cancelling``.

    Returns a small status dict for the HTTP layer.
    """
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        row = None
        if session_id:
            row = conn.execute(
                "SELECT session_id, user_id, status, scraped_count "
                "FROM sync_sessions WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        elif user_id is not None:
            row = conn.execute(
                """
                SELECT session_id, user_id, status, scraped_count
                  FROM sync_sessions
                 WHERE user_id = ?
                   AND status IN ('running', 'cancelling')
                 ORDER BY updated_at DESC
                 LIMIT 1
                """,
                (str(user_id),),
            ).fetchone()

        if not row:
            return {
                "ok": False,
                "error": "No active sync session to cancel.",
                "status": "idle",
            }

        sid, uid, status, count = row[0], row[1], row[2], row[3]
        if status in ("cancelled", "completed"):
            return {
                "ok": True,
                "session_id": sid,
                "user_id": uid,
                "status": status,
                "scraped_count": count,
                "message": f"Sync already {status}.",
            }

        conn.execute(
            """
            UPDATE sync_sessions
               SET status = 'cancelling', updated_at = ?
             WHERE session_id = ?
            """,
            (now, sid),
        )
        conn.commit()
        # In-memory abort flag — workers check this before every HTTP fetch.
        set_cancel_sync_requested(True, session_id=sid, user_id=uid)
        return {
            "ok": True,
            "session_id": sid,
            "user_id": uid,
            "status": "cancelling",
            "scraped_count": count,
            "message": "Cancelling sync…",
            "cancel_sync_requested": True,
        }
    finally:
        conn.close()


def get_status(session_id: str | None) -> str | None:
    if not session_id:
        return None
    ensure_schema()
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT status FROM sync_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def is_cancelling(session_id: str | None = None) -> bool:
    """Cancellation disabled — always False."""
    return False


def should_stop(session_id: str | None = None) -> bool:
    """Cancellation disabled — scrapes always run to completion.

    ``cancel_sync_requested`` is intentionally ignored so leftover cancel
    flags / sync_sessions rows can never abort a sync or surface a fake
    "Sync stopped by user" message.
    """
    return False


def user_cancel_active(session_id: str | None = None) -> bool:
    """Cancellation disabled — always False."""
    return False


def cancel_sync_requested(session_id: str | None = None) -> bool:
    """Cancellation disabled — always False (legacy flag ignored)."""
    return False


def clear_all_sync_sessions_on_startup() -> int:
    """Force every sync_sessions row to ``completed`` on engine boot."""
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        cur = conn.execute(
            """
            UPDATE sync_sessions
               SET status = 'completed', updated_at = ?
             WHERE status IN ('running', 'cancelling', 'cancelled')
            """,
            (now,),
        )
        conn.commit()
        n = cur.rowcount if cur.rowcount is not None else 0
    finally:
        conn.close()
    with _CANCEL_LOCK:
        _CANCEL_FLAGS.clear()
        _ABORT_LOGGED.clear()
    if n:
        print(f"[SCRAPE] Cleared {n} sync_sessions row(s) → completed on startup")
    return n


def _log_abort_once(session_id: str | None) -> None:
    sid = session_id or current_session_id() or ""
    if not sid:
        print("[Scraper] ABORTING SYNC BY USER REQUEST")
        return
    with _CANCEL_LOCK:
        if sid in _ABORT_LOGGED:
            return
        _ABORT_LOGGED.add(sid)
    print("[Scraper] ABORTING SYNC BY USER REQUEST")


def bump_scraped_count(session_id: str | None, delta: int) -> int:
    """Add ``delta`` to scraped_count; return the new total (0 if unknown)."""
    sid = session_id or current_session_id()
    if not sid or delta == 0:
        return 0
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        conn.execute(
            """
            UPDATE sync_sessions
               SET scraped_count = scraped_count + ?,
                   updated_at = ?
             WHERE session_id = ?
            """,
            (int(delta), now, sid),
        )
        conn.commit()
        row = conn.execute(
            "SELECT scraped_count FROM sync_sessions WHERE session_id = ?",
            (sid,),
        ).fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()


def set_scraped_count(session_id: str | None, count: int) -> None:
    sid = session_id or current_session_id()
    if not sid:
        return
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        conn.execute(
            """
            UPDATE sync_sessions
               SET scraped_count = ?, updated_at = ?
             WHERE session_id = ?
            """,
            (int(count), now, sid),
        )
        conn.commit()
    finally:
        conn.close()


def mark_cancelled(session_id: str | None = None, scraped_count: int | None = None) -> None:
    """Finalize a cooperative cancel after the worker breaks its loop."""
    sid = session_id or current_session_id()
    if not sid:
        return
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        if scraped_count is not None:
            conn.execute(
                """
                UPDATE sync_sessions
                   SET status = 'cancelled',
                       scraped_count = ?,
                       updated_at = ?
                 WHERE session_id = ?
                """,
                (int(scraped_count), now, sid),
            )
        else:
            conn.execute(
                """
                UPDATE sync_sessions
                   SET status = 'cancelled', updated_at = ?
                 WHERE session_id = ?
                """,
                (now, sid),
            )
        conn.commit()
        row = conn.execute(
            "SELECT user_id, scraped_count FROM sync_sessions WHERE session_id = ?",
            (sid,),
        ).fetchone()
    finally:
        conn.close()
    uid = row[0] if row else current_user_id() or "?"
    count = scraped_count if scraped_count is not None else (row[1] if row else 0)
    _log_abort_once(sid)
    print(
        f"[Scraper] Session {sid} cancelled by user {uid}. "
        f"Partial inventory saved ({count} vehicles)."
    )
    clear_cancel_flags(session_id=sid, user_id=uid)
    with _CANCEL_LOCK:
        _ABORT_LOGGED.discard(sid)



def mark_completed(session_id: str | None = None, scraped_count: int | None = None) -> None:
    sid = session_id or current_session_id()
    if not sid:
        return
    # Don't overwrite a cooperative cancel that just landed.
    if get_status(sid) == "cancelling" or cancel_sync_requested(sid):
        mark_cancelled(sid, scraped_count)
        return
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        if scraped_count is not None:
            conn.execute(
                """
                UPDATE sync_sessions
                   SET status = 'completed',
                       scraped_count = ?,
                       updated_at = ?
                 WHERE session_id = ?
                """,
                (int(scraped_count), now, sid),
            )
        else:
            conn.execute(
                """
                UPDATE sync_sessions
                   SET status = 'completed', updated_at = ?
                 WHERE session_id = ?
                """,
                (now, sid),
            )
        conn.commit()
    finally:
        conn.close()
    clear_cancel_flags(session_id=sid)
    with _CANCEL_LOCK:
        _ABORT_LOGGED.discard(sid)


def mark_failed(session_id: str | None = None, scraped_count: int | None = None) -> None:
    """Finalize a sync that errored (timeout/network) — NOT a user cancel."""
    sid = session_id or current_session_id()
    if not sid:
        return
    # If the user hit Cancel mid-error, prefer the cancel terminal state.
    if get_status(sid) == "cancelling" or cancel_sync_requested(sid):
        mark_cancelled(sid, scraped_count)
        return
    ensure_schema()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    conn = _conn()
    try:
        if scraped_count is not None:
            conn.execute(
                """
                UPDATE sync_sessions
                   SET status = 'completed',
                       scraped_count = ?,
                       updated_at = ?
                 WHERE session_id = ?
                """,
                (int(scraped_count), now, sid),
            )
        else:
            conn.execute(
                """
                UPDATE sync_sessions
                   SET status = 'completed', updated_at = ?
                 WHERE session_id = ?
                """,
                (now, sid),
            )
        conn.commit()
    finally:
        conn.close()
    clear_cancel_flags(session_id=sid)
    with _CANCEL_LOCK:
        _ABORT_LOGGED.discard(sid)


def active_session_for_user(user_id: int | str) -> dict[str, Any] | None:
    """Return the newest running/cancelling session for a user, if any."""
    ensure_schema()
    conn = _conn()
    try:
        row = conn.execute(
            """
            SELECT session_id, user_id, status, scraped_count, updated_at
              FROM sync_sessions
             WHERE user_id = ?
               AND status IN ('running', 'cancelling')
             ORDER BY updated_at DESC
             LIMIT 1
            """,
            (str(user_id),),
        ).fetchone()
        if not row:
            return None
        return {
            "session_id": row[0],
            "user_id": row[1],
            "status": row[2],
            "scraped_count": row[3],
            "updated_at": row[4],
        }
    finally:
        conn.close()


def session_snapshot(session_id: str | None) -> dict[str, Any] | None:
    if not session_id:
        return None
    ensure_schema()
    conn = _conn()
    try:
        row = conn.execute(
            """
            SELECT session_id, user_id, status, scraped_count, updated_at
              FROM sync_sessions WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "session_id": row[0],
            "user_id": row[1],
            "status": row[2],
            "scraped_count": row[3],
            "updated_at": row[4],
        }
    finally:
        conn.close()


# Alias matching the call site name from the product brief.
def run_inventory_scraper_cancelled(session_id: str | None) -> bool:
    """Return True when ``run_inventory_scraper`` should abort the next batch."""
    return should_stop(session_id)


# ── Multi-location scraper source configs ─────────────────────────────────────

def normalize_inventory_locations(raw: Any) -> list[dict[str, Any]]:
    """Parse/normalize location source configs.

    Shape per entry::
        {
          location_name, inventory_url_new, inventory_url_used,
          csv_enabled (bool), csv_url
        }

    Accepts a JSON string or a Python list. Drops empty rows (no name, URLs,
    or CSV feed).
    """
    if raw is None or raw == "":
        return []
    data = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except Exception:
            return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = str(
            item.get("location_name")
            or item.get("name")
            or item.get("location")
            or ""
        ).strip()
        url_new = str(
            item.get("inventory_url_new")
            or item.get("new_url")
            or item.get("newUrl")
            or ""
        ).strip()
        url_used = str(
            item.get("inventory_url_used")
            or item.get("used_url")
            or item.get("usedUrl")
            or ""
        ).strip()
        csv_url = str(
            item.get("csv_url")
            or item.get("csvUrl")
            or item.get("csv_feed_url")
            or ""
        ).strip()
        raw_enabled = item.get("csv_enabled", item.get("csvEnabled", False))
        if isinstance(raw_enabled, str):
            csv_enabled = raw_enabled.strip().lower() in ("1", "true", "yes", "on")
        else:
            csv_enabled = bool(raw_enabled)
        if not name and not url_new and not url_used and not csv_url and not csv_enabled:
            continue
        out.append({
            "location_name": name or "Main Lot",
            "inventory_url_new": url_new,
            "inventory_url_used": url_used,
            "csv_enabled": csv_enabled,
            "csv_url": csv_url,
        })
    return out


def locations_to_json(locations: list[dict[str, Any]] | Any) -> str:
    return json.dumps(normalize_inventory_locations(locations), ensure_ascii=False)


def resolve_scrape_locations(
    settings: dict[str, Any] | None,
    url_used: str = "",
    url_new: str = "",
) -> list[dict[str, Any]]:
    """Prefer multi-location configs; fall back to legacy single used/new URLs."""
    settings = settings or {}
    locs = normalize_inventory_locations(settings.get("inventory_locations"))
    if locs:
        return locs
    used = (url_used or settings.get("inventory_url_used") or "").strip()
    new = (url_new or settings.get("inventory_url_new") or "").strip()
    if not used and not new:
        return []
    dealer = (settings.get("dealer_name") or "").strip()
    return [{
        "location_name": dealer or "Main Lot",
        "inventory_url_new": new,
        "inventory_url_used": used,
        "csv_enabled": False,
        "csv_url": "",
    }]


def stamp_vehicle_location(vehicles: list[dict], location_name: str) -> list[dict]:
    """Force-inject ``location = location_name`` on every vehicle before DB write."""
    name = (location_name or "").strip()
    if not name:
        return vehicles
    for v in vehicles:
        if not isinstance(v, dict):
            continue
        v["location"] = name
    return vehicles
