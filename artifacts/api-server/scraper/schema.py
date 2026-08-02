"""Strict vehicle record schema for the adaptive scraper.

Canonical keys (``stockNumber``, ``exteriorColor``, ``price``, ``mileage``,
``vin``, …) are filled by the Scraper Gauntlet Matrix before normalize; this
module sanitizes types/aliases and retains In Transit / Unavailable rows.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from .fields import enrich_from_html, extract_exterior_color, extract_mileage, extract_price
from .stock import (
    IN_TRANSIT_STOCK,
    MISSING_STOCK,
    detect_in_transit,
    resolve_stock_number,
    sanitize_stock_number,
)

VIN_RE = re.compile(r"\b([A-HJ-NPR-Z0-9]{17})\b", re.I)

REQUIRED_KEYS = (
    "stockNumber",
    "year",
    "make",
    "model",
    "trim",
    "price",
    "mileage",
    "exteriorColor",
    "link",
    "imageUrl",
    "vin",
)


def _digits(value: Any) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        n = int(value)
        return n if n > 0 else 0
    raw = str(value)
    m = re.search(r"([\d,]+(?:\.\d+)?)", raw.replace("$", ""))
    if not m:
        return 0
    try:
        return int(float(m.group(1).replace(",", "")))
    except ValueError:
        return 0


def _str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _synthetic_vin(link: str, *, in_transit: bool) -> str:
    """Stable non-17-char Meta-safe id derived from the VDP link."""
    digest = hashlib.sha1(link.encode("utf-8")).hexdigest()[:12].upper()
    return f"IT{digest}" if in_transit else f"UV{digest}"


def normalize_vehicle(raw: dict[str, Any] | None, *, condition: str = "Used") -> dict[str, Any] | None:
    """Normalize any tier output into the canonical DB / Zod-compatible shape.

    Canonical JSON keys (Zod):
      stockNumber, year, make, model, trim, price, mileage,
      exteriorColor, link, imageUrl, vin
    Also emits snake_case aliases used by marketplace_inventory.

    Never drops vehicles for missing dealer stock — In Transit / Unavailable
    rows keep full VDP link + YMMT / price / miles / color / image / vin.
    """
    if not isinstance(raw, dict):
        return None

    cond_early = str(raw.get("condition") or condition or "Used").strip().title()
    if cond_early not in ("New", "Used"):
        cond_early = "Used"

    # Moses / DealerOn: fill color / miles / price from card HTML before normalize.
    html_pre = _str(
        raw.get("_html") or raw.get("raw_html") or raw.get("html")
        or raw.get("raw_text") or raw.get("description")
    )
    if html_pre:
        raw = enrich_from_html(raw, html_pre, condition=cond_early)

    def g(*keys: str) -> Any:
        for k in keys:
            if k in raw and raw[k] not in (None, ""):
                return raw[k]
            kl = k.lower().replace("_", "").replace("-", "")
            for rk, rv in raw.items():
                if str(rk).lower().replace("_", "").replace("-", "") == kl and rv not in (None, ""):
                    return rv
        return None

    html_blob = _str(g("_html", "raw_html", "html", "raw_text", "description"))
    link = _str(g("link", "vdp_url", "vdpUrl", "url", "href"))
    year = _digits(g("year", "modelYear", "model_year"))
    if year and (year < 1980 or year > 2100):
        year = 0
    make = _str(g("make", "manufacturer"))
    model = _str(g("model", "modelName"))
    trim = _str(g("trim", "trimLevel", "series"))

    # Stock first so In Transit / Unavailable cards are never dropped for
    # missing dealer stock. Order: DOM (incl. Stock:) → VDP URL → In Transit → Unavailable.
    # A Stock: match always wins and never falls through to Unavailable.
    stock = resolve_stock_number(raw, html_blob, vin="", year=year, link=link)
    if not stock:
        stock = sanitize_stock_number(
            g("stockNumber", "stock_number", "stock", "stockNo", "stock_no", "sku"),
            year=year,
        ) or MISSING_STOCK

    vin = _str(g("vin", "VIN", "Vin")).upper()
    if not vin:
        blob = " ".join(str(v) for v in raw.values() if isinstance(v, str))
        m = VIN_RE.search(blob) or VIN_RE.search(link) or VIN_RE.search(html_blob)
        if m:
            vin = m.group(1).upper()

    in_tr = stock == IN_TRANSIT_STOCK or detect_in_transit(html_blob)
    # Retain every vehicle with a stable identity. Prefer VDP-link synthetic
    # ids when VIN is omitted (IT* for In Transit, UV* for Unavailable).
    if not vin or len(vin) < 10:
        if link and (in_tr or (year and make) or stock == MISSING_STOCK or year or make):
            vin = _synthetic_vin(link, in_transit=in_tr)
            if in_tr:
                stock = IN_TRANSIT_STOCK
            elif not stock or stock in ("N/A", "NA", ""):
                stock = MISSING_STOCK
        elif year and make:
            # No VDP link — still capture the row with a YMM-stable synthetic id.
            seed = f"{year}|{make}|{model}|{trim}|{stock}".encode("utf-8")
            digest = hashlib.sha1(seed).hexdigest()[:12].upper()
            vin = f"IT{digest}" if in_tr else f"UV{digest}"
            if in_tr:
                stock = IN_TRANSIT_STOCK
            elif not stock or stock in ("N/A", "NA", ""):
                stock = MISSING_STOCK
        else:
            return None

    # Re-resolve with known VIN so year/VIN are not mistaken for stock.
    stock = (
        resolve_stock_number(raw, html_blob, vin=vin, year=year, link=link)
        or stock
        or MISSING_STOCK
    )
    if in_tr and stock == MISSING_STOCK:
        stock = IN_TRANSIT_STOCK

    price = _digits(g("price", "internetPrice", "finalPrice", "sellingPrice", "msrp", "listPrice"))
    if 1900 <= price <= 2100:
        price = 0
    if price <= 0 and html_blob:
        price = extract_price(html_blob)

    mileage = _digits(g("mileage", "miles", "odometer", "distance"))
    color = _str(g("exteriorColor", "exterior_color", "extColor", "color"))
    if not color and html_blob:
        color = extract_exterior_color(html_blob)
    image = _str(g("imageUrl", "image_url", "image", "photo", "thumbnail", "image_link"))
    title = _str(g("title", "name")) or " ".join(
        p for p in (str(year) if year else "", make, model, trim) if p
    ).strip()

    cond = (condition or cond_early or "Used").strip().title()
    if cond not in ("New", "Used"):
        cond = "Used"

    # VIN-decoder / New safety: condition New + missing mileage → 0
    if mileage <= 0:
        if html_blob:
            mileage = extract_mileage(html_blob, condition=cond)
        elif cond == "New":
            mileage = 0

    # Always retain full payload — never truncate In Transit / Unavailable rows.
    return {
        # Zod / LLM schema keys
        "stockNumber": stock or MISSING_STOCK,
        "year": year,
        "make": make,
        "model": model,
        "trim": trim,
        "price": price,
        "mileage": mileage,
        "exteriorColor": color,
        "link": link,
        "imageUrl": image,
        "vin": vin,
        "title": title,
        # DB / engine aliases — always retain VDP link + full YMMT/price/miles
        "stock_number": stock or MISSING_STOCK,
        "exterior_color": color,
        "image_url": image,
        "image_link": image,
        "vdp_url": link,
        "vdpUrl": link,
        "condition": cond,
        "status": "ACTIVE",
    }


def validate_batch(vehicles: list[dict[str, Any]], *, min_count: int = 5) -> tuple[bool, str]:
    """Return (ok, reason). Fails when too few rows or critical fields missing."""
    if len(vehicles) < min_count:
        return False, f"only_{len(vehicles)}_vehicles"
    rich = 0
    for v in vehicles:
        has_price = bool(_digits(v.get("price")))
        has_stock = bool(_str(v.get("stockNumber") or v.get("stock_number")))
        has_link = bool(_str(v.get("link") or v.get("vdp_url")))
        if has_price or has_stock or has_link:
            rich += 1
    if rich < max(1, min_count // 2):
        return False, "missing_price_stock_link"
    return True, "ok"
