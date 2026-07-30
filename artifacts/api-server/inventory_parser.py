"""
inventory_parser.py — Regex inventory sanitizer & parser (Python mirror).

Extracts VIN / year / price / mileage / stock number from raw scraped text or
HTML and normalizes vehicle dicts before MarketplaceDB upserts.
"""

from __future__ import annotations

import re
from typing import Any

VIN_RE = re.compile(r"[A-HJ-NPR-Z0-9]{17}", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
PRICE_RE = re.compile(r"\$?\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b")
PRICE_DOLLAR_RE = re.compile(r"\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b")
MILEAGE_RE = re.compile(r"\b(\d{1,3}(?:,\d{3})*)\s*(?:mi|miles)\b", re.IGNORECASE)
STOCK_LABELED_RE = re.compile(
    r"\b(?:STK|STOCK|ID)\s*#?\s*([A-Z0-9]{4,10})\b", re.IGNORECASE
)
STOCK_RE = re.compile(
    r"\b(?:STK|STOCK|ID)?\s*#?\s*([A-Z0-9]{4,10})\b", re.IGNORECASE
)
HTML_TAG_RE = re.compile(r"<[^>]+>")
WHITESPACE_RE = re.compile(r"\s+")


def scrub_raw_text(raw: str | None) -> str:
    text = str(raw or "")
    text = HTML_TAG_RE.sub(" ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return WHITESPACE_RE.sub(" ", text).strip()


def _digits_only(value: str) -> int:
    cleaned = re.sub(r"[^0-9]", "", value or "")
    if not cleaned:
        return 0
    try:
        return int(cleaned)
    except ValueError:
        return 0


def extract_vin(text: str) -> str | None:
    m = VIN_RE.search(scrub_raw_text(text))
    return m.group(0).upper() if m else None


def extract_year(text: str) -> int | None:
    m = YEAR_RE.search(scrub_raw_text(text))
    if not m:
        return None
    year = int(m.group(0))
    from datetime import datetime

    now = datetime.now().year + 2
    if year < 1980 or year > now:
        return None
    return year


def extract_price(text: str) -> int | None:
    scrubbed = scrub_raw_text(text)
    for m in re.finditer(r"\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b", scrubbed):
        n = _digits_only(m.group(1) or m.group(0))
        if 500 <= n <= 5_000_000:
            return n
    for m in PRICE_RE.finditer(scrubbed):
        full = m.group(0)
        if full.startswith("$"):
            continue
        after = scrubbed[m.end() : m.end() + 12].lower()
        if re.search(r"\b(mi|miles)\b", after):
            continue
        n = _digits_only(full)
        if 1900 <= n <= 2100:
            continue
        if n < 1000 or n > 5_000_000:
            continue
        return n
    return None


def extract_mileage(text: str) -> int | None:
    m = MILEAGE_RE.search(scrub_raw_text(text))
    if not m:
        return None
    n = _digits_only(m.group(1) or m.group(0))
    if n < 0 or n > 1_000_000:
        return None
    return n


def extract_stock_number(text: str) -> str | None:
    scrubbed = scrub_raw_text(text)
    labeled = STOCK_LABELED_RE.search(scrubbed)
    if labeled:
        candidate = labeled.group(1).upper()
        if not VIN_RE.fullmatch(candidate):
            return candidate
    m = STOCK_RE.search(scrubbed)
    if not m:
        return None
    candidate = m.group(1).upper()
    if len(candidate) == 17 and VIN_RE.fullmatch(candidate):
        return None
    return candidate


def parse_inventory_text(raw: str) -> dict[str, Any]:
    text = scrub_raw_text(raw)
    return {
        "vin": extract_vin(text),
        "year": extract_year(text),
        "price": extract_price(text),
        "mileage": extract_mileage(text),
        "stock_number": extract_stock_number(text),
    }


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _as_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str) and value.strip():
        return max(0, _digits_only(value))
    return 0


def sanitize_vehicle_record(
    vehicle: dict[str, Any],
    raw_text: str | None = None,
) -> dict[str, Any]:
    """Fill missing VIN/year/price/mileage/stock from regex parses."""
    blob = raw_text or " ".join(
        _as_str(vehicle.get(k))
        for k in (
            "raw",
            "raw_html",
            "raw_text",
            "description",
            "title",
            "vin",
            "stock_number",
            "year",
            "price",
            "mileage",
        )
        if _as_str(vehicle.get(k))
    )
    parsed = parse_inventory_text(blob)

    vin = extract_vin(_as_str(vehicle.get("vin"))) or parsed["vin"] or _as_str(
        vehicle.get("vin")
    ).upper()

    year = _as_int(vehicle.get("year")) or parsed["year"] or 0
    price = _as_int(vehicle.get("price")) or parsed["price"] or 0
    mileage = _as_int(vehicle.get("mileage")) or parsed["mileage"] or 0

    stock = _as_str(vehicle.get("stock_number")).upper()
    if not stock or (len(stock) == 17 and VIN_RE.fullmatch(stock)):
        stock = parsed["stock_number"] or stock
    else:
        from_field = extract_stock_number(stock)
        if from_field:
            stock = from_field

    out = dict(vehicle)
    out["vin"] = vin
    out["year"] = int(year or 0)
    out["price"] = int(price or 0)
    out["mileage"] = int(mileage or 0)
    out["stock_number"] = stock or ""
    return out


def sanitize_inventory_list(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not rows:
        return []
    return [sanitize_vehicle_record(r) for r in rows if isinstance(r, dict)]
