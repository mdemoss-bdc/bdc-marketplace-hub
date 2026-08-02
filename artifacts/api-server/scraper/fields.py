"""DealerOn / Moses SRP field extractors (color, mileage, price).

Selectors mapped from ``moses_layout.txt`` (mosescars.com DealerOn Sephora /
Wasabi SRP CSS + markup):

  Color   — .vehicle-colors__ext .vehicle-colors__value
            .specs__color-label / .specs__value
            Ext. / Exterior labels, data-color
  Mileage — .vehicle-mileage  ("12 mi" / "28,450 mi.")
  Price   — .vehiclePricingHighlightAmount (+ .featuredPrice)
            .priceBlocItemPriceValue / .priceBlocItemPriceLabel
            MOSES PRICE / INTERNET PRICE / OUR PRICE / TSRP labels
"""

from __future__ import annotations

import re
from typing import Any

from .html_utils import clean_text, decode_entities

# ── Exterior color (moses_layout.txt) ───────────────────────────────────────
# Primary: vehicle-colors__ext > vehicle-colors__value
_COLORS_EXT_VALUE_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-colors__ext\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,400}?'
    r'class=["\'][^"\']*\bvehicle-colors__value\b[^"\']*["\'][^>]*>'
    r'\s*([^<]{2,48})\s*<',
    re.I,
)
# Fallback: any vehicle-colors__value (prefer first / Ext block)
_COLORS_VALUE_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-colors__value\b[^"\']*["\'][^>]*>'
    r'\s*([^<]{2,48})\s*<',
    re.I,
)
# specs__color-label + sibling specs__value
_SPECS_COLOR_RE = re.compile(
    r'class=["\'][^"\']*\bspecs__color-label\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,80}?'
    r'class=["\'][^"\']*\bspecs__value\b[^"\']*["\'][^>]*>'
    r'\s*([^<]{2,48})\s*<',
    re.I,
)
_EXT_COLOR_CLASS_TEXT_RE = re.compile(
    r'class=["\'][^"\']*\b(?:ext-color|exterior-color|extColor|exteriorColor)\b[^"\']*["\']'
    r'[^>]*>\s*([^<]{2,48})\s*<',
    re.I,
)
_DATA_COLOR_RE = re.compile(
    r'data-(?:exterior-color|ext-color|color)\s*=\s*["\']([^"\']+)["\']',
    re.I,
)
_EXT_COLOR_LABEL_RE = re.compile(
    r"(?:Ext(?:erior)?(?:\s*Color)?|Ext\.)\s*[:.]?\s*"
    r"([A-Za-z][A-Za-z0-9 \-/]{1,40})",
    re.I,
)
# ePrice modal: <span class="vehColor">Color: </span><span id="eprice_vehColor">…
_VEH_COLOR_RE = re.compile(
    r'(?:class=["\'][^"\']*\bvehColor\b[^"\']*["\'][^>]*>\s*Color\s*:?\s*</[^>]+>\s*'
    r'<[^>]+>\s*([^<]{2,48})\s*<)'
    r'|(?:Color\s*:\s*([A-Za-z][A-Za-z0-9 \-/]{1,40}))',
    re.I,
)
_BAD_COLOR_RE = re.compile(
    r"^(?:n/?a|none|unknown|select|color|ext\.?|int\.?|interior)$",
    re.I,
)

# ── Mileage (moses_layout.txt: .vehicle-mileage) ────────────────────────────
_VEHICLE_MILEAGE_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-mileage\b[^"\']*["\'][^>]*>'
    r'\s*([0-9,]+\s*(?:mi\.?|miles)?)\s*<',
    re.I,
)
_MILES_DOM_RE = re.compile(
    r'class=["\'][^"\']*\b(?:mileage-number|mileage|odometer|vehicle-mileage)\b[^"\']*["\']'
    r'[^>]*>\s*([0-9,]+)',
    re.I,
)
_MILES_RE = re.compile(r"([0-9,]+)\s*(?:mi\.?|miles)\b", re.I)

# ── Price (moses_layout.txt: vehiclePricingStack / priceBloc*) ──────────────
_HIGHLIGHT_AMOUNT_RE = re.compile(
    r'class=["\'][^"\']*\bvehiclePricingHighlightAmount\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_FEATURED_HIGHLIGHT_RE = re.compile(
    r'class=["\'][^"\']*\bfeaturedPrice\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,300}?'
    r'class=["\'][^"\']*\bvehiclePricingHighlightAmount\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_PRICE_BLOC_VALUE_RE = re.compile(
    r'class=["\'][^"\']*\bpriceBlocItemPriceValue\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_PRICE_BLOC_LABELED_RE = re.compile(
    r'class=["\'][^"\']*\bpriceBlocItemPriceLabel\b[^"\']*["\'][^>]*>'
    r'\s*([^<]{0,40})</[^>]+>\s*'
    r'<[^>]*class=["\'][^"\']*\bpriceBlocItemPriceValue\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_PRICE_LABEL_RE = re.compile(
    r"(?:MOSES\s+PRICE|INTERNET\s+PRICE|OUR\s+PRICE|TSRP)\s*:?\s*\$?\s*"
    r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})",
    re.I,
)
_PRICE_CARD_RE = re.compile(r"\$([0-9]{2,3},[0-9]{3})")
# DealerOn dynamic grid extras (inventory-spec-list / priceStak / final-price)
_PRICE_STAK_FINAL_RE = re.compile(
    r'class=["\'][^"\']*\b(?:priceStak-final-price|final-price)\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,200}?'
    r'(?:class=["\'][^"\']*\bvalue\b[^"\']*["\'][^>]*>\s*)?'
    r'\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})',
    re.I,
)
_FINAL_PRICE_VALUE_RE = re.compile(
    r'class=["\'][^"\']*\bfinal-price\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,160}?'
    r'class=["\'][^"\']*\bvalue\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_SPEC_LIST_EXT_RE = re.compile(
    r'class=["\'][^"\']*\b(?:inventory-spec-list|specs)\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,600}?'
    r'(?:Ext(?:erior)?(?:\s*Color)?|Ext\.)\s*[:.]?\s*'
    r'([A-Za-z][A-Za-z0-9 \-/]{1,40})',
    re.I,
)


