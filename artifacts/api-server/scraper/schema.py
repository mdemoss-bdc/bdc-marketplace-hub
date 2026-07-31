"""Strict vehicle record schema for the adaptive scraper."""

from __future__ import annotations

import re
from typing import Any

from .stock import resolve_stock_number, sanitize_stock_number

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


def normalize_vehicle(raw: dict[str, Any] | None, *, condition: str = "Used") -> dict[str, Any] | None:
    """Normalize any tier output into the canonical DB / Zod-compatible shape.

    Canonical JSON keys (Zod):
      stockNumber, year, make, model, trim, price, mileage,
      exteriorColor, link, imageUrl, vin
    Also emits snake_case aliases used by marketplace_inventory.
    """
    if not isinstance(raw, dict):
        return None

    def g(*keys: str) -> Any:
        for k in keys:
            if k in raw and raw[k] not in (None, ""):
                return raw[k]
            kl = k.lower().replace("_", "").replace("-", "")
            for rk, rv in raw.items():
                if str(rk).lower().replace("_", "").replace("-", "") == kl and rv not in (None, ""):
                    return rv
        return None

    vin = _str(g("vin", "VIN", "Vin")).upper()
    if not vin:
        blob = " ".join(str(v) for v in raw.values() if isinstance(v, str))
        m = VIN_RE.search(blob)
        if m:
            vin = m.group(1).upper()
    if not vin or len(vin) < 10:
        return None

    year = _digits(g("year", "modelYear", "model_year"))
    if year and (year < 1980 or year > 2100):
        year = 0

    price = _digits(g("price", "internetPrice", "finalPrice", "sellingPrice", "msrp", "listPrice"))
    if 1900 <= price <= 2100:
        price = 0

    mileage = _digits(g("mileage", "miles", "odometer", "distance"))
    make = _str(g("make", "manufacturer"))
    model = _str(g("model", "modelName"))
    trim = _str(g("trim", "trimLevel", "series"))
    color = _str(g("exteriorColor", "exterior_color", "extColor", "color"))
    link = _str(g("link", "vdp_url", "vdpUrl", "url", "href"))
    image = _str(g("imageUrl", "image_url", "image", "photo", "thumbnail"))

    # Strict stock: reject model years / full VINs; never use year as stock.
    stock = resolve_stock_number(
        raw,
        _str(g("_html", "raw_html", "html")),
        vin=vin,
        year=year,
    )
    if stock == "N/A":
        # Still try a direct sanitize of an explicit field (no VIN fallback).
        direct = sanitize_stock_number(
            g("stockNumber", "stock_number", "stock", "stockNo", "stock_no", "sku"),
            vin=vin,
            year=year,
        )
        stock = direct or "N/A"

    cond = (condition or "Used").strip().title()
    if cond not in ("New", "Used"):
        cond = "Used"

    return {
        # Zod / LLM schema keys
        "stockNumber": stock,
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
        # DB / engine aliases
        "stock_number": stock if stock != "N/A" else "",
        "exterior_color": color,
        "image_url": image,
        "vdp_url": link,
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
        has_stock = bool(_str(v.get("stockNumber") or v.get("stock_number"))) and (
            _str(v.get("stockNumber") or v.get("stock_number")) != "N/A"
        )
        has_link = bool(_str(v.get("link") or v.get("vdp_url")))
        if has_price or has_stock or has_link:
            rich += 1
    if rich < max(1, min_count // 2):
        return False, "missing_price_stock_link"
    return True, "ok"
