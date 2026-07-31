"""
inventory_parser.py — Regex inventory sanitizer & parser (Python mirror).

Extracts VIN / year / price / mileage / stock / year-make-model from raw
scraped text or HTML and normalizes vehicle dicts before MarketplaceDB upserts.

All scraper text should pass through scrub_raw_text / sanitize_vehicle_record
(or parse_inventory_html via dom_inventory) before persistence.
"""

from __future__ import annotations

import re
from typing import Any

VIN_RE = re.compile(r"[A-HJ-NPR-Z0-9]{17}", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
# Optional leading $; sanitize to pure integers (e.g. 29995).
PRICE_RE = re.compile(r"\$?\b\d{1,3}(?:,\d{3})*\b")
PRICE_DOLLAR_RE = re.compile(r"\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b")
# Moses / DealerOn: "$32,995" card amounts and labeled prices
PRICE_LABEL_RE = re.compile(
    r"(?:MOSES\s+PRICE|INTERNET\s+PRICE|OUR\s+PRICE|TSRP)\s*:?\s*\$?\s*"
    r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})",
    re.IGNORECASE,
)
PRICE_CARD_RE = re.compile(r"\$([0-9]{2,3},[0-9]{3})")
MILEAGE_RE = re.compile(r"([0-9,]+)\s*(?:mi\.?|miles)\b", re.IGNORECASE)
# Moses / DealerOn (moses_layout.txt): "Stock #:" / "Stock:" / "STOCK:"
MOSES_STOCK_HASH_RE = re.compile(r"Stock\s*#\s*:\s*([A-Za-z0-9]+)", re.IGNORECASE)
MOSES_STOCK_RE = re.compile(r"Stock:\s*([A-Za-z0-9]+)", re.IGNORECASE)
MOSES_STOCK_UPPER_RE = re.compile(r"STOCK:\s*([A-Za-z0-9]+)", re.IGNORECASE)
STOCK_LABELED_RE = re.compile(
    r"\b(?:Stock\s*#?\s*:|Stk\s*#?\s*:|Stock\s*Number\s*:|Stock\s*No\.?\s*:|"
    r"STK\s*#?\s*:|STOCK\s*#|STK\s*#|STOCK|STK|ID)\s*#?\s*:?\s*"
    r"([A-Z0-9][A-Z0-9\-_/]{2,14})\b",
    re.IGNORECASE,
)
EXT_COLOR_RE = re.compile(
    r"(?:Ext(?:erior)?(?:\s*Color)?|Ext\.)\s*[:.]?\s*"
    r"([A-Za-z][A-Za-z0-9 \-/]{1,40})",
    re.IGNORECASE,
)
STOCK_RE = re.compile(
    r"\b(?:STK|STOCK|ID)?\s*#?\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,14})\b",
    re.IGNORECASE,
)
_YEAR_ONLY_RE = re.compile(r"^(?:19|20)\d{2}$")
_STOCK_PREFIX_RE = re.compile(
    r"^(?:stock\s*(?:number|no\.?|#)?|stk\s*#?)\s*[:#]?\s*",
    re.IGNORECASE,
)
_IN_TRANSIT_RE = re.compile(
    r"\b(?:in[\s\-]?transit|in[\s\-]?production|arriving[\s\-]?soon|"
    r"on[\s\-]?order|coming[\s\-]?soon|building|pipeline|transit)\b",
    re.IGNORECASE,
)
IN_TRANSIT_STOCK = "In Transit"
MISSING_STOCK = "Unavailable"
# Year Make Model — standard keyword extraction from SRP headings.
YMM_RE = re.compile(
    r"\b((?:19|20)\d{2})\s+([A-Za-z][A-Za-z0-9\-]+)\s+([A-Za-z0-9][A-Za-z0-9 \-/]{1,40})"
)
HTML_TAG_RE = re.compile(r"<[^>]+>")
# Strip script/style/header/nav/footer before tag scrub when HTML is passed in.
DOM_NOISE_RE = re.compile(
    r"<(script|style|noscript|header|footer|nav|aside)\b[^>]*>[\s\S]*?</\1>",
    re.IGNORECASE,
)
WHITESPACE_RE = re.compile(r"\s+")

