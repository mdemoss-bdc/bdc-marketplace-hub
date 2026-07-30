"""
marketplace_engine.py — Facebook Marketplace publisher engine

Owns the `marketplace_queue` table and its lifecycle:
  - Schema init + demo queue seeded from real scraped inventory
  - Daily quota accounting (10 posts/day cap)
  - Posting-window validation (08:00–21:00 local)
  - AI listing copy generation (template engine, OpenAI-polished when keyed)
  - Scheduling and instant manual publish override

Standalone by design: no imports from bdc_engine, so it can be unit tested or
driven from a script. Every public function takes an optional ``db_path``.

Backs these endpoints:
  GET  /api/marketplace/queue
  POST /api/marketplace/generate-copy
  POST /api/marketplace/schedule
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DB = os.path.join(_HERE, "bdc_production.db")

# ── Safety rails ──────────────────────────────────────────────────────────
DAILY_POST_CAP = 10          # hard ceiling on posts per calendar day
WINDOW_START_HOUR = 8        # 08:00 — earliest allowed publish time
WINDOW_END_HOUR = 21         # 21:00 — latest allowed publish time

VALID_STATUSES = ("scheduled", "posted", "failed", "paused")

DEALER_NAME = os.environ.get("DEALER_NAME", "Moses Auto Group")
DEALER_CITY = os.environ.get("DEALER_CITY", "Huntington, WV")
DEALER_PHONE = os.environ.get("DEALER_PHONE", "(304) 555-0100")

# Host → (dealer_name, location) defaults derived from the configured inventory URL.
# Used when settings.dealer_name / dealer_city are blank so Marketplace copy never
# falls back to a different rooftop's branding.
_HOST_DEALER_DEFAULTS: dict[str, tuple[str, str]] = {
    "universityfordwv.com": ("University Ford", "St. Albans / WV"),
    "mosescars.com": ("Moses Auto Group", "Huntington, WV"),
}


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _db_path() -> str:
    return os.environ.get("SQLITE_PATH") or _DEFAULT_DB


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or _db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_QUEUE_DDL = """
CREATE TABLE IF NOT EXISTS marketplace_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    vin             TEXT    NOT NULL,
    stock_number    TEXT    NOT NULL DEFAULT '',
    year            INTEGER NOT NULL DEFAULT 0,
    make            TEXT    NOT NULL DEFAULT '',
    model           TEXT    NOT NULL DEFAULT '',
    trim            TEXT    NOT NULL DEFAULT '',
    price           INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'scheduled'
                    CHECK(status IN ('scheduled','posted','failed','paused')),
    scheduled_time  TEXT             DEFAULT NULL,
    posted_at       TEXT             DEFAULT NULL,
    ai_description  TEXT    NOT NULL DEFAULT '',
    error_message   TEXT    NOT NULL DEFAULT '',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    is_demo         INTEGER NOT NULL DEFAULT 0
)
"""

_QUEUE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_mq_status ON marketplace_queue(status)",
    "CREATE INDEX IF NOT EXISTS idx_mq_posted_at ON marketplace_queue(posted_at)",
]


# ---------------------------------------------------------------------------
# Inventory lookup
# ---------------------------------------------------------------------------

_INV_COLUMNS = (
    "user_id, vin, stock_number, condition, year, make, model, trim, "
    "mileage, price, exterior_color, interior_color, status, "
    "location, vdp_url"
)


def get_vehicle(vin: str, db_path: str | None = None) -> dict | None:
    """Fetch a vehicle from scraped inventory by VIN."""
    if not vin:
        return None
    conn = _connect(db_path)
    try:
        row = conn.execute(
            f"SELECT {_INV_COLUMNS} FROM marketplace_inventory WHERE vin = ? LIMIT 1",
            (vin.strip().upper(),),
        ).fetchone()
    except sqlite3.OperationalError:
        # Older DBs may lack location/vdp_url — retry with the core columns.
        try:
            row = conn.execute(
                "SELECT user_id, vin, stock_number, condition, year, make, model, "
                "trim, mileage, price, exterior_color, interior_color, status "
                "FROM marketplace_inventory WHERE vin = ? LIMIT 1",
                (vin.strip().upper(),),
            ).fetchone()
        except sqlite3.OperationalError:
            return None
    finally:
        conn.close()
    return dict(row) if row else None


def _host_from_url(url: str) -> str:
    if not url:
        return ""
    try:
        from urllib.parse import urlparse
        netloc = urlparse(url.strip()).netloc.lower()
    except Exception:
        return ""
    netloc = netloc.split("@")[-1].split(":")[0]
    if netloc.startswith("www."):
        netloc = netloc[4:]
    return netloc


def _registrable_host(host: str) -> str:
    parts = [p for p in host.split(".") if p]
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return host


def resolve_dealer_branding(
    vehicle: dict | None = None,
    db_path: str | None = None,
) -> dict[str, str]:
    """Resolve dealership name / location / phone for Marketplace listing copy.

    Priority:
      1. Active account settings (dealer_name, dealer_city/state, dealer_phone)
      2. Host defaults from the configured inventory URL (or vehicle vdp_url)
         — e.g. universityfordwv.com → University Ford in St. Albans / WV
      3. Environment / module constants (legacy Moses defaults)
    """
    name = ""
    city = ""
    state = ""
    phone = ""
    urls: list[str] = []

    uid = _int((vehicle or {}).get("user_id"), 0)
    conn = _connect(db_path)
    try:
        row = None
        if uid:
            row = conn.execute(
                "SELECT dealer_name, dealer_city, dealer_state, dealer_phone, "
                "inventory_url_used, inventory_url_new "
                "FROM users WHERE id = ?",
                (uid,),
            ).fetchone()
        if row is None:
            # Same fallback the Hub uses: lowest-id / local account.
            row = conn.execute(
                "SELECT dealer_name, dealer_city, dealer_state, dealer_phone, "
                "inventory_url_used, inventory_url_new "
                "FROM users ORDER BY id LIMIT 1"
            ).fetchone()
        if row:
            name = str(row["dealer_name"] or "").strip()
            city = str(row["dealer_city"] or "").strip()
            state = str(row["dealer_state"] or "").strip()
            phone = str(row["dealer_phone"] or "").strip()
            urls = [
                str(row["inventory_url_used"] or "").strip(),
                str(row["inventory_url_new"] or "").strip(),
            ]
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()

    if vehicle:
        urls.append(str(vehicle.get("vdp_url") or "").strip())

    host_default_name = ""
    host_default_loc = ""
    for url in urls:
        host = _registrable_host(_host_from_url(url))
        if host in _HOST_DEALER_DEFAULTS:
            host_default_name, host_default_loc = _HOST_DEALER_DEFAULTS[host]
            break

    # Prefer a vehicle rooftop location when settings city is blank.
    vehicle_loc = str((vehicle or {}).get("location") or "").strip()

    if not name:
        name = host_default_name or DEALER_NAME

    if city and state:
        location = f"{city}, {state}"
    elif city:
        location = city
    elif host_default_loc:
        location = host_default_loc
    elif vehicle_loc:
        location = vehicle_loc
    else:
        location = DEALER_CITY

    if not phone:
        phone = DEALER_PHONE

    return {
        "dealer_name": name,
        "dealer_location": location,
        "dealer_phone": phone,
    }


def _pick_seed_vehicles(conn: sqlite3.Connection, count: int) -> list[dict]:
    """Choose real inventory rows for the demo queue.

    Prefers fully-enriched rows (non-zero price) so the seeded listings read
    realistically; falls back to any ACTIVE row when enrichment is pending.
    """
    try:
        rows = conn.execute(
            f"SELECT {_INV_COLUMNS} FROM marketplace_inventory "
            "WHERE status='ACTIVE' AND price > 0 ORDER BY last_seen DESC LIMIT ?",
            (count,),
        ).fetchall()
        if len(rows) < count:
            rows = conn.execute(
                f"SELECT {_INV_COLUMNS} FROM marketplace_inventory "
                "WHERE status='ACTIVE' ORDER BY last_seen DESC LIMIT ?",
                (count,),
            ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Posting window
# ---------------------------------------------------------------------------

def _to_local(dt: datetime) -> datetime:
    """Convert to the server's local timezone.

    The posting window is dealership wall-clock time, so every hour comparison
    happens in local time even though timestamps persist as UTC.
    """
    return dt.astimezone()


def in_posting_window(dt: datetime) -> bool:
    return WINDOW_START_HOUR <= _to_local(dt).hour < WINDOW_END_HOUR


def _clamp_to_window(dt: datetime) -> datetime:
    """Move a timestamp to the next valid 08:00–21:00 local posting slot."""
    local = _to_local(dt)
    if local.hour < WINDOW_START_HOUR:
        local = local.replace(hour=WINDOW_START_HOUR, minute=15, second=0, microsecond=0)
    elif local.hour >= WINDOW_END_HOUR:
        local = (local + timedelta(days=1)).replace(
            hour=WINDOW_START_HOUR, minute=15, second=0, microsecond=0
        )
    else:
        local = local.replace(second=0, microsecond=0)
    return local.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Quota
# ---------------------------------------------------------------------------

def _posts_today(conn: sqlite3.Connection, now: datetime | None = None) -> int:
    now = now or _now()
    day = now.strftime("%Y-%m-%d")
    row = conn.execute(
        "SELECT COUNT(*) FROM marketplace_queue "
        "WHERE status = 'posted' AND posted_at IS NOT NULL "
        "AND substr(posted_at, 1, 10) = ?",
        (day,),
    ).fetchone()
    return int(row[0]) if row else 0


def _quota_payload(used: int) -> dict:
    remaining = max(0, DAILY_POST_CAP - used)
    return {
        "posts_today": used,
        "daily_cap": DAILY_POST_CAP,
        "remaining": remaining,
        "cap_reached": used >= DAILY_POST_CAP,
        "label": f"{used} / {DAILY_POST_CAP} posts today",
        "window": f"{WINDOW_START_HOUR:02d}:00 - {WINDOW_END_HOUR:02d}:00",
    }


def get_quota(db_path: str | None = None) -> dict:
    conn = _connect(db_path)
    try:
        return _quota_payload(_posts_today(conn))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------

def init_marketplace_schema(db_path: str | None = None) -> None:
    """Create the queue table and refresh the demo queue.

    Demo rows are re-seeded on each startup so their scheduled times stay
    relative to boot. Any operator-created row (is_demo = 0) disables seeding so
    real work is never destroyed.
    """
    conn = _connect(db_path)
    try:
        with conn:
            conn.execute(_QUEUE_DDL)
            for stmt in _QUEUE_INDEXES:
                conn.execute(stmt)

            real_rows = conn.execute(
                "SELECT COUNT(*) FROM marketplace_queue WHERE is_demo = 0"
            ).fetchone()[0]
            if real_rows:
                print("[MARKETPLACE] Operator queue rows present — demo seed skipped.")
                return

            vehicles = _pick_seed_vehicles(conn, 3)
            if not vehicles:
                print("[MARKETPLACE] No scraped inventory available — demo seed skipped.")
                return

            conn.execute("DELETE FROM marketplace_queue WHERE is_demo = 1")

            now = _now()
            # 1 already posted earlier today, 2 upcoming inside the window.
            plan: list[tuple[str, datetime | None, datetime | None]] = [
                ("posted",    None,                            _clamp_to_window(now - timedelta(hours=3))),
                ("scheduled", _clamp_to_window(now + timedelta(minutes=90)),  None),
                ("scheduled", _clamp_to_window(now + timedelta(minutes=240)), None),
            ]

            for vehicle, (status, sched, posted) in zip(vehicles, plan):
                conn.execute(
                    """INSERT INTO marketplace_queue
                           (vin, stock_number, year, make, model, trim, price,
                            status, scheduled_time, posted_at, ai_description, is_demo)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                    (
                        vehicle["vin"],
                        vehicle.get("stock_number") or "",
                        _int(vehicle.get("year")),
                        vehicle.get("make") or "",
                        vehicle.get("model") or "",
                        vehicle.get("trim") or "",
                        _int(vehicle.get("price")),
                        status,
                        _iso(sched) if sched else None,
                        _iso(posted) if posted else None,
                        _build_description(vehicle),
                    ),
                )
    finally:
        conn.close()
    print("[MARKETPLACE] Queue ready — 3 demo listings seeded "
          "(1 posted today, 2 scheduled in window).")


