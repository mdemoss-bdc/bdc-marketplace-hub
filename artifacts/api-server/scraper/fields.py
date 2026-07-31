"""DealerOn / Moses SRP field extractors (color, mileage, price).

Used by tier1/tier2 and normalize_vehicle when structured data-* attrs are empty.
"""

from __future__ import annotations

import re
from typing import Any

from .html_utils import clean_text, decode_entities

# ── Exterior color ───────────────────────────────────────────────────────────
_EXT_COLOR_LABEL_RE = re.compile(
    r"(?:Ext(?:erior)?(?:\s*Color)?|Ext\.)\s*[:.]?\s*"
    r"([A-Za-z][A-Za-z0-9 \-/]{1,40})",
    re.I,
)
_EXT_COLOR_DOM_RE = re.compile(
    r'(?:class=["\'][^"\']*\b(?:ext-color|exterior-color|extColor|exteriorColor)\b[^"\']*["\']|'
    r'data-color\s*=\s*["\']([^"\']+)["\'])'
    r'[^>]*(?:>([^<]{2,48})<|["\'])',
    re.I,
)
_EXT_COLOR_CLASS_TEXT_RE = re.compile(
    r'class=["\'][^"\']*\b(?:ext-color|exterior-color|extColor|exteriorColor)\b[^"\']*["\']'
    r'[^>]*>\s*([^<]{2,48})\s*<',
    re.I,
)
_DATA_COLOR_RE = re.compile(r'data-color\s*=\s*["\']([^"\']+)["\']', re.I)
_BAD_COLOR_RE = re.compile(r"^(?:n/?a|none|unknown|select|color|ext\.?)$", re.I)

# ── Mileage ──────────────────────────────────────────────────────────────────
# Prefer "12,345 mi" / "12,345 mi." (Moses DealerOn SRP).
_MILES_RE = re.compile(r"([0-9,]+)\s*mi\.?\b", re.I)

# ── Price ────────────────────────────────────────────────────────────────────
_PRICE_LABEL_RE = re.compile(
    r"(?:MOSES\s+PRICE|INTERNET\s+PRICE|OUR\s+PRICE|TSRP)\s*:?\s*\$?\s*"
    r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})",
    re.I,
)
# Card-local dollar amounts like $32,995 or $9,995
_PRICE_CARD_RE = re.compile(r"\$([0-9]{2,3},[0-9]{3})")


def _plain(html_or_text: str) -> str:
    text = decode_entities(html_or_text or "")
    return clean_text(re.sub(r"<[^>]+>", " ", text))


def extract_exterior_color(html_or_text: str) -> str:
    """Pull exterior color from Ext./Exterior labels or .ext-color / [data-color]."""
    text = decode_entities(html_or_text or "")
    if not text:
        return ""

    m = _DATA_COLOR_RE.search(text)
    if m:
        c = clean_text(m.group(1))
        if c and not _BAD_COLOR_RE.match(c):
            return c

    m = _EXT_COLOR_CLASS_TEXT_RE.search(text)
    if m:
        c = clean_text(m.group(1))
        if c and not _BAD_COLOR_RE.match(c):
            return c

    plain = _plain(text)
    m = _EXT_COLOR_LABEL_RE.search(plain)
    if m:
        c = clean_text(m.group(1))
        # Trim trailing noise (VIN / Stock / price fragments)
        c = re.split(r"\s+(?:Stock|VIN|Mi\.?|Miles|\$)\b", c, maxsplit=1, flags=re.I)[0].strip()
        if c and not _BAD_COLOR_RE.match(c):
            return c
    return ""


def extract_mileage(html_or_text: str, *, condition: str = "Used") -> int:
    """Extract mileage; New vehicles with omitted odometer default to 0."""
    plain = _plain(html_or_text)
    m = _MILES_RE.search(plain)
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if 0 <= n <= 1_000_000:
                return n
        except ValueError:
            pass
    # New + missing miles → 0 (never invent used-car mileage)
    cond = (condition or "Used").strip().title()
    if cond == "New":
        return 0
    return 0


def extract_price(html_or_text: str) -> int:
    """Prefer MOSES/INTERNET/OUR PRICE / TSRP labels, then $NN,NNN card amounts."""
    plain = _plain(html_or_text)
    m = _PRICE_LABEL_RE.search(plain) or _PRICE_LABEL_RE.search(html_or_text or "")
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if 500 <= n <= 5_000_000 and not (1900 <= n <= 2100):
                return n
        except ValueError:
            pass
    m = _PRICE_CARD_RE.search(plain) or _PRICE_CARD_RE.search(html_or_text or "")
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if 500 <= n <= 5_000_000 and not (1900 <= n <= 2100):
                return n
        except ValueError:
            pass
    return 0


def enrich_from_html(
    raw: dict[str, Any],
    html_fragment: str,
    *,
    condition: str = "Used",
) -> dict[str, Any]:
    """Fill missing color / mileage / price on a raw vehicle dict from HTML."""
    out = dict(raw)
    html = html_fragment or str(out.get("_html") or "")
    if not html:
        return out

    if not (out.get("exteriorColor") or out.get("exterior_color") or out.get("color")):
        color = extract_exterior_color(html)
        if color:
            out["exteriorColor"] = color
            out["exterior_color"] = color

    miles_present = out.get("mileage") not in (None, "",)
    try:
        miles_n = int(str(out.get("mileage") or "0").replace(",", ""))
    except ValueError:
        miles_n = 0
    if not miles_present or miles_n <= 0:
        extracted = extract_mileage(html, condition=condition)
        # Always set for New (0) so omitted odometer is explicit.
        if extracted > 0 or (condition or "").strip().title() == "New":
            out["mileage"] = extracted

    try:
        price_n = int(str(out.get("price") or "0").replace(",", "").replace("$", ""))
    except ValueError:
        price_n = 0
    if price_n <= 0:
        price = extract_price(html)
        if price > 0:
            out["price"] = price

    return out
