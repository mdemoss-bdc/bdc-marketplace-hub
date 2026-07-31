"""
leads_engine.py — BDC Lead Engine

Handles the `leads` table lifecycle:
  - Schema init + realistic seed data
  - SLA flag calculation (>15 min without a logged action)
  - Action logging (call / text / email attempt, resets SLA timer)
  - AI SMS reply generation (template engine; OpenAI polished when available)

All public functions accept an optional ``db_path`` kwarg so they can be
called from tests or from a different DB without touching the global env.
"""

from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timezone, timedelta
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DB = os.path.join(_HERE, "bdc_production.db")

SLA_MINUTES = 15  # flag lead as unanswered if no action within this window

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _db_path() -> str:
    return os.environ.get("SQLITE_PATH") or _DEFAULT_DB


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or _db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_LEADS_DDL = """
CREATE TABLE IF NOT EXISTS leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name    TEXT    NOT NULL DEFAULT '',
    phone            TEXT    NOT NULL DEFAULT '',
    email            TEXT    NOT NULL DEFAULT '',
    requested_vin    TEXT    NOT NULL DEFAULT '',
    vehicle_interest TEXT    NOT NULL DEFAULT '',
    source           TEXT    NOT NULL DEFAULT 'Web Form'
                     CHECK(source IN ('Facebook','Web Form','Phone','Email','Walk-In')),
    status           TEXT    NOT NULL DEFAULT 'New'
                     CHECK(status IN ('New','Contacted','Scheduled','Closed','Lost')),
    notes            TEXT    NOT NULL DEFAULT '',
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_action_at   TEXT             DEFAULT NULL,
    is_demo          INTEGER NOT NULL DEFAULT 0
)
"""

# Columns added after the first release — applied via ALTER for existing DBs.
_LEADS_MIGRATIONS = [
    "ALTER TABLE leads ADD COLUMN vehicle_interest TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE leads ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0",
]

_LEAD_ACTIONS_DDL = """
CREATE TABLE IF NOT EXISTS lead_actions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    action_type TEXT    NOT NULL DEFAULT 'call'
                CHECK(action_type IN ('call','text','email','note','appointment')),
    note        TEXT    NOT NULL DEFAULT '',
    actor       TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)
"""

# ---------------------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------------------

# Timestamps are stored as offsets from boot so the demo board always shows the
# same mix of SLA states: 2 fresh New leads inside the window, 1 breached, and
# 1 already Scheduled (SLA does not apply).
#   created_min_ago      — how long ago the lead arrived
#   last_action_min_ago  — None means nobody has touched it yet
_SEED_LEADS = [
    {
        "customer_name": "Brandon Simmons",
        "phone": "+13045550182",
        "email": "bsimmons@email.com",
        "requested_vin": "WAUF2AFC5PN019843",
        "vehicle_interest": "2023 Audi A6 Premium Plus",
        "source": "Web Form",
        "status": "New",
        "notes": "Submitted form asking about Prestige trim availability. Budget around $65k.",
        "created_min_ago": 4,
        "last_action_min_ago": None,     # ~11 min left on the clock
    },
    {
        "customer_name": "Keisha Morris",
        "phone": "+13045550347",
        "email": "keisha.morris@gmail.com",
        "requested_vin": "1FTFW1ED5PKD10052",
        "vehicle_interest": "2024 Ford F-150 Lariat",
        "source": "Facebook",
        "status": "New",
        "notes": "FB Marketplace DM: 'Is the F-150 Lariat still available? Can I get an OTD price?'",
        "created_min_ago": 9,
        "last_action_min_ago": None,     # ~6 min left — amber warning state
    },
    {
        "customer_name": "Derek Fontaine",
        "phone": "+13045550509",
        "email": "dfontaine@outlook.com",
        "requested_vin": "WAUF2AFC5PN019843",
        "vehicle_interest": "2023 Audi A6 Premium Plus",
        "source": "Phone",
        "status": "Contacted",
        "notes": "Called in, left VM. Wants lease vs finance comparison before coming in.",
        "created_min_ago": 95,
        "last_action_min_ago": 24,       # BREACHED — 9 min past the 15 min SLA
    },
    {
        "customer_name": "Maria Salinas",
        "phone": "+13045550764",
        "email": "mariasalinas92@yahoo.com",
        "requested_vin": "1FTFW1ED5PKD10052",
        "vehicle_interest": "2024 Ford F-150 XLT PowerBoost",
        "source": "Web Form",
        "status": "Scheduled",
        "notes": "Test drive booked Saturday 11am. Pre-qualified up to $58k.",
        "created_min_ago": 2880,         # 2 days ago
        "last_action_min_ago": 45,       # Scheduled leads are exempt from SLA
    },
]


