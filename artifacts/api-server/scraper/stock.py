"""Dealer stock-number extraction with strict selector priority + sanitization.

Priority (before generic regex / VIN / year fallbacks):
  1. Data attributes: data-stocknumber, data-stock-number, data-stock, data-vin-stock
  2. DOM class selectors: .stockNumber .value, .stock-number .value, …
  3. Labeled text: "Stock #:" / "Stk #:" + alphanumeric code
"""

from __future__ import annotations

import re
from typing import Any

from .html_utils import clean_text, decode_entities

VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$", re.I)
YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
# Clean stock codes: P1234, U89012, 1049A, NH-1001, etc.
STOCK_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_/]{2,14}$", re.I)

# ── 1) Data attributes (highest priority) ────────────────────────────────────
_DATA_ATTR_PATTERNS = (
    r'data-stocknumber\s*=\s*["\']([^"\']+)["\']',
    r'data-stock-number\s*=\s*["\']([^"\']+)["\']',
    r'data-vin-stock\s*=\s*["\']([^"\']+)["\']',
    r'data-stock-no\s*=\s*["\']([^"\']+)["\']',
    r'data-stockno\s*=\s*["\']([^"\']+)["\']',
    r'data-stocknum\s*=\s*["\']([^"\']+)["\']',
    r'data-vehicle-stock\s*=\s*["\']([^"\']+)["\']',
    r'data-stock\s*=\s*["\']([^"\']+)["\']',
)

# ── 2) DOM class / nested .value selectors ───────────────────────────────────
# Matches: <div class="stockNumber"><span class="value">P9821</span></div>
#          <span class="item-stock-number">U89012</span>
#          <div class="ddc-stockNumber"><span class="value">…</span>
_DOM_CLASS_PATTERNS = (
    # .stockNumber .value  /  .stock-number .value
    r'class=["\'][^"\']*stock[-_]?number[^"\']*["\'][^>]*>\s*'
    r'(?:<(?:span|div|p|strong|em|dd|b)[^>]*class=["\'][^"\']*value[^"\']*["\'][^>]*>\s*)?'
    r'([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    # .item-stock-number
    r'class=["\'][^"\']*item-stock-number[^"\']*["\'][^>]*>\s*'
    r'([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    # [class*="stock"] .value
    r'class=["\'][^"\']*stock[^"\']*["\'][^>]*>\s*'
    r'<(?:span|div|p|strong|em|dd|b)[^>]*class=["\'][^"\']*\bvalue\b[^"\']*["\'][^>]*>\s*'
    r'([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    # [class*="stockNumber"] direct text
    r'class=["\'][^"\']*stockNumber[^"\']*["\'][^>]*>\s*'
    r'(?:<[^>]+>\s*)*([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    # data-field / aria style value next to stock class
    r'class=["\'][^"\']*stock[-_]?number[^"\']*["\'][^>]*'
    r'(?:data-value|data-stock|title)\s*=\s*["\']([^"\']+)["\']',
)

# ── 3) Labeled text nodes ────────────────────────────────────────────────────
_LABEL_STOCK_RE = re.compile(
    r'(?:Stock\s*#?\s*:|Stk\s*#?\s*:|Stock\s*Number\s*:|Stock\s*No\.?\s*:|'
    r'STK\s*#?\s*:|Stock\s*#)\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\b',
    re.I,
)

# Strip leading labels if a raw field still contains them
_PREFIX_STRIP_RE = re.compile(
    r'^(?:stock\s*(?:number|no\.?|#)?|stk\s*#?)\s*[:#]?\s*',
    re.I,
)


def sanitize_stock_number(
    value: Any,
    *,
    vin: str = "",
    year: int | str = 0,
    allow_vin_fallback: bool = False,
) -> str:
    """Return a clean stock code, or '' if the value is invalid.

    Rejects 4-digit model years and full 17-digit VINs (unless
    ``allow_vin_fallback`` and no other stock exists — callers decide).
    """
    raw = clean_text(decode_entities(value))
    if not raw:
        return ""
    raw = _PREFIX_STRIP_RE.sub("", raw).strip()
    # Keep first token if leftover label noise remains
    raw = re.split(r"[\s|,;]+", raw, maxsplit=1)[0].strip()
    stock = raw.upper()
    if not stock or stock in {"N/A", "NA", "NONE", "-", "—", "NULL", "UNDEFINED"}:
        return ""
    if YEAR_RE.fullmatch(stock):
        return ""
    year_s = str(year or "").strip()
    if year_s and stock == year_s:
        return ""
    if VIN_RE.fullmatch(stock):
        if allow_vin_fallback and vin and stock == vin.upper():
            return vin.upper()[-8:]
        return ""
    if vin and stock == str(vin).upper():
        return ""
    if not STOCK_CODE_RE.fullmatch(stock):
        return ""
    # Pure years already rejected; also reject bare make-like tokens without digits
    # when shorter than 5 and no digit present (likely model noise).
    if not re.search(r"\d", stock) and len(stock) < 5:
        return ""
    return stock


def extract_stock_from_html(
    html_fragment: str,
    *,
    vin: str = "",
    year: int | str = 0,
) -> str:
    """Extract stock from a vehicle card/container HTML using selector priority."""
    text = decode_entities(html_fragment or "")
    if not text:
        return ""

    # 1) Data attributes
    for pat in _DATA_ATTR_PATTERNS:
        m = re.search(pat, text, re.I)
        if m:
            cleaned = sanitize_stock_number(m.group(1), vin=vin, year=year)
            if cleaned:
                return cleaned

    # 2) DOM class selectors
    for pat in _DOM_CLASS_PATTERNS:
        m = re.search(pat, text, re.I)
        if m:
            cleaned = sanitize_stock_number(m.group(1), vin=vin, year=year)
            if cleaned:
                return cleaned

    # 3) Labeled text nodes (strip tags first for plain text scan)
    plain = clean_text(re.sub(r"<[^>]+>", " ", text))
    lm = _LABEL_STOCK_RE.search(plain) or _LABEL_STOCK_RE.search(text)
    if lm:
        cleaned = sanitize_stock_number(lm.group(1), vin=vin, year=year)
        if cleaned:
            return cleaned

    return ""


def resolve_stock_number(
    raw_vehicle: dict[str, Any] | None,
    html_fragment: str = "",
    *,
    vin: str = "",
    year: int | str = 0,
) -> str:
    """Full resolution: HTML selectors → field aliases → labeled text → N/A.

    Never substitutes model year. VIN last-8 only when no explicit stock exists.
    """
    vin_u = (vin or "").upper()
    year_n = year

    # Prefer DOM / data-* from the card HTML first.
    from_html = extract_stock_from_html(html_fragment, vin=vin_u, year=year_n)
    if from_html:
        return from_html

    if isinstance(raw_vehicle, dict):
        for key in (
            "stockNumber",
            "stock_number",
            "stockNo",
            "stock_no",
            "stock_num",
            "stockNum",
            "dealerStockNumber",
            "dealer_stock_number",
            "sku",
            "SKU",
            "mpn",
            "stock",
        ):
            if key in raw_vehicle and raw_vehicle[key] not in (None, ""):
                cleaned = sanitize_stock_number(
                    raw_vehicle[key], vin=vin_u, year=year_n,
                )
                if cleaned:
                    return cleaned

    # Last resort: labeled text already tried inside extract_stock_from_html.
    # Only then allow VIN tail — never the model year.
    if vin_u and len(vin_u) == 17 and VIN_RE.fullmatch(vin_u):
        return vin_u[-8:]
    return "N/A"