_KNOWN_MAKES = frozenset({
    "acura", "alfa", "aston", "audi", "bentley", "bmw", "buick", "cadillac",
    "chevrolet", "chevy", "chrysler", "dodge", "ferrari", "fiat", "ford",
    "genesis", "gmc", "honda", "hyundai", "infiniti", "jaguar", "jeep", "kia",
    "lamborghini", "land", "lexus", "lincoln", "lotus", "maserati", "mazda",
    "mclaren", "mercedes", "mercury", "mini", "mitsubishi", "nissan",
    "porsche", "ram", "rivian", "rolls", "subaru", "suzuki", "tesla",
    "toyota", "volkswagen", "vw", "volvo",
})


def scrub_raw_text(raw: str | None) -> str:
    text = str(raw or "")
    if "<" in text and ">" in text:
        text = DOM_NOISE_RE.sub(" ", text)
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
    # Prefer Moses / DealerOn labeled prices, then $NN,NNN card amounts.
    lm = PRICE_LABEL_RE.search(scrubbed)
    if lm:
        n = _digits_only(lm.group(1))
        if 500 <= n <= 5_000_000 and not (1900 <= n <= 2100):
            return n
    cm = PRICE_CARD_RE.search(scrubbed)
    if cm:
        n = _digits_only(cm.group(1))
        if 500 <= n <= 5_000_000 and not (1900 <= n <= 2100):
            return n
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


def extract_exterior_color(text: str) -> str | None:
    """Ext. / Ext: / Exterior: / Ext Color: labels (Moses / DealerOn)."""
    scrubbed = scrub_raw_text(text)
    m = EXT_COLOR_RE.search(scrubbed)
    if not m:
        return None
    c = m.group(1).strip()
    c = re.split(
        r"\s+(?:Stock|VIN|Mi\.?|Miles?|\$|\d{1,3}(?:,\d{3})*(?:\s*(?:mi\.?|miles))?)\b",
        c,
        maxsplit=1,
        flags=re.I,
    )[0].strip()
    if not c or re.fullmatch(r"(?:n/?a|none|unknown|select|color|ext\.?)", c, re.I):
        return None
    return c


def _clean_stock_candidate(raw: str) -> str | None:
    """Strip labels; reject model years and full VINs."""
    candidate = _STOCK_PREFIX_RE.sub("", scrub_raw_text(raw)).strip().upper()
    candidate = re.split(r"[\s|,;]+", candidate, maxsplit=1)[0].strip()
    if not candidate or candidate in {
        "N/A", "NA", "NONE", "-", "UNAVAILABLE", "IN TRANSIT", "TRANSIT",
    }:
        return None
    if _YEAR_ONLY_RE.fullmatch(candidate):
        return None
    if len(candidate) == 17 and VIN_RE.fullmatch(candidate):
        return None
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9\-_/]{2,14}", candidate):
        return None
    if not re.search(r"\d", candidate) and len(candidate) < 5:
        return None
    return candidate


_URL_PATH_STOCK_PATTERNS = (
    re.compile(r"/stk-([a-zA-Z0-9]+)", re.I),
    re.compile(r"/stock-([a-zA-Z0-9]+)", re.I),
    re.compile(r"/stock_([a-zA-Z0-9]+)", re.I),
    re.compile(r"-stk([a-zA-Z0-9]+)", re.I),
)
_URL_STOCK_QUERY_KEYS = ("stock", "stocknumber", "stock_number", "stk", "vin_stock")