def _plain(html_or_text: str) -> str:
    text = decode_entities(html_or_text or "")
    return clean_text(re.sub(r"<[^>]+>", " ", text))


def _ok_color(value: str) -> str:
    c = clean_text(value)
    if not c or _BAD_COLOR_RE.match(c):
        return ""
    # Trim trailing noise (VIN / Stock / mileage / price fragments)
    c = re.split(
        r"\s+(?:Stock|VIN|Mi\.?|Miles?|\$|\d{1,3}(?:,\d{3})*(?:\s*(?:mi\.?|miles))?)\b",
        c,
        maxsplit=1,
        flags=re.I,
    )[0].strip()
    if not c or _BAD_COLOR_RE.match(c):
        return ""
    return c


def extract_exterior_color(html_or_text: str) -> str:
    """Pull exterior color from Moses vehicle-colors / specs / Ext. labels."""
    text = decode_entities(html_or_text or "")
    if not text:
        return ""

    for rx in (
        _COLORS_EXT_VALUE_RE,
        _SPECS_COLOR_RE,
        _COLORS_VALUE_RE,
        _EXT_COLOR_CLASS_TEXT_RE,
        _SPEC_LIST_EXT_RE,
    ):
        m = rx.search(text)
        if m:
            c = _ok_color(m.group(1))
            if c:
                return c

    m = _DATA_COLOR_RE.search(text)
    if m:
        c = _ok_color(m.group(1))
        if c:
            return c

    m = _VEH_COLOR_RE.search(text)
    if m:
        c = _ok_color(m.group(1) or m.group(2) or "")
        if c:
            return c

    plain = _plain(text)
    m = _EXT_COLOR_LABEL_RE.search(plain)
    if m:
        c = _ok_color(m.group(1))
        if c:
            return c
    return ""


def extract_mileage(html_or_text: str, *, condition: str = "Used") -> int:
    """Extract mileage; New vehicles with omitted odometer default to 0."""
    text = decode_entities(html_or_text or "")

    m = _VEHICLE_MILEAGE_RE.search(text) if text else None
    if m:
        digits = re.search(r"([0-9,]+)", m.group(1) or "")
        if digits:
            try:
                n = int(digits.group(1).replace(",", ""))
                if 0 <= n <= 1_000_000:
                    return n
            except ValueError:
                pass

    m = _MILES_DOM_RE.search(text) if text else None
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if 0 <= n <= 1_000_000:
                return n
        except ValueError:
            pass

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


def _price_ok(n: int) -> bool:
    return 500 <= n <= 5_000_000 and not (1900 <= n <= 2100)


def extract_price(html_or_text: str) -> int:
    """Prefer featured highlight / priceBloc / MOSES PRICE, then $NN,NNN."""
    text = decode_entities(html_or_text or "")
    plain = _plain(html_or_text)

    # 0) DealerOn priceStak / final-price .value
    for rx in (_FINAL_PRICE_VALUE_RE, _PRICE_STAK_FINAL_RE):
        m = rx.search(text)
        if m:
            try:
                n = int(m.group(1).replace(",", ""))
                if _price_ok(n):
                    return n
            except ValueError:
                pass

    # 1) featuredPrice → vehiclePricingHighlightAmount
    m = _FEATURED_HIGHLIGHT_RE.search(text)
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if _price_ok(n):
                return n
        except ValueError:
            pass

    # 2) priceBloc label/value pairs — prefer selling labels
    for m in _PRICE_BLOC_LABELED_RE.finditer(text):
        label = (m.group(1) or "").lower()
        if any(k in label for k in ("retail", "msrp", "sticker", "list", "doc fee")):
            continue
        try:
            n = int(m.group(2).replace(",", ""))
            if _price_ok(n):
                return n
        except ValueError:
            pass

    # 3) Any vehiclePricingHighlightAmount / priceBlocItemPriceValue
    for rx in (_HIGHLIGHT_AMOUNT_RE, _PRICE_BLOC_VALUE_RE):
        m = rx.search(text)
        if m:
            try:
                n = int(m.group(1).replace(",", ""))
                if _price_ok(n):
                    return n
            except ValueError:
                pass

    # 4) Labeled text (MOSES PRICE / OUR PRICE / …)
    for label in (
        r"MOSES\s+PRICE",
        r"OUR\s+PRICE",
        r"INTERNET\s+PRICE",
        r"TSRP",
    ):
        wm = re.search(
            rf"({label}).{{0,40}}\$([0-9]{{2,3}},[0-9]{{3}})",
            plain,
            re.I,
        ) or re.search(
            rf"({label}).{{0,40}}\$([0-9]{{2,3}},[0-9]{{3}})",
            text,
            re.I,
        )
        if wm:
            try:
                n = int(wm.group(2).replace(",", ""))
                if _price_ok(n):
                    return n
            except ValueError:
                pass

    m = _PRICE_LABEL_RE.search(plain) or _PRICE_LABEL_RE.search(text)
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if _price_ok(n):
                return n
        except ValueError:
            pass

    m = _PRICE_CARD_RE.search(plain) or _PRICE_CARD_RE.search(text)
    if m:
        try:
            n = int(m.group(1).replace(",", ""))
            if _price_ok(n):
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