# ---------------------------------------------------------------------------
# Listing copy generation
# ---------------------------------------------------------------------------

def _vehicle_title(v: dict) -> str:
    parts = [str(_int(v.get("year")) or ""), v.get("make", ""), v.get("model", ""), v.get("trim", "")]
    return " ".join(p for p in parts if p).strip() or "Vehicle"


def _build_description(v: dict, branding: dict | None = None, db_path: str | None = None) -> str:
    """Deterministic Facebook Marketplace listing body.

    Leads with the headline specs buyers filter on, then condition, then the
    BDC contact instruction Marketplace shoppers respond to. Dealership name
    and location come from active settings / inventory-URL host defaults —
    never hardcode a different rooftop.
    """
    brand = branding or resolve_dealer_branding(v, db_path)
    dealer_name = brand["dealer_name"]
    dealer_location = brand["dealer_location"]
    dealer_phone = brand["dealer_phone"]

    title = _vehicle_title(v)
    price = _int(v.get("price"))
    mileage = _int(v.get("mileage"))
    condition = (v.get("condition") or "Used").strip() or "Used"
    ext = (v.get("exterior_color") or "").strip()
    inter = (v.get("interior_color") or "").strip()
    stock = (v.get("stock_number") or "").strip()

    lines: list[str] = []
    headline = f"{title} — {dealer_name}"
    if price > 0:
        headline = f"{title} | ${price:,}"
    lines.append(headline)
    lines.append("")

    specs = [f"Condition: {condition}"]
    if mileage > 0:
        specs.append(f"Mileage: {mileage:,} miles")
    if price > 0:
        specs.append(f"Price: ${price:,}")
    else:
        specs.append("Price: Call for our best price")
    if ext:
        specs.append(f"Exterior: {ext}")
    if inter:
        specs.append(f"Interior: {inter}")
    if stock:
        specs.append(f"Stock #: {stock}")
    specs.append(f"VIN: {v.get('vin', '')}")
    lines.extend(f"- {s}" for s in specs)
    lines.append("")

    body = (
        f"This {condition.lower()} {title} is on the lot now at {dealer_name} "
        f"in {dealer_location}. Fully inspected and ready to drive home today. "
        "Financing is available for all credit tiers, and we accept trade-ins — "
        "we will appraise yours while you are here."
    )
    lines.append(body)
    lines.append("")

    lines.append("HOW TO CLAIM THIS VEHICLE:")
    lines.append("1. Message us here on Marketplace with your name and best callback number.")
    lines.append(f"2. Or text/call our BDC team direct at {dealer_phone}.")
    lines.append("3. Ask about scheduling a test drive — same-day appointments available.")
    lines.append("")
    lines.append("Serious inquiries get a response within 15 minutes during business hours.")

    return "\n".join(lines)