def extract_stock_from_url(url: str, *, year: int = 0, vin: str = "") -> str | None:
    """Parse stock from a VDP URL (query params then pathname patterns)."""
    from urllib.parse import parse_qs, unquote, urlparse

    raw = scrub_raw_text(url)
    if not raw:
        return None
    try:
        parsed = urlparse(raw)
    except Exception:
        return None
    try:
        qs = parse_qs(parsed.query, keep_blank_values=False)
    except Exception:
        qs = {}
    key_map = {k.lower(): v for k, v in qs.items()}
    for key in _URL_STOCK_QUERY_KEYS:
        for val in key_map.get(key) or []:
            cleaned = _clean_stock_candidate(unquote(val))
            if cleaned and (not year or cleaned != str(year)):
                if vin and cleaned == vin.upper():
                    continue
                return cleaned
    path = unquote(parsed.path or "")
    for hay in (path, raw):
        for pat in _URL_PATH_STOCK_PATTERNS:
            m = pat.search(hay)
            if not m:
                continue
            cleaned = _clean_stock_candidate(m.group(1))
            if cleaned and (not year or cleaned != str(year)):
                if vin and cleaned == vin.upper():
                    continue
                return cleaned
    return None


def extract_stock_number(text: str) -> str | None:
    scrubbed = scrub_raw_text(text)
    # Moses / DealerOn "Stock #:" / "Stock:" / "STOCK:" — never → Unavailable.
    for stock_re in (MOSES_STOCK_HASH_RE, MOSES_STOCK_RE, MOSES_STOCK_UPPER_RE):
        moses = stock_re.search(scrubbed)
        if moses:
            cleaned = _clean_stock_candidate(moses.group(1))
            if cleaned:
                return cleaned
    labeled = STOCK_LABELED_RE.search(scrubbed)
    if labeled:
        cleaned = _clean_stock_candidate(labeled.group(1))
        if cleaned:
            return cleaned
    # Only accept unlabeled matches when they cannot be confused with a year.
    m = STOCK_RE.search(scrubbed)
    if not m:
        return None
    return _clean_stock_candidate(m.group(1))