def init_leads_schema(db_path: str | None = None) -> None:
    """Create tables, apply migrations, and refresh the demo lead board.

    Demo rows are re-seeded on every startup so their SLA timers stay relative
    to boot time. Real data is never touched: if any non-demo lead exists, or if
    any action has been logged, seeding is skipped entirely.
    """
    conn = _connect(db_path)
    with conn:
        conn.execute(_LEADS_DDL)
        conn.execute(_LEAD_ACTIONS_DDL)

        for stmt in _LEADS_MIGRATIONS:
            try:
                conn.execute(stmt)
            except sqlite3.OperationalError:
                pass  # column already present

        real_leads = conn.execute(
            "SELECT COUNT(*) FROM leads WHERE is_demo = 0"
        ).fetchone()[0]
        logged_actions = conn.execute("SELECT COUNT(*) FROM lead_actions").fetchone()[0]
        if real_leads or logged_actions:
            print("[LEADS] Existing lead data found — demo seed skipped.")
            return

        conn.execute("DELETE FROM leads WHERE is_demo = 1")

        now = datetime.now(timezone.utc)

        def _offset(minutes: int | None) -> str | None:
            if minutes is None:
                return None
            return (now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

        for row in _SEED_LEADS:
            conn.execute(
                """INSERT INTO leads
                       (customer_name, phone, email, requested_vin, vehicle_interest,
                        source, status, notes, created_at, last_action_at, is_demo)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    row["customer_name"],
                    row["phone"],
                    row["email"],
                    row["requested_vin"],
                    row["vehicle_interest"],
                    row["source"],
                    row["status"],
                    row["notes"],
                    _offset(row["created_min_ago"]),
                    _offset(row["last_action_min_ago"]),
                ),
            )
    conn.close()
    print(f"[LEADS] Schema ready — {len(_SEED_LEADS)} demo leads seeded "
          f"(2 New, 1 SLA breached, 1 Scheduled).")


# ---------------------------------------------------------------------------
# SLA helpers
# ---------------------------------------------------------------------------

def _sla_flag(lead_row: sqlite3.Row) -> bool:
    """Return True if the lead has been waiting >SLA_MINUTES without any action."""
    if lead_row["status"] in ("Scheduled", "Closed", "Lost"):
        return False
    ref_iso = lead_row["last_action_at"] or lead_row["created_at"]
    if not ref_iso:
        return True
    try:
        ref_dt = datetime.fromisoformat(ref_iso.replace("Z", "+00:00"))
        age_mins = (datetime.now(timezone.utc) - ref_dt).total_seconds() / 60
        return age_mins > SLA_MINUTES
    except ValueError:
        return False


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["is_unanswered_sla"] = _sla_flag(row)
    # minutes since last touch for the frontend countdown
    ref_iso = row["last_action_at"] or row["created_at"]
    try:
        ref_dt = datetime.fromisoformat(ref_iso.replace("Z", "+00:00"))
        d["minutes_since_action"] = round(
            (datetime.now(timezone.utc) - ref_dt).total_seconds() / 60, 1
        )
    except (ValueError, AttributeError):
        d["minutes_since_action"] = None
    return d


# ---------------------------------------------------------------------------
# Public read API
# ---------------------------------------------------------------------------

def get_leads(
    status: str | None = None,
    source: str | None = None,
    sla_only: bool = False,
    db_path: str | None = None,
) -> list[dict]:
    try:
        conn = _connect(db_path)
    except Exception as exc:
        print(f"[LEADS] connect failed — empty list: {exc}")
        return []
    try:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status = ?")
            params.append(status)
        if source:
            clauses.append("source = ?")
            params.append(source)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            f"SELECT * FROM leads {where} ORDER BY created_at DESC", params
        ).fetchall()
        result = [_row_to_dict(r) for r in rows]
        if sla_only:
            result = [r for r in result if r["is_unanswered_sla"]]
        return result
    except sqlite3.OperationalError as exc:
        # Missing table / schema — Lead Center should show an empty board, not 500.
        print(f"[LEADS] query failed — empty list: {exc}")
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


def get_lead(lead_id: int, db_path: str | None = None) -> dict | None:
    conn = _connect(db_path)
    row = conn.execute("SELECT * FROM leads WHERE id = ?", (lead_id,)).fetchone()
    conn.close()
    return _row_to_dict(row) if row else None


# ---------------------------------------------------------------------------
# Log action
# ---------------------------------------------------------------------------

def log_action(
    lead_id: int,
    action_type: str = "call",
    note: str = "",
    actor: str = "",
    new_status: str | None = None,
    db_path: str | None = None,
) -> dict:
    """Record a contact attempt, reset the SLA timer, optionally update status."""
    valid_types = {"call", "text", "email", "note", "appointment"}
    if action_type not in valid_types:
        raise ValueError(f"action_type must be one of {sorted(valid_types)}")

    valid_statuses = {"New", "Contacted", "Scheduled", "Closed", "Lost"}
    if new_status and new_status not in valid_statuses:
        raise ValueError(f"status must be one of {sorted(valid_statuses)}")

    conn = _connect(db_path)
    lead = conn.execute("SELECT id FROM leads WHERE id = ?", (lead_id,)).fetchone()
    if not lead:
        conn.close()
        raise ValueError(f"Lead {lead_id} not found")

    now = _now_iso()
    with conn:
        conn.execute(
            """INSERT INTO lead_actions (lead_id, action_type, note, actor, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (lead_id, action_type, note, actor, now),
        )
        if new_status:
            conn.execute(
                "UPDATE leads SET last_action_at = ?, status = ? WHERE id = ?",
                (now, new_status, lead_id),
            )
        else:
            # Promote 'New' → 'Contacted' automatically on first contact
            conn.execute(
                "UPDATE leads SET last_action_at = ?, "
                "status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END "
                "WHERE id = ?",
                (now, lead_id),
            )

    updated = get_lead(lead_id, db_path)
    conn.close()
    return {
        "status": "ok",
        "lead_id": lead_id,
        "action_type": action_type,
        "logged_at": now,
        "lead": updated,
    }


# ---------------------------------------------------------------------------
# AI SMS reply generator
# ---------------------------------------------------------------------------

# Inventory lookup — reuse the same DB the rest of the engine uses
def _lookup_vehicle(vin: str, db_path: str | None = None) -> dict | None:
    if not vin:
        return None
    conn = _connect(db_path)
    row = conn.execute(
        "SELECT year, make, model, trim, price, status FROM marketplace_inventory WHERE vin = ? LIMIT 1",
        (vin,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def _vehicle_label(v: dict | None, fallback: str = "") -> str:
    """Prefer the live inventory record; fall back to the lead's stored label."""
    if not v:
        return fallback or "the vehicle you inquired about"
    parts = [str(v.get("year", "")), v.get("make", ""), v.get("model", ""), v.get("trim", "")]
    label = " ".join(p for p in parts if p).strip() or fallback or "the vehicle"
    if v.get("price"):
        label += f" (${int(v['price']):,})"
    return label


def _availability_line(v: dict | None) -> str:
    if not v:
        return "It's still available"
    status = (v.get("status") or "ACTIVE").upper()
    if status == "ACTIVE":
        return "Great news — it's still available on the lot"
    if status == "PENDING":
        return "That one is currently pending a deal, but we have similar options"
    return "We may have moved that unit, but we have comparable options available"


_SMS_TEMPLATES = [
    # Concise / high-urgency
    (
        "Hi {first_name}! This is {rep} from Moses Auto Group 🚗 "
        "{availability} — the {vehicle}. "
        "I'd love to get you behind the wheel. "
        "Are you free for a quick test drive this week? "
        "Reply YES and I'll lock in a time for you! 👍"
    ),
    # Value-forward
    (
        "Hey {first_name}, {rep} here at Moses Auto Group. "
        "Saw your inquiry on the {vehicle} — {availability}. "
        "We can walk through financing options and get you an OTD number in about 10 minutes. "
        "What day works best for a test drive?"
    ),
    # Low-pressure / consultative
    (
        "Hi {first_name}! It's {rep} at Moses Auto Group. "
        "Thanks for reaching out about the {vehicle}. "
        "{availability} and I want to make sure you get the best deal. "
        "Can we schedule a quick test drive? Just reply with your preferred time and I'll set it up!"
    ),
]


def generate_reply(
    lead_id: int,
    rep_name: str = "your BDC team",
    db_path: str | None = None,
) -> dict:
    """Generate a short, high-converting SMS reply for the given lead."""
    lead = get_lead(lead_id, db_path)
    if not lead:
        raise ValueError(f"Lead {lead_id} not found")

    vehicle = _lookup_vehicle(lead.get("requested_vin", ""), db_path)
    name_parts = (lead.get("customer_name") or "there").split()
    first_name = name_parts[0] if name_parts else "there"
    vehicle_label = _vehicle_label(vehicle, lead.get("vehicle_interest", ""))
    availability = _availability_line(vehicle)

    # Use OpenAI to polish the best template when credentials are present
    openai_key = os.environ.get("OPENAI_API_KEY", "").strip()
    base_template = _SMS_TEMPLATES[0]
    draft = base_template.format(
        first_name=first_name,
        rep=rep_name,
        vehicle=vehicle_label,
        availability=availability,
    )

    final_text = draft
    source = "template"

    if openai_key:
        try:
            import urllib.request as _req
            import json as _json

            prompt = (
                "You are a high-performing automotive BDC rep. "
                "Rewrite the following SMS reply to be warm, concise (max 160 chars), "
                "persuasive, and end with a clear call to action asking for a test drive appointment.\n\n"
                f"Draft: {draft}"
            )
            body = _json.dumps({
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 120,
                "temperature": 0.7,
            }).encode()
            req = _req.Request(
                "https://api.openai.com/v1/chat/completions",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openai_key}",
                },
                method="POST",
            )
            with _req.urlopen(req, timeout=8) as resp:
                result = _json.loads(resp.read())
                ai_text = result["choices"][0]["message"]["content"].strip()
                # strip surrounding quotes OpenAI sometimes adds
                ai_text = re.sub(r'^["\']|["\']$', '', ai_text)
                if 40 < len(ai_text) <= 320:
                    final_text = ai_text
                    source = "openai"
        except Exception as exc:
            print(f"[LEADS] OpenAI polish failed ({exc}), using template reply.")

    return {
        "lead_id": lead_id,
        "customer_name": lead.get("customer_name"),
        "phone": lead.get("phone"),
        "vehicle": vehicle_label,
        "reply_text": final_text,
        "source": source,
        "character_count": len(final_text),
    }
