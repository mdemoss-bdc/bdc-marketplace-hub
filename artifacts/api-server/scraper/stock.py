"""Dealer stock-number extraction with strict selector priority + sanitization.

Priority (before generic regex / VIN / year fallbacks):
  1. Data attributes: data-stocknumber, data-stock-number, data-stock, data-vin-stock
  2. DOM class selectors: .stockNumber .value, .stock-number .value, …
  3. Labeled text: "Stock #:" / "Stk #:" + alphanumeric code
  4. "In Transit" / "Building" / "Arriving Soon" status badges (literal stockNumber)
  5. Empty string — never invent VIN slices, years, or random codes
"""

from __future__ import annotations

import re
from typing import Any

from .html_utils import clean_text, decode_entities

VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$", re.I)
YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
# Clean stock codes: P1234, U89012, 1049A, NH-1001, etc.
STOCK_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_/]{2,14}$", re.I)

IN_TRANSIT_STOCK = "In Transit"

# Status / availability badges when no explicit stock exists.
_IN_TRANSIT_RE = re.compile(
    r"\b(?:"
    r"in[\s\-]?transit|"
    r"in[\s\-]?production|"
    r"building|"
    r"arriving[\s\-]?soon|"
    r"on[\s\-]?order|"
    r"coming[\s\-]?soon|"
    r"pipeline"
    r")\b",
    re.I,
)

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
_DOM_CLASS_PATTERNS = (
    r'class=["\'][^"\']*stock[-_]?number[^"\']*["\'][^>]*>\s*'
    r'(?:<(?:span|div|p|strong|em|dd|b)[^>]*class=["\'][^"\']*value[^"\']*["\'][^>]*>\s*)?'
    r'([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    r'class=["\'][^"\']*item-stock-number[^"\']*["\'][^>]*>\s*'
    r'([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    r'class=["\'][^"\']*stock[^"\']*["\'][^>]*>\s*'
    r'<(?:span|div|p|strong|em|dd|b)[^>]*class=["\'][^"\']*\bvalue\b[^"\']*["\'][^>]*>\s*'
    r'([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    r'class=["\'][^"\']*stockNumber[^"\']*["\'][^>]*>\s*'
    r'(?:<[^>]+>\s*)*([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
    r'class=["\'][^"\']*stock[-_]?number[^"\']*["\'][^>]*'
    r'(?:data-value|data-stock|title)\s*=\s*["\']([^"\']+)["\']',
)

# ── 3) Labeled text nodes ────────────────────────────────────────────────────
_LABEL_STOCK_RE = re.compile(
    r'(?:Stock\s*#?\s*:|Stk\s*#?\s*:|Stock\s*Number\s*:|Stock\s*No\.?\s*:|'
    r'STK\s*#?\s*:|Stock\s*#)\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\b',
    re.I,
)

_PREFIX_STRIP_RE = re.compile(
    r'^(?:stock\s*(?:number|no\.?|#)?|stk\s*#?)\s*[:#]?\s*',
    re.I,
)


def detect_in_transit(html_or_text: str) -> bool:
    """True when card/status copy indicates the vehicle is in transit / arriving."""
    text = decode_entities(html_or_text or "")
    if not text:
        return False
    # Prefer badge / status class windows, then full plain text.
    for m in re.finditer(
        r'class=["\'][^"\']*(?:status|badge|availability|label|tag|pill)[^"\']*["\'][^>]*>'
        r'([\s\S]{0,120}?)</',
        text,
        re.I,
    ):
        if _IN_TRANSIT_RE.search(clean_text(m.group(1))):
            return True
    plain = clean_text(re.sub(r"<[^>]+>", " ", text))
    return bool(_IN_TRANSIT_RE.search(plain))


def sanitize_stock_number(
    value: Any,
    *,
    vin: str = "",
    year: int | str = 0,
) -> str:
    """Return a clean dealer stock code, or '' if missing/invalid.

    Preserves the literal ``In Transit`` sentinel. Never invents codes.
    Rejects 4-digit model years and full VINs.
    """
    raw = clean_text(decode_entities(value))
    if not raw:
        return ""
    if _IN_TRANSIT_RE.fullmatch(raw.replace("_", " ").replace("-", " ")) or (
        raw.strip().lower() in {"in transit", "in-transit", "intransit"}
    ):
        return IN_TRANSIT_STOCK
    raw = _PREFIX_STRIP_RE.sub("", raw).strip()
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
        return ""
    if vin and stock == str(vin).upper():
        return ""
    if not STOCK_CODE_RE.fullmatch(stock):
        return ""
    if not re.search(r"\d", stock) and len(stock) < 5:
        return ""
    return stock


def extract_stock_from_html(
    html_fragment: str,
    *,
    vin: str = "",
    year: int | str = 0,
) -> str:
    """Extract stock from a vehicle card using selector priority."""
    text = decode_entities(html_fragment or "")
    if not text:
        return ""

    for pat in _DATA_ATTR_PATTERNS:
        m = re.search(pat, text, re.I)
        if m:
            cleaned = sanitize_stock_number(m.group(1), vin=vin, year=year)
            if cleaned:
                return cleaned

    for pat in _DOM_CLASS_PATTERNS:
        m = re.search(pat, text, re.I)
        if m:
            cleaned = sanitize_stock_number(m.group(1), vin=vin, year=year)
            if cleaned:
                return cleaned

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
    """Resolve stock: explicit dealer value → In Transit → "".

    Never invents VIN slices, model years, or random codes.
    """
    vin_u = (vin or "").upper()
    year_n = year

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

        # Status fields on the vehicle dict (availability / badge copy).
        status_blob = " ".join(
            str(raw_vehicle.get(k) or "")
            for k in (
                "status_label",
                "availability",
                "badge",
                "vehicle_status",
                "inventory_status",
                "raw_text",
                "description",
            )
        )
        if detect_in_transit(status_blob):
            return IN_TRANSIT_STOCK

    if detect_in_transit(html_fragment):
        return IN_TRANSIT_STOCK

    return ""
