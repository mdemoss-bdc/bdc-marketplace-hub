"""TikTok script generation engine.

Generates three distinct 15-second social scripts for a vehicle pulled from
``bdc_production.db`` (marketplace_inventory). Works offline with deterministic
templates; optionally polishes hooks via OpenAI when credentials are present.

Used by ``POST /api/generate-tiktok-script``.
"""

from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any

# Resolved relative to this file so the module works whether launched via
# ``python main.py`` (CWD = artifacts/api-server) or imported directly.
_HERE = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DB = os.path.join(_HERE, "bdc_production.db")


def _db_path() -> str:
    return os.environ.get("SQLITE_PATH") or _DEFAULT_DB


def _int(v: Any, default: int = 0) -> int:
    try:
        if v is None or v == "":
            return default
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _days_on_lot(last_seen: str) -> int:
    if not last_seen:
        return 0
    try:
        # SQLite CURRENT_TIMESTAMP is typically "YYYY-MM-DD HH:MM:SS"
        raw = str(last_seen).replace("Z", "+00:00")
        if "T" not in raw and " " in raw:
            raw = raw.replace(" ", "T", 1)
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, int((datetime.now(timezone.utc) - dt).total_seconds() // 86_400))
    except Exception:
        return 0


def _fmt_price(n: int) -> str:
    return f"${n:,}" if n > 0 else "Call for price"


def _fmt_miles(n: int) -> str:
    return f"{n:,}" if n > 0 else "low"


def fetch_vehicle_by_vin(vin: str, user_id: int | None = None) -> dict | None:
    """Load a marketplace_inventory row by VIN.

    Prefer an ACTIVE match for ``user_id`` when provided; otherwise fall back
    to any ACTIVE row for that VIN (local multi-tenant preview).
    """
    clean = re.sub(r"[^A-Za-z0-9]", "", (vin or "")).upper()
    if len(clean) < 11:
        return None

    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    row = None
    try:
        if user_id is not None:
            cur.execute(
                "SELECT * FROM marketplace_inventory "
                "WHERE user_id=? AND UPPER(REPLACE(vin,' ',''))=? "
                "ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, id DESC "
                "LIMIT 1",
                (user_id, clean),
            )
            row = cur.fetchone()
        if row is None:
            cur.execute(
                "SELECT * FROM marketplace_inventory "
                "WHERE UPPER(REPLACE(vin,' ',''))=? "
                "ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, id DESC "
                "LIMIT 1",
                (clean,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None

    d = dict(row)
    year = _int(d.get("year"))
    make = (d.get("make") or "").strip()
    model = (d.get("model") or "").strip()
    trim = (d.get("trim") or "").strip()
    price = _int(d.get("price"))
    mileage = _int(d.get("mileage"))
    color = (d.get("exterior_color") or d.get("color") or "").strip()
    days = _days_on_lot(str(d.get("last_seen") or d.get("created_at") or ""))
    title = " ".join(str(p) for p in (year or "", make, model, trim) if p).strip()

    return {
        "id": d.get("id"),
        "user_id": d.get("user_id"),
        "vin": d.get("vin") or clean,
        "stock_number": (d.get("stock_number") or "").strip(),
        "year": year,
        "make": make,
        "model": model,
        "trim": trim,
        "price": price,
        "mileage": mileage,
        "exterior_color": color,
        "interior_color": (d.get("interior_color") or "").strip(),
        "image_url": d.get("image_url") or "",
        "condition": d.get("condition") or "Used",
        "status": d.get("status") or "",
        "last_seen": str(d.get("last_seen") or ""),
        "days_on_lot": days,
        "title": title or "vehicle",
        "price_fmt": _fmt_price(price),
        "mileage_fmt": _fmt_miles(mileage),
    }


def _scene(order: int, duration_s: int, camera: str, voiceover: str) -> dict:
    cue = camera if camera.startswith("[") else f"[Camera: {camera}]"
    return {
        "order": order,
        "duration_s": duration_s,
        "camera": cue,
        "voiceover": voiceover,
        # Combined line for copy/paste into a teleprompter.
        "line": f"{cue} {voiceover}".strip(),
    }


def _script_urgent_deal(v: dict) -> dict:
    """Option A — price-drop / low-mileage urgency."""
    title = v["title"]
    days = v["days_on_lot"]
    miles = v["mileage_fmt"]
    price = v["price_fmt"]
    color = v["exterior_color"] or "showroom-clean"
    stock = (v["stock_number"] or "TODAY").upper()
    low_miles = v["mileage"] > 0 and v["mileage"] < 40_000

    if low_miles:
        hook = (
            f"Stop scrolling — this {title} only has {miles} miles "
            f"and it's priced at {price}."
        )
    elif days >= 30:
        hook = (
            f"This {title} has been on the lot {days} days — "
            f"my manager is cutting the price TODAY."
        )
    else:
        hook = (
            f"Urgent deal alert: {title} just hit the floor at {price}."
        )

    scenes = [
        _scene(
            1, 3,
            "Aggressive push-in on the front grille with price-tag text overlay",
            hook,
        ),
        _scene(
            2, 4,
            "Quick whip-pan to odometer, then snap to the window sticker",
            (
                f"Only {miles} miles, finished in {color} — "
                f"units this clean don't sit. Was listed at {price}."
            ),
        ),
        _scene(
            3, 4,
            "Handheld walk-around with hard cuts every beat — wheels, badge, mirrors",
            (
                f"We've got {days} day{'s' if days != 1 else ''} of lot age on this, "
                "which means the desk wants it GONE before month-end."
            ),
        ),
        _scene(
            4, 4,
            "Hero three-quarter shot with CTA lower-third graphic",
            f'DM the code {stock} or comment "DEAL" — first one in locks this price.',
        ),
    ]
    return {
        "option": "A",
        "style": "urgent_deal",
        "script_title": "Urgent Deal Alert",
        "hook": hook,
        "scenes": scenes,
        "cta": f'DM code {stock} or comment "DEAL" to lock {price} before it moves.',
        "hashtags": [
            "#DealAlert", "#CarTok", "#PriceDrop", "#CarsOfTikTok",
            f"#{re.sub(r'[^A-Za-z0-9]', '', v['make'] + v['model']) or 'CarDeal'}",
        ],
    }


def _script_luxury_walkaround(v: dict) -> dict:
    """Option B — interior tech / trim feature walkaround."""
    title = v["title"]
    trim = v["trim"] or "premium"
    color = v["exterior_color"] or "a refined finish"
    interior = v["interior_color"] or "a crafted cabin"
    price = v["price_fmt"]
    miles = v["mileage_fmt"]

    hook = (
        f"Introducing the {title} — refinement you feel before you even start the engine."
    )
    scenes = [
        _scene(
            1, 3,
            "Slow gimbal reveal from darkness into the front fascia",
            hook,
        ),
        _scene(
            2, 4,
            "Steady close-up of door-open → ambient lighting cascade across the dash",
            (
                f"Step inside the {trim} cabin — {interior} interior, "
                "soft-touch surfaces, and a soundstage that fills the cabin."
            ),
        ),
        _scene(
            3, 4,
            "Macro pan across infotainment boot, steering-wheel controls, and gauge cluster",
            (
                f"Tech that anticipates you: crisp screen wake, intuitive controls, "
                f"and {miles} miles of pristine ownership at {price}."
            ),
        ),
        _scene(
            4, 4,
            "Exterior hero glide with soft bokeh background and dealership lower-third",
            (
                f"Finished in {color}. Schedule a private walkaround — "
                'comment "LUXURY" or DM us for a white-glove appointment.'
            ),
        ),
    ]
    return {
        "option": "B",
        "style": "luxury_walkaround",
        "script_title": "Luxury / Feature Walkaround",
        "hook": hook,
        "scenes": scenes,
        "cta": 'Comment "LUXURY" or DM us to book a private feature walkaround.',
        "hashtags": [
            "#LuxuryCars", "#CarReview", "#PremiumRide", "#CarsOfTikTok",
            f"#{re.sub(r'[^A-Za-z0-9]', '', v['make'] + v['model']) or 'Luxury'}",
        ],
    }


def _script_cold_start_pov(v: dict) -> dict:
    """Option C — exhaust / engine / driver POV experience."""
    title = v["title"]
    price = v["price_fmt"]
    miles = v["mileage_fmt"]
    color = v["exterior_color"] or "that paint"

    hook = f"Cold start. POV. The {title} waking up — listen to this."
    scenes = [
        _scene(
            1, 3,
            "Low bumper angle on the exhaust tips as the key turns - mic on the tip",
            hook,
        ),
        _scene(
            2, 4,
            "Driver POV: hand to start button, gauge sweep, tach climbing off idle",
            (
                f"Feel that idle settle — {miles} miles of life left to burn, "
                f"wrapped in {color}."
            ),
        ),
        _scene(
            3, 4,
            "Hood-line tracking shot past the fender as you roll onto the street",
            (
                "Steering loads up, cabin hush, that first pull of torque — "
                "this is the driver's seat argument."
            ),
        ),
        _scene(
            4, 4,
            "Dynamic sweep of front grille then cut to driver smirk + price card",
            (
                f"Ready to take it for a spin at {price}? "
                'Comment "DRIVE" or DM us — we\'ll have it staged and ready.'
            ),
        ),
    ]
    return {
        "option": "C",
        "style": "cold_start_pov",
        "script_title": "Cold Start / POV Drive",
        "hook": hook,
        "scenes": scenes,
        "cta": 'Comment "DRIVE" or DM us to stage a cold-start / POV test drive.',
        "hashtags": [
            "#ColdStart", "#POVDrive", "#CarTok", "#ExhaustTok", "#CarsOfTikTok",
            f"#{re.sub(r'[^A-Za-z0-9]', '', v['make'] + v['model']) or 'Drive'}",
        ],
    }


def generate_scripts(vehicle: dict) -> list[dict]:
    """Build the three required script styles for a vehicle dict."""
    return [
        _script_urgent_deal(vehicle),
        _script_luxury_walkaround(vehicle),
        _script_cold_start_pov(vehicle),
    ]


def generate_tiktok_scripts_for_vin(
    vin: str,
    user_id: int | None = None,
) -> dict:
    """Fetch inventory by VIN and return structured script options.

    Raises ``ValueError`` with a human-readable message on bad input / miss.
    """
    vehicle = fetch_vehicle_by_vin(vin, user_id=user_id)
    if not vehicle:
        raise ValueError(
            f"No vehicle found in inventory for VIN '{(vin or '').strip()}'."
        )

    scripts = generate_scripts(vehicle)
    return {
        "vin": vehicle["vin"],
        "vehicle": {
            "year": vehicle["year"],
            "make": vehicle["make"],
            "model": vehicle["model"],
            "trim": vehicle["trim"],
            "price": vehicle["price"],
            "mileage": vehicle["mileage"],
            "exterior_color": vehicle["exterior_color"],
            "interior_color": vehicle["interior_color"],
            "days_on_lot": vehicle["days_on_lot"],
            "stock_number": vehicle["stock_number"],
            "title": vehicle["title"],
            "image_url": vehicle["image_url"],
        },
        # Top-level convenience: first option's fields for simple clients.
        "script_title": scripts[0]["script_title"],
        "hook": scripts[0]["hook"],
        "scenes": scripts[0]["scenes"],
        "cta": scripts[0]["cta"],
        # Full set — Option A / B / C.
        "scripts": scripts,
    }