def _polish_with_openai(draft: str, v: dict, branding: dict | None = None) -> tuple[str, str]:
    """Optionally rewrite the draft via OpenAI. Returns (text, source)."""
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        return draft, "template"

    brand = branding or {}
    dealer_hint = ""
    if brand.get("dealer_name"):
        dealer_hint = (
            f"Keep the dealership as \"{brand['dealer_name']}\" in "
            f"\"{brand.get('dealer_location', '')}\". "
            "Do not substitute a different dealer name or city.\n\n"
        )

    prompt = (
        "You are an expert automotive Facebook Marketplace copywriter. Rewrite the "
        "listing below so it is scannable and high-converting. Keep every factual "
        "detail (price, mileage, VIN, stock number, phone number, dealership name, "
        "and location) exactly as given. "
        "Keep the specs as a short bulleted list, keep the numbered contact "
        "instructions at the end, and stay under 300 words. Return only the listing "
        "text with no markdown fences.\n\n"
        f"{dealer_hint}"
        f"Vehicle: {_vehicle_title(v)}\n\n"
        f"Listing:\n{draft}"
    )
    body = json.dumps({
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 600,
        "temperature": 0.7,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read())
        text = data["choices"][0]["message"]["content"].strip()
        text = re.sub(r"^```[a-zA-Z]*\n?|```$", "", text).strip()
        if len(text) > 120:
            return text, "openai"
    except Exception as exc:
        print(f"[MARKETPLACE] OpenAI polish failed ({exc}) — using template copy.")
    return draft, "template"


def generate_copy(vin: str, db_path: str | None = None) -> dict:
    """Build a Marketplace-optimized listing description for a VIN."""
    vin = (vin or "").strip().upper()
    if not vin:
        raise ValueError("vin is required")

    vehicle = get_vehicle(vin, db_path)
    if not vehicle:
        raise LookupError(f"VIN {vin} not found in inventory")

    branding = resolve_dealer_branding(vehicle, db_path)
    draft = _build_description(vehicle, branding=branding, db_path=db_path)
    text, source = _polish_with_openai(draft, vehicle, branding=branding)

    return {
        "vin": vin,
        "vehicle": vehicle,
        "title": _vehicle_title(vehicle),
        "ai_description": text,
        "source": source,
        "character_count": len(text),
        "dealer_name": branding["dealer_name"],
        "dealer_location": branding["dealer_location"],
    }


# ---------------------------------------------------------------------------
# Queue reads
# ---------------------------------------------------------------------------

def _row_to_item(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["vehicle_title"] = " ".join(
        p for p in [str(item.get("year") or ""), item.get("make", ""),
                    item.get("model", ""), item.get("trim", "")] if p
    ).strip()
    sched = _parse_iso(item.get("scheduled_time"))
    posted = _parse_iso(item.get("posted_at"))
    item["in_window"] = in_posting_window(sched) if sched else None
    item["scheduled_local"] = _to_local(sched).strftime("%a %I:%M %p") if sched else None
    item["posted_local"] = _to_local(posted).strftime("%a %I:%M %p") if posted else None
    if sched and item["status"] == "scheduled":
        mins = (sched - _now()).total_seconds() / 60
        item["minutes_until_post"] = round(mins, 1)
        item["overdue"] = mins < 0
    else:
        item["minutes_until_post"] = None
        item["overdue"] = False
    return item


def get_queue(status: str | None = None, db_path: str | None = None) -> dict:
    """Return queue items plus daily quota usage."""
    conn = _connect(db_path)
    try:
        params: list[Any] = []
        where = ""
        if status:
            if status not in VALID_STATUSES:
                raise ValueError(f"status must be one of {list(VALID_STATUSES)}")
            where = "WHERE status = ?"
            params.append(status)
        rows = conn.execute(
            "SELECT * FROM marketplace_queue "
            f"{where} "
            "ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'failed' THEN 1 "
            "WHEN 'paused' THEN 2 ELSE 3 END, "
            "COALESCE(scheduled_time, posted_at, created_at) ASC",
            params,
        ).fetchall()
        items = [_row_to_item(r) for r in rows]
        quota = _quota_payload(_posts_today(conn))
    finally:
        conn.close()

    counts = {s: 0 for s in VALID_STATUSES}
    for item in items:
        counts[item["status"]] = counts.get(item["status"], 0) + 1

    return {
        "items": items,
        "total": len(items),
        "counts": counts,
        "quota": quota,
    }


# ---------------------------------------------------------------------------
# Scheduling / publishing
# ---------------------------------------------------------------------------

def schedule_vehicle(
    vin: str,
    scheduled_time: str | None = None,
    publish_now: bool = False,
    ai_description: str | None = None,
    db_path: str | None = None,
) -> dict:
    """Queue a vehicle for posting, or publish it immediately.

    ``publish_now`` is the manual override: it marks the row posted right away,
    bypassing the scheduled time but still respecting the daily cap.
    """
    vin = (vin or "").strip().upper()
    if not vin:
        raise ValueError("vin is required")

    vehicle = get_vehicle(vin, db_path)
    if not vehicle:
        raise LookupError(f"VIN {vin} not found in inventory")

    now = _now()

    # Resolve the target slot before touching the DB.
    if publish_now:
        slot = now
    elif scheduled_time:
        parsed = _parse_iso(scheduled_time)
        if not parsed:
            raise ValueError("scheduled_time must be ISO-8601, e.g. 2026-07-29T14:30:00Z")
        if not in_posting_window(parsed):
            raise ValueError(
                f"scheduled_time {_to_local(parsed).strftime('%I:%M %p')} local is "
                f"outside the {WINDOW_START_HOUR:02d}:00-{WINDOW_END_HOUR:02d}:00 "
                "posting window"
            )
        slot = parsed.replace(second=0, microsecond=0)
    else:
        slot = _clamp_to_window(now + timedelta(minutes=45))

    description = (
        ai_description
        if ai_description is not None
        else _build_description(vehicle, branding=resolve_dealer_branding(vehicle, db_path), db_path=db_path)
    )

    conn = _connect(db_path)
    try:
        used = _posts_today(conn)
        if publish_now and used >= DAILY_POST_CAP:
            raise PermissionError(
                f"Daily cap reached ({used}/{DAILY_POST_CAP}) — cannot publish now."
            )

        with conn:
            existing = conn.execute(
                "SELECT id FROM marketplace_queue WHERE vin = ? "
                "AND status IN ('scheduled','paused') ORDER BY id DESC LIMIT 1",
                (vin,),
            ).fetchone()

            if publish_now:
                fields = ("posted", None, _iso(now))
            else:
                fields = ("scheduled", _iso(slot), None)

            if existing:
                conn.execute(
                    "UPDATE marketplace_queue SET status=?, scheduled_time=?, "
                    "posted_at=?, ai_description=?, error_message='' WHERE id=?",
                    (*fields, description, existing["id"]),
                )
                row_id = int(existing["id"])
                action = "updated"
            else:
                cur = conn.execute(
                    """INSERT INTO marketplace_queue
                           (vin, stock_number, year, make, model, trim, price,
                            status, scheduled_time, posted_at, ai_description, is_demo)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                    (
                        vin,
                        vehicle.get("stock_number") or "",
                        _int(vehicle.get("year")),
                        vehicle.get("make") or "",
                        vehicle.get("model") or "",
                        vehicle.get("trim") or "",
                        _int(vehicle.get("price")),
                        *fields,
                        description,
                    ),
                )
                row_id = int(cur.lastrowid or 0)
                action = "published" if publish_now else "scheduled"

        row = conn.execute(
            "SELECT * FROM marketplace_queue WHERE id = ?", (row_id,)
        ).fetchone()
        quota = _quota_payload(_posts_today(conn))
    finally:
        conn.close()

    return {
        "status": "ok",
        "action": action,
        "item": _row_to_item(row) if row else None,
        "quota": quota,
    }


def set_status(
    item_id: int,
    status: str,
    error_message: str = "",
    db_path: str | None = None,
) -> dict:
    """Update a queue row's status (used for pause/resume and failure logging)."""
    if status not in VALID_STATUSES:
        raise ValueError(f"status must be one of {list(VALID_STATUSES)}")

    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT id FROM marketplace_queue WHERE id = ?", (item_id,)
        ).fetchone()
        if not row:
            raise LookupError(f"Queue item {item_id} not found")

        posted_at = _iso(_now()) if status == "posted" else None
        with conn:
            if status == "posted":
                conn.execute(
                    "UPDATE marketplace_queue SET status=?, posted_at=?, "
                    "error_message='' WHERE id=?",
                    (status, posted_at, item_id),
                )
            else:
                conn.execute(
                    "UPDATE marketplace_queue SET status=?, error_message=? WHERE id=?",
                    (status, error_message, item_id),
                )
        updated = conn.execute(
            "SELECT * FROM marketplace_queue WHERE id = ?", (item_id,)
        ).fetchone()
        quota = _quota_payload(_posts_today(conn))
    finally:
        conn.close()

    return {"status": "ok", "item": _row_to_item(updated), "quota": quota}