def extract_year_make_model(text: str) -> dict[str, Any]:
    """Standard keyword extraction for Year / Make / Model from SRP text."""
    scrubbed = scrub_raw_text(text)
    m = YMM_RE.search(scrubbed)
    if not m:
        return {"year": None, "make": None, "model": None}
    year = int(m.group(1))
    make = m.group(2).strip()
    model_raw = m.group(3).strip()
    # Trim trailing price / mileage / stock noise from the model token.
    model_raw = re.split(
        r"\s+(?:\$|\d{1,3}(?:,\d{3})+\s*(?:mi|miles)|stock|stk|vin)\b",
        model_raw,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip(" -|/")
    make_l = make.lower()
    # Prefer known OEM tokens; allow multi-word makes like "Land Rover".
    if make_l == "land" and model_raw.lower().startswith("rover"):
        parts = model_raw.split(None, 1)
        make = "Land Rover"
        model_raw = parts[1] if len(parts) > 1 else "Rover"
    elif make_l == "alfa" and model_raw.lower().startswith("romeo"):
        parts = model_raw.split(None, 1)
        make = "Alfa Romeo"
        model_raw = parts[1] if len(parts) > 1 else "Romeo"
    elif make_l not in _KNOWN_MAKES and make_l not in {"mercedes-benz", "rolls-royce"}:
        # Still accept unknown makes from YMM pattern — dealer sites vary.
        pass
    model = " ".join(model_raw.split()[:4]).strip()
    from datetime import datetime

    now = datetime.now().year + 2
    if year < 1980 or year > now:
        return {"year": None, "make": None, "model": None}
    return {
        "year": year,
        "make": make.title() if make.islower() else make,
        "model": model,
    }


def parse_inventory_text(raw: str) -> dict[str, Any]:
    text = scrub_raw_text(raw)
    ymm = extract_year_make_model(text)
    return {
        "vin": extract_vin(text),
        "year": ymm["year"] or extract_year(text),
        "make": ymm["make"],
        "model": ymm["model"],
        "price": extract_price(text),
        "mileage": extract_mileage(text),
        "stock_number": extract_stock_number(text),
        "exterior_color": extract_exterior_color(text),
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
    """Fill missing VIN/year/make/model/price/mileage/stock from regex parses.

    Price and mileage are always coerced to pure integers (e.g. 29995, 45210).
    """
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
            "make",
            "model",
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

    make = _as_str(vehicle.get("make")) or _as_str(parsed.get("make"))
    model = _as_str(vehicle.get("model")) or _as_str(parsed.get("model"))

    # Moses Stock: from blob wins immediately — never fall through to Unavailable.
    moses_stock = extract_stock_number(blob) if blob else None
    stock = _clean_stock_candidate(
        _as_str(vehicle.get("stock_number") or vehicle.get("stockNumber"))
    ) or ""
    if not stock and moses_stock:
        stock = moses_stock
    if not stock:
        stock = parsed["stock_number"] or ""
    if stock and _YEAR_ONLY_RE.fullmatch(stock):
        stock = ""
    if stock and year and stock == str(year):
        stock = ""
    if stock and len(stock) == 17 and VIN_RE.fullmatch(stock):
        stock = ""
    # Re-apply Moses Stock: after year/VIN rejection so HT60208 is never lost.
    if not stock and moses_stock:
        stock = moses_stock

    link = (
        _as_str(vehicle.get("link"))
        or _as_str(vehicle.get("vdp_url"))
        or _as_str(vehicle.get("vdpUrl"))
        or _as_str(vehicle.get("url"))
        or _as_str(vehicle.get("href"))
    )

    # Order: explicit/labeled (incl. Stock:) → VDP URL → In Transit → Unavailable.
    if not stock and link:
        stock = extract_stock_from_url(link, year=year, vin=vin) or ""
    if not stock:
        status_blob = " ".join(
            _as_str(vehicle.get(k))
            for k in (
                "raw", "raw_html", "raw_text", "description", "title",
                "availability", "status_label", "badge", "vehicle_status",
            )
        )
        if _IN_TRANSIT_RE.search(status_blob) or _IN_TRANSIT_RE.search(blob):
            stock = IN_TRANSIT_STOCK
        else:
            stock = MISSING_STOCK

    color = (
        _as_str(vehicle.get("exterior_color"))
        or _as_str(vehicle.get("exteriorColor"))
        or _as_str(vehicle.get("extColor"))
        or _as_str(vehicle.get("color"))
        or _as_str(parsed.get("exterior_color"))
        or (extract_exterior_color(blob) or "")
    )

    cond = _as_str(vehicle.get("condition")).title()
    # New + missing mileage → 0
    if mileage <= 0 and cond == "New":
        mileage = 0
    elif mileage <= 0 and parsed.get("mileage") is not None:
        mileage = int(parsed["mileage"] or 0)
    image = (
        _as_str(vehicle.get("image_url"))
        or _as_str(vehicle.get("imageUrl"))
        or _as_str(vehicle.get("image_link"))
        or _as_str(vehicle.get("image"))
    )

    out = dict(vehicle)
    out["vin"] = vin
    out["year"] = int(year or 0)
    out["make"] = make
    out["model"] = model
    out["price"] = int(price or 0)
    out["mileage"] = int(mileage or 0)
    out["stock_number"] = stock or MISSING_STOCK
    out["stockNumber"] = out["stock_number"]
    if color:
        out["exterior_color"] = color
        out["exteriorColor"] = color
        out["color"] = color
    if image:
        out["image_url"] = image
        out["imageUrl"] = image
        out["image_link"] = image
    if link:
        out["link"] = link
        out["vdp_url"] = link
        out["vdpUrl"] = link
    return out


def sanitize_inventory_list(rows: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not rows:
        return []
    return [sanitize_vehicle_record(r) for r in rows if isinstance(r, dict)]


def parse_vehicles_from_html(
    html_text: str,
    *,
    condition: str = "",
) -> list[dict[str, Any]]:
    """DOM strip + card isolate + regex sanitize (preferred scraper entry)."""
    try:
        from dom_inventory import parse_inventory_html
    except ImportError:
        # Minimal fallback when dom_inventory is unavailable.
        return [sanitize_vehicle_record({}, html_text)]
    return parse_inventory_html(html_text, condition=condition)
