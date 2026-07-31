"""Dealer stock-number extraction with strict selector priority + sanitization.

Priority (4-step fallback before inventing anything):
  1. Explicit dealer stock: data-stocknumber, .stockNumber, "Stock #:" labels
  2. VDP URL query params / pathname patterns (stock, stk-, stock-, -stk…)
  3. Card text/badges: "In Transit", "Transit", or "Arriving Soon" → "In Transit"
  4. "Unavailable" — never invent VIN slices, years, or random codes
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .html_utils import clean_text, decode_entities

VIN_RE = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$", re.I)
YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
# Clean stock codes: P1234, U89012, 1049A, NH-1001, etc.
STOCK_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-_/]{2,14}$", re.I)

IN_TRANSIT_STOCK = "In Transit"
MISSING_STOCK = "Unavailable"

# Status / availability badges when no explicit stock exists.
# Prefer longer phrases first; plain \btransit\b covers standalone "Transit".
_IN_TRANSIT_RE = re.compile(
    r"\b(?:"
    r"in[\s\-]?transit|"
    r"in[\s\-]?production|"
    r"arriving[\s\-]?soon|"
    r"on[\s\-]?order|"
    r"coming[\s\-]?soon|"
    r"building|"
    r"pipeline|"
    r"transit"
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
# Moses / DealerOn: .stock, .stock-number (bare code or "Stock: HT60208")
_DOM_CLASS_PATTERNS = (
    # DealerOn / Moses: class="stock" / "stock-number" with optional "Stock:" prefix
    r'class=["\'][^"\']*\bstock-number\b[^"\']*["\'][^>]*>\s*'
    r'(?:Stock\s*:\s*)?([A-Za-z0-9]{3,15})\s*<',
    r'class=["\'][^"\']*\bstock\b[^"\']*["\'][^>]*>\s*'
    r'(?:Stock\s*:\s*)?([A-Za-z0-9]{3,15})\s*<',
    r'class=["\'][^"\']*stock[-_]?number[^"\']*["\'][^>]*>\s*'
    r'(?:<(?:span|div|p|strong|em|dd|b)[^>]*class=["\'][^"\']*value[^"\']*["\'][^>]*>\s*)?'
    r'(?:Stock\s*:\s*)?([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\s*<',
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
# Moses / DealerOn prefer exact "Stock:" / "STOCK:" before broader labels.
# Must match plain text "Stock: HT60456" even when HTML tags wrap the code.
_MOSES_STOCK_RE = re.compile(r"Stock:\s*([A-Za-z0-9]+)", re.I)
_MOSES_STOCK_UPPER_RE = re.compile(r"STOCK:\s*([A-Za-z0-9]+)", re.I)
_MOSES_STOCK_HTML_RE = re.compile(
    r"Stock:\s*(?:<[^>]+>\s*)*([A-Za-z0-9]+)",
    re.I,
)
_LABEL_STOCK_RE = re.compile(
    r'(?:Stock\s*#?\s*:|Stk\s*#?\s*:|Stock\s*Number\s*:|Stock\s*No\.?\s*:|'
    r'STK\s*#?\s*:|Stock\s*#)\s*([A-Za-z0-9][A-Za-z0-9\-_/]{2,14})\b',
    re.I,
)

_PREFIX_STRIP_RE = re.compile(
    r'^(?:stock\s*(?:number|no\.?|#)?|stk\s*#?)\s*[:#]?\s*',
    re.I,
)

# ── URL path stock patterns (step 2) ─────────────────────────────────────────
_URL_PATH_STOCK_PATTERNS = (
    re.compile(r"/stk-([a-zA-Z0-9]+)", re.I),
    re.compile(r"/stock-([a-zA-Z0-9]+)", re.I),
    re.compile(r"/stock_([a-zA-Z0-9]+)", re.I),
    re.compile(r"-stk([a-zA-Z0-9]+)", re.I),
)
_URL_STOCK_QUERY_KEYS = (
    "stock",
    "stocknumber",
    "stock_number",
    "stk",
    "vin_stock",
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
        raw.strip().lower() in {"in transit", "in-transit", "intransit", "transit"}
    ):
        return IN_TRANSIT_STOCK
    raw = _PREFIX_STRIP_RE.sub("", raw).strip()
    raw = re.split(r"[\s|,;]+", raw, maxsplit=1)[0].strip()
    stock = raw.upper()
    if not stock or stock in {
        "N/A", "NA", "NONE", "-", "—", "NULL", "UNDEFINED", "UNAVAILABLE",
    }:
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
    """Extract stock from a vehicle card using selector priority.

    Moses / DealerOn ``Stock: CODE`` matches always win when present — callers
    must never fall through to Unavailable after a successful match.
    """
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
    # Exact Moses / DealerOn "Stock:" / "STOCK:" — never skip to Unavailable.
    for stock_re in (_MOSES_STOCK_RE, _MOSES_STOCK_UPPER_RE, _MOSES_STOCK_HTML_RE):
        lm = stock_re.search(plain) or stock_re.search(text)
        if lm:
            cleaned = sanitize_stock_number(lm.group(1), vin=vin, year=year)
            if cleaned:
                return cleaned

    lm = _LABEL_STOCK_RE.search(plain) or _LABEL_STOCK_RE.search(text)
    if lm:
        cleaned = sanitize_stock_number(lm.group(1), vin=vin, year=year)
        if cleaned:
            return cleaned

    return ""


def extract_stock_from_url(
    url: str,
    *,
    vin: str = "",
    year: int | str = 0,
) -> str:
    """Extract a dealer stock code from a VDP URL (query params then path).

    Query keys: stock, stockNumber, stock_number, stk, vin_stock.
    Path patterns: /stk-CODE, /stock-CODE, /stock_CODE, -stkCODE.
    Rejects years, full VINs, and In Transit / Unavailable sentinels.
    Does not mutate or strip the original URL — read-only parse.
    """
    raw_url = clean_text(decode_entities(url or ""))
    if not raw_url:
        return ""

    try:
        parsed = urlparse(raw_url)
    except Exception:
        return ""

    # 1) Query parameters (case-insensitive keys)
    try:
        qs = parse_qs(parsed.query, keep_blank_values=False)
    except Exception:
        qs = {}
    key_map = {k.lower(): v for k, v in qs.items()}
    for key in _URL_STOCK_QUERY_KEYS:
        values = key_map.get(key) or []
        for val in values:
            cleaned = sanitize_stock_number(unquote(val), vin=vin, year=year)
            # Never promote status sentinels from a URL param.
            if cleaned and cleaned not in (IN_TRANSIT_STOCK, MISSING_STOCK):
                return cleaned

    # 2) Pathname patterns
    path = unquote(parsed.path or "")
    # Also scan the full URL string for `-stk` glued to path segments.
    haystacks = (path, raw_url)
    for hay in haystacks:
        for pat in _URL_PATH_STOCK_PATTERNS:
            m = pat.search(hay)
            if not m:
                continue
            cleaned = sanitize_stock_number(m.group(1), vin=vin, year=year)
            if cleaned and cleaned not in (IN_TRANSIT_STOCK, MISSING_STOCK):
                return cleaned

    return ""


def _link_from_vehicle(raw_vehicle: dict[str, Any] | None, link: str = "", url: str = "") -> str:
    """Prefer explicit link/url args, then common VDP fields on the vehicle dict."""
    for candidate in (link, url):
        s = clean_text(decode_entities(candidate or ""))
        if s:
            return s
    if not isinstance(raw_vehicle, dict):
        return ""
    for key in ("link", "vdp_url", "vdpUrl", "url", "href", "VehicleDetailUrl", "detailUrl"):
        if key in raw_vehicle and raw_vehicle[key] not in (None, ""):
            s = clean_text(decode_entities(str(raw_vehicle[key])))
            if s:
                return s
    return ""


def resolve_stock_number(
    raw_vehicle: dict[str, Any] | None,
    html_fragment: str = "",
    *,
    vin: str = "",
    year: int | str = 0,
    link: str = "",
    url: str = "",
) -> str:
    """Resolve stock: explicit DOM → URL → In Transit → Unavailable.

    Never invents VIN slices, model years, or random codes.
    Optional ``link`` / ``url`` (or vehicle.link / vdp_url) feeds step 2.
    """
    vin_u = (vin or "").upper()
    year_n = year

    # 1) Explicit DOM / labeled stock / structured dealer fields
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

    # 2) VDP URL query params / pathname patterns
    vdp = _link_from_vehicle(raw_vehicle, link=link, url=url)
    from_url = extract_stock_from_url(vdp, vin=vin_u, year=year_n)
    if from_url:
        return from_url

    # 3) In Transit badges / status copy
    if isinstance(raw_vehicle, dict):
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

    # 4) Final fallback
    return MISSING_STOCK
