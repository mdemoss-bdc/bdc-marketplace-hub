"""Scraper Gauntlet Matrix — strict multi-platform per-vehicle fill order.

Every vehicle card is run through the same platform-agnostic gauntlet until
``stockNumber``, ``exteriorColor``, ``price``, ``mileage``, and ``vin`` hold
true data. Steps never overwrite a successful fill with empty / Unavailable.

Order (strict):
  1. Schema JSON-LD (Product / Vehicle / Car, incl. @graph)
  2. DealerOn Dynamic Grid (+ Cosmos API when SRP is an empty skeleton)
  3. Dealertrack / Sincro (data-* + pricing classes)
  4. Physical text regex brute-force
  5. Optional enrichment (documented): VDP hydrate / URL stock / In Transit
     — applied by the pipeline after steps 1–4; never mangles ``link``.

Stock becomes ``"Unavailable"`` only when every stock-capable step fails.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

from .cosmos import (
    extract_cosmos_inventory,
    looks_like_skeleton_srp,
    parse_srp_config_from_html,
)
from .fields import (
    enrich_from_html,
    extract_exterior_color,
    extract_mileage,
    extract_price,
)
from .html_utils import absolutize, clean_text, decode_entities
from .schema import VIN_RE, normalize_vehicle
from .stock import (
    MISSING_STOCK,
    extract_stock_from_html,
    extract_stock_from_url,
    resolve_stock_number,
    sanitize_stock_number,
)

# Critical gauntlet targets — cycle until these are true data.
GAUNTLET_FIELDS = ("stockNumber", "exteriorColor", "price", "mileage", "vin")

_LD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
    re.I,
)

# DealerOn / Moses dynamic grid (step 2)
_PRICE_STAK_FINAL_RE = re.compile(
    r'class=["\'][^"\']*\b(?:priceStak-final-price|final-price)\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,200}?'
    r'(?:class=["\'][^"\']*\bvalue\b[^"\']*["\'][^>]*>\s*)?'
    r'\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})',
    re.I,
)
_INVENTORY_SPEC_STOCK_RE = re.compile(
    r'class=["\'][^"\']*\b(?:inventory-spec-list|specs)\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,800}?',
    re.I,
)
_STOCK_COLON_RE = re.compile(r"Stock:\s*([A-Z0-9]+)", re.I)
_EXT_PIPE_RE = re.compile(r"Ext:\s*([^|<\n]+)", re.I)
_DOLLAR_RE = re.compile(r"\$[0-9,]+")

# Dealertrack / Sincro (step 3)
_DATA_VIN_RE = re.compile(r'data-vin\s*=\s*["\']([A-HJ-NPR-Z0-9]{17})["\']', re.I)
_DATA_STOCK_RE = re.compile(
    r'data-stock(?:-number|-no|number|num)?\s*=\s*["\']([^"\']+)["\']',
    re.I,
)
_DATA_PRICE_RE = re.compile(
    r'data-(?:price|internet-price|final-price|msrp)\s*=\s*["\']([^"\']+)["\']',
    re.I,
)
_DATA_COLOR_RE = re.compile(
    r'data-(?:color|ext-color|exterior-color)\s*=\s*["\']([^"\']+)["\']',
    re.I,
)
_DATA_MILES_RE = re.compile(
    r'data-(?:mileage|miles|odometer)\s*=\s*["\']([^"\']+)["\']',
    re.I,
)
_VDP_PRICE_RE = re.compile(
    r'class=["\'][^"\']*\b(?:vdp-price|sincro-pricing)\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,240}?\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})',
    re.I,
)
_SINCRO_STATE_PATTERNS = (
    r'window\.SRP_DATA\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|//|</script>)',
    r'window\.SERVER_DATA\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|//|</script>)',
    r'window\.initialState\s*=\s*(\{[\s\S]+?\});\s*(?:window|var|//|</script>)',
    r'<script[^>]*id=["\']__NEXT_DATA__["\'][^>]*>([\s\S]+?)</script>',
)

# Step 4 — physical text brute-force
_BF_STOCK_RE = re.compile(
    r"(?:stk|stock)\s*#?\s*:?\s*([a-z0-9\-]+)",
    re.I,
)
_BF_COLOR_RE = re.compile(
    r"(?:ext(?:erior)?(?:\s*color)?|exterior)\s*:?\s*([a-z\s]+)",
    re.I,
)
_BF_PRICE_RE = re.compile(r"\$([0-9]{2,3},[0-9]{3})")
_BF_MILES_RE = re.compile(
    r"(?:odometer\s*:?\s*)?([0-9,]+)\s*(?:mi\.?|miles)\b|"
    r"(?:odometer|mileage)\s*:?\s*([0-9,]+)",
    re.I,
)

_CARD_OPEN_RE = re.compile(
    r'<(?P<tag>div|li|article|section)(?P<attrs>[^>]*('
    r'data-vin=|data-vehicle|data-year=|data-stock=|'
    r'class=["\'][^"\']*\b(?:vehicle-card|el-vehicle-card|srp-vehicle|'
    r'inventory-card|listing-card|sincro)\b[^"\']*["\']'
    r')[^>]*)>',
    re.I,
)
_TAG_OPEN_RE = re.compile(r"<(?P<tag>[a-zA-Z][\w:-]*)([^>]*)>", re.I)
_VOID_TAGS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})
_VDP_HREF_RE = re.compile(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>', re.I)
_VDP_PATH_HINT = re.compile(
    r"(?:vehicle|inventory|vdp|detail|used|new).{0,80}"
    r"(?:[A-HJ-NPR-Z0-9]{17}|/\d{4}-)",
    re.I,
)
_TITLE_YEAR_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-title__year\b[^"\']*["\'][^>]*>\s*(\d{4})\s*<',
    re.I,
)
_TITLE_MAKE_MODEL_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-title__make-model\b[^"\']*["\'][^>]*>'
    r'\s*([^<]{2,60})\s*<',
    re.I,
)
_YMM_RE = re.compile(
    r"\b((?:19|20)\d{2})\s+([A-Z][A-Za-z0-9\-]+)\s+"
    r"([A-Z0-9][A-Za-z0-9\-]+)",
)


# ── Missing-field helpers ────────────────────────────────────────────────────

def _digits(value: Any) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        n = int(value)
        return n if n > 0 else 0
    m = re.search(r"([\d,]+(?:\.\d+)?)", str(value).replace("$", ""))
    if not m:
        return 0
    try:
        n = int(float(m.group(1).replace(",", "")))
    except ValueError:
        return 0
    if 1900 <= n <= 2100:
        return 0
    return n if n > 0 else 0


def _str(value: Any) -> str:
    if value is None:
        return ""
    return clean_text(value)


def vin_missing(vehicle: dict[str, Any]) -> bool:
    vin = _str(vehicle.get("vin")).upper()
    if not vin or len(vin) < 10:
        return True
    # Synthetic IT*/UV* ids are placeholders — keep hunting for a real VIN.
    if re.fullmatch(r"(?:IT|UV)[A-F0-9]{12}", vin):
        return True
    return False


def stock_missing(vehicle: dict[str, Any]) -> bool:
    stock = _str(
        vehicle.get("stockNumber") or vehicle.get("stock_number") or vehicle.get("stock")
    )
    if not stock:
        return True
    return stock.lower() in {
        "unavailable", "n/a", "na", "none", "-", "—", "null", "undefined",
    } or stock == MISSING_STOCK


def color_missing(vehicle: dict[str, Any]) -> bool:
    color = _str(
        vehicle.get("exteriorColor")
        or vehicle.get("exterior_color")
        or vehicle.get("color")
    )
    return not color or color.lower() in {"n/a", "na", "none", "-", "—", "unavailable"}


def price_missing(vehicle: dict[str, Any]) -> bool:
    return _digits(vehicle.get("price")) <= 0


def mileage_missing(vehicle: dict[str, Any], *, condition: str = "Used") -> bool:
    if vehicle.get("_mileage_resolved"):
        return False
    raw = vehicle.get("mileage")
    if raw in (None, ""):
        return True
    try:
        n = int(str(raw).replace(",", ""))
    except (TypeError, ValueError):
        return True
    if n > 0:
        return False
    # Explicit 0 is true data for New inventory.
    return (condition or "Used").strip().title() != "New"


def gauntlet_incomplete(vehicle: dict[str, Any], *, condition: str = "Used") -> bool:
    """True while any critical field still lacks true data."""
    return (
        vin_missing(vehicle)
        or stock_missing(vehicle)
        or color_missing(vehicle)
        or price_missing(vehicle)
        or mileage_missing(vehicle, condition=condition)
    )


def gauntlet_complete(vehicle: dict[str, Any], *, condition: str = "Used") -> bool:
    return not gauntlet_incomplete(vehicle, condition=condition)


def apply_fill(vehicle: dict[str, Any], patch: dict[str, Any], *, condition: str = "Used") -> dict[str, Any]:
    """Merge ``patch`` into ``vehicle`` — never clobber true data with empties."""
    out = dict(vehicle)
    cond = (condition or out.get("condition") or "Used")
    if isinstance(cond, str):
        cond = cond.strip().title()
    else:
        cond = "Used"

    if vin_missing(out):
        vin = _str(patch.get("vin")).upper()
        if vin and len(vin) >= 10 and not re.fullmatch(r"(?:IT|UV)[A-F0-9]{12}", vin):
            out["vin"] = vin

    if stock_missing(out):
        stock = sanitize_stock_number(
            patch.get("stockNumber") or patch.get("stock_number") or patch.get("stock") or "",
            vin=_str(out.get("vin")),
            year=out.get("year") or 0,
        )
        if stock and stock != MISSING_STOCK:
            out["stockNumber"] = stock
            out["stock_number"] = stock

    if color_missing(out):
        color = _str(
            patch.get("exteriorColor")
            or patch.get("exterior_color")
            or patch.get("color")
        )
        if color and color.lower() not in {"n/a", "na", "none", "-", "unavailable"}:
            out["exteriorColor"] = color
            out["exterior_color"] = color

    if price_missing(out):
        price = _digits(patch.get("price"))
        if price > 0:
            out["price"] = price

    if mileage_missing(out, condition=cond):
        if patch.get("_mileage_resolved") or patch.get("mileage") not in (None, ""):
            try:
                miles = int(str(patch.get("mileage") or 0).replace(",", ""))
            except (TypeError, ValueError):
                miles = _digits(patch.get("mileage"))
            if miles > 0 or cond == "New":
                out["mileage"] = max(0, miles)
                out["_mileage_resolved"] = True

    # Non-critical identity / media — fill only when empty; never touch good link.
    for src, dests in (
        ("year", ("year",)),
        ("make", ("make",)),
        ("model", ("model",)),
        ("trim", ("trim",)),
        ("imageUrl", ("imageUrl", "image_url")),
        ("title", ("title",)),
    ):
        val = patch.get(src)
        if val in (None, "", 0):
            continue
        for d in dests:
            if not out.get(d):
                out[d] = val

    link = _str(patch.get("link") or patch.get("vdp_url") or patch.get("vdpUrl"))
    if link and not _str(out.get("link") or out.get("vdp_url")):
        out["link"] = link
        out["vdp_url"] = link
        out["vdpUrl"] = link

    if patch.get("_html") and not out.get("_html"):
        out["_html"] = patch["_html"]

    out["condition"] = cond
    return out


# ── HTML card helpers ────────────────────────────────────────────────────────

def _extract_balanced_fragment(text: str, start: int, tag: str) -> str:
    tag_l = tag.lower()
    i = start
    depth = 0
    n = len(text)
    while i < n:
        lt = text.find("<", i)
        if lt < 0:
            break
        if text.startswith("</", lt):
            close = re.match(r"</([a-zA-Z][\w:-]*)\s*>", text[lt:], re.I)
            if not close:
                i = lt + 1
                continue
            if close.group(1).lower() == tag_l:
                depth -= 1
                end = lt + close.end()
                if depth == 0:
                    return text[start:end]
                i = end
                continue
            i = lt + close.end()
            continue
        if text.startswith("<!--", lt):
            end = text.find("-->", lt + 4)
            i = n if end < 0 else end + 3
            continue
        om = _TAG_OPEN_RE.match(text, lt)
        if not om:
            i = lt + 1
            continue
        t = om.group("tag").lower()
        raw_attrs = om.group(2) or ""
        self_close = raw_attrs.rstrip().endswith("/") or t in _VOID_TAGS
        if t == tag_l and not self_close:
            depth += 1
        i = om.end()
    return text[start:min(n, start + 14000)]


def iter_vehicle_cards(html: str) -> list[str]:
    """Yield vehicle-card HTML fragments (skip skeleton placeholders)."""
    text = decode_entities(html or "")
    cards: list[str] = []
    for m in _CARD_OPEN_RE.finditer(text):
        attrs = m.group("attrs") or ""
        if re.search(r"\bskeleton\b", attrs, re.I):
            continue
        frag = _extract_balanced_fragment(text, m.start(), m.group("tag"))
        if len(frag) >= 80:
            cards.append(frag)
    return cards


def _plain(html_or_text: str) -> str:
    text = decode_entities(html_or_text or "")
    return clean_text(re.sub(r"<[^>]+>", " ", text))


def _link_from_card(card: str, base_url: str) -> str:
    for hm in _VDP_HREF_RE.finditer(card):
        href = absolutize(hm.group(1), base_url)
        if href and (_VDP_PATH_HINT.search(href) or VIN_RE.search(href)):
            return href
    for hm in _VDP_HREF_RE.finditer(card):
        href = absolutize(hm.group(1), base_url)
        if href and href.rstrip("/") != (base_url or "").rstrip("/"):
            return href
    return ""


def _seed_from_card(card: str, base_url: str, *, condition: str) -> dict[str, Any]:
    seed: dict[str, Any] = {"_html": card, "condition": condition}
    vm = _DATA_VIN_RE.search(card) or VIN_RE.search(card)
    if vm:
        seed["vin"] = vm.group(1).upper()
    ym = _TITLE_YEAR_RE.search(card)
    if ym:
        seed["year"] = int(ym.group(1))
    mm = _TITLE_MAKE_MODEL_RE.search(card)
    if mm:
        parts = clean_text(mm.group(1)).split()
        if parts:
            seed["make"] = parts[0]
            if len(parts) > 1:
                seed["model"] = parts[1]
    if not seed.get("year") or not seed.get("make"):
        plain = _plain(card)
        ymm = _YMM_RE.search(plain)
        if ymm:
            seed.setdefault("year", int(ymm.group(1)))
            seed.setdefault("make", ymm.group(2))
            seed.setdefault("model", ymm.group(3))
    link = _link_from_card(card, base_url)
    if link:
        seed["link"] = link
    img = re.search(
        r'<img[^>]+(?:src|data-src|data-lazy|data-original)=["\']([^"\']+)["\']',
        card,
        re.I,
    )
    if img:
        seed["imageUrl"] = absolutize(img.group(1), base_url)
    return seed


# ── STEP 1 — Schema JSON-LD ──────────────────────────────────────────────────

def _mileage_from_ld(node: dict[str, Any]) -> tuple[int | None, bool]:
    miles = node.get("mileageFromOdometer")
    if isinstance(miles, dict):
        miles = miles.get("value")
    if miles is None:
        miles = node.get("mileage")
    if miles in (None, ""):
        return None, False
    try:
        n = int(float(str(miles).replace(",", "")))
    except (TypeError, ValueError):
        return None, False
    return max(0, n), True


def _walk_ld_patches(node: Any, out: list[dict[str, Any]]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk_ld_patches(item, out)
        return
    if not isinstance(node, dict):
        return
    if "@graph" in node:
        _walk_ld_patches(node.get("@graph"), out)
    types = node.get("@type") or node.get("type") or ""
    if isinstance(types, list):
        types_l = " ".join(str(t) for t in types).lower()
    else:
        types_l = str(types).lower()
    if any(t in types_l for t in ("car", "vehicle", "product")):
        offer = node.get("offers") or {}
        if isinstance(offer, list) and offer:
            offer = offer[0] if isinstance(offer[0], dict) else {}
        if not isinstance(offer, dict):
            offer = {}
        brand = node.get("brand")
        make = ""
        if isinstance(brand, dict):
            make = str(brand.get("name") or "")
        elif isinstance(brand, str):
            make = brand
        miles, miles_ok = _mileage_from_ld(node)
        vin = _str(
            node.get("vehicleIdentificationNumber") or node.get("vin") or ""
        ).upper()
        # sku/mpn are stock — not VIN (unless they look like a VIN).
        sku = node.get("sku") or node.get("mpn") or node.get("productID")
        stock = ""
        if sku:
            sku_s = _str(sku).upper()
            if VIN_RE.fullmatch(sku_s) and not vin:
                vin = sku_s
            else:
                stock = sanitize_stock_number(sku) or ""
        year = (
            node.get("productionDate")
            or node.get("modelDate")
            or node.get("vehicleModelDate")
        )
        patch: dict[str, Any] = {
            "vin": vin,
            "year": year,
            "make": make or node.get("manufacturer") or "",
            "model": node.get("model") or "",
            "trim": node.get("vehicleConfiguration") or node.get("trim") or "",
            "price": offer.get("price") or node.get("price"),
            "exteriorColor": node.get("color") or node.get("vehicleExteriorColor") or "",
            "stockNumber": stock,
            "link": node.get("url") or offer.get("url") or "",
            "imageUrl": (
                node.get("image")[0]
                if isinstance(node.get("image"), list) and node.get("image")
                else node.get("image") or ""
            ),
            "_gauntlet_step": 1,
        }
        if miles_ok:
            patch["mileage"] = miles
            patch["_mileage_resolved"] = True
        if patch.get("vin") or patch.get("stockNumber") or patch.get("price") or patch.get("link"):
            out.append(patch)
    for v in node.values():
        if isinstance(v, (dict, list)) and v is not node.get("@graph"):
            _walk_ld_patches(v, out)


def parse_schema_jsonld(html: str) -> list[dict[str, Any]]:
    """STEP 1 — extract Product/Vehicle/Car patches from JSON-LD (+ @graph)."""
    out: list[dict[str, Any]] = []
    for m in _LD_RE.finditer(html or ""):
        blob = decode_entities(m.group(1)).strip()
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except Exception:
            try:
                data = json.loads(f"[{blob}]")
            except Exception:
                continue
        _walk_ld_patches(data, out)
    return out


def step1_schema_jsonld(
    vehicle: dict[str, Any],
    html: str,
    *,
    condition: str = "Used",
) -> dict[str, Any]:
    """Fill missing critical fields from Schema.org JSON-LD."""
    if gauntlet_complete(vehicle, condition=condition):
        return vehicle
    patches = parse_schema_jsonld(html)
    if not patches:
        return vehicle
    vin = _str(vehicle.get("vin")).upper()
    link = _str(vehicle.get("link"))
    chosen: dict[str, Any] | None = None
    if vin:
        for p in patches:
            if _str(p.get("vin")).upper() == vin:
                chosen = p
                break
    if chosen is None and link:
        for p in patches:
            pl = _str(p.get("link"))
            if pl and (pl in link or link in pl):
                chosen = p
                break
    if chosen is None and len(patches) == 1:
        chosen = patches[0]
    if chosen is None:
        # Card-scoped JSON-LD: merge first patch that adds any missing field.
        out = vehicle
        for p in patches:
            out = apply_fill(out, p, condition=condition)
            if gauntlet_complete(out, condition=condition):
                return out
        return out
    return apply_fill(vehicle, chosen, condition=condition)


# ── STEP 2 — DealerOn Dynamic Grid (+ Cosmos) ────────────────────────────────

def step2_dealeron_grid(
    vehicle: dict[str, Any],
    card_html: str,
    *,
    condition: str = "Used",
    cosmos_by_vin: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Fill from DealerOn / Moses dynamic-grid selectors; Cosmos by VIN if needed."""
    if gauntlet_complete(vehicle, condition=condition):
        return vehicle
    out = dict(vehicle)
    html = card_html or _str(out.get("_html"))
    patch: dict[str, Any] = {}

    if html:
        # Prefer DealerOn pricing stack / priceStak / final-price.
        if price_missing(out):
            pm = _PRICE_STAK_FINAL_RE.search(html)
            if pm:
                patch["price"] = _digits(pm.group(1))
            if not patch.get("price"):
                patch["price"] = extract_price(html)

        if stock_missing(out):
            sm = _STOCK_COLON_RE.search(_plain(html)) or _STOCK_COLON_RE.search(html)
            if sm:
                cleaned = sanitize_stock_number(sm.group(1), vin=_str(out.get("vin")), year=out.get("year") or 0)
                if cleaned:
                    patch["stockNumber"] = cleaned
            if not patch.get("stockNumber"):
                # inventory-spec-list / ul.specs windows
                for bm in _INVENTORY_SPEC_STOCK_RE.finditer(html):
                    window = html[bm.start():bm.start() + 900]
                    sm2 = _STOCK_COLON_RE.search(_plain(window))
                    if sm2:
                        cleaned = sanitize_stock_number(sm2.group(1))
                        if cleaned:
                            patch["stockNumber"] = cleaned
                            break
                    stock_win = extract_stock_from_html(window)
                    if stock_win and stock_win != MISSING_STOCK:
                        patch["stockNumber"] = stock_win
                        break
            if not patch.get("stockNumber"):
                stock = extract_stock_from_html(
                    html, vin=_str(out.get("vin")), year=out.get("year") or 0,
                )
                if stock and stock != MISSING_STOCK:
                    patch["stockNumber"] = stock

        if color_missing(out):
            em = _EXT_PIPE_RE.search(_plain(html)) or _EXT_PIPE_RE.search(html)
            if em:
                patch["exteriorColor"] = clean_text(em.group(1))
            if not patch.get("exteriorColor"):
                patch["exteriorColor"] = extract_exterior_color(html)

        if mileage_missing(out, condition=condition):
            miles = extract_mileage(html, condition=condition)
            # Only lock mileage when a real reading exists; New+blank → 0 is step 4.
            if miles > 0:
                patch["mileage"] = miles
                patch["_mileage_resolved"] = True

        if vin_missing(out):
            vm = _DATA_VIN_RE.search(html) or VIN_RE.search(html)
            if vm:
                patch["vin"] = vm.group(1).upper()

        # Generic DealerOn enricher (vehicle-colors / vehicle-mileage / pricing)
        enriched = enrich_from_html(
            {**out, **{k: v for k, v in patch.items() if v not in (None, "")}},
            html,
            condition=condition,
        )
        for key in ("exteriorColor", "price", "mileage"):
            if key == "mileage":
                try:
                    em = int(str(enriched.get("mileage") or 0).replace(",", ""))
                except (TypeError, ValueError):
                    em = 0
                if em > 0:
                    patch.setdefault("mileage", em)
                    patch["_mileage_resolved"] = True
            elif enriched.get(key) not in (None, "", 0):
                patch.setdefault(key, enriched.get(key))

    out = apply_fill(out, patch, condition=condition)

    # Cosmos API skeleton fallback — match by VIN when SRP cards were empty.
    if gauntlet_incomplete(out, condition=condition) and cosmos_by_vin:
        vin = _str(out.get("vin")).upper()
        cosmos_hit = cosmos_by_vin.get(vin) if vin else None
        if cosmos_hit is None and len(cosmos_by_vin) == 1 and not vin:
            cosmos_hit = next(iter(cosmos_by_vin.values()))
        if cosmos_hit:
            out = apply_fill(out, cosmos_hit, condition=condition)
    return out


# ── STEP 3 — Dealertrack / Sincro ────────────────────────────────────────────

def _sincro_patches_from_state(html: str) -> list[dict[str, Any]]:
    """Mirror Moses Nissan / Sincro embedded SRP_DATA / __NEXT_DATA__ extraction."""
    patches: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        keys = {str(k).lower(): k for k in node}
        vin_k = keys.get("vin") or keys.get("vehiclevin") or keys.get("vehicle_vin")
        vin = _str(node.get(vin_k) if vin_k else "").upper()
        if not vin or not VIN_RE.fullmatch(vin):
            for v in node.values():
                if isinstance(v, (dict, list)):
                    walk(v)
            return
        stock_k = (
            keys.get("stocknumber") or keys.get("stock_number") or keys.get("stock")
            or keys.get("stockno") or keys.get("dealerstocknumber")
        )
        price_k = (
            keys.get("price") or keys.get("internetprice") or keys.get("sellingprice")
            or keys.get("finalprice") or keys.get("askingprice")
        )
        color_k = (
            keys.get("exteriorcolor") or keys.get("exterior_color")
            or keys.get("extcolor") or keys.get("color")
        )
        miles_k = keys.get("mileage") or keys.get("miles") or keys.get("odometer")
        patch: dict[str, Any] = {
            "vin": vin,
            "stockNumber": sanitize_stock_number(node.get(stock_k) if stock_k else "") or "",
            "price": _digits(node.get(price_k) if price_k else 0),
            "exteriorColor": _str(node.get(color_k) if color_k else ""),
            "_gauntlet_step": 3,
        }
        if miles_k is not None and node.get(miles_k) not in (None, ""):
            patch["mileage"] = _digits(node.get(miles_k))
            patch["_mileage_resolved"] = True
        year_k = keys.get("year") or keys.get("modelyear")
        make_k = keys.get("make") or keys.get("vehiclemake")
        model_k = keys.get("model") or keys.get("vehiclemodel")
        if year_k:
            patch["year"] = _digits(node.get(year_k))
        if make_k:
            patch["make"] = _str(node.get(make_k))
        if model_k:
            patch["model"] = _str(node.get(model_k))
        link_k = keys.get("vdpurl") or keys.get("vdp_url") or keys.get("url") or keys.get("link")
        if link_k:
            patch["link"] = _str(node.get(link_k))
        patches.append(patch)
        for v in node.values():
            if isinstance(v, (dict, list)):
                walk(v)

    for pat in _SINCRO_STATE_PATTERNS:
        for m in re.finditer(pat, html or "", re.I):
            try:
                data = json.loads(m.group(1))
            except Exception:
                continue
            walk(data)
    return patches


def step3_dealertrack_sincro(
    vehicle: dict[str, Any],
    card_html: str,
    *,
    page_html: str = "",
    condition: str = "Used",
) -> dict[str, Any]:
    """Fill from Dealertrack / Sincro data-* attributes and pricing classes."""
    if gauntlet_complete(vehicle, condition=condition):
        return vehicle
    out = dict(vehicle)
    html = card_html or _str(out.get("_html"))
    patch: dict[str, Any] = {}

    if html:
        if vin_missing(out):
            vm = _DATA_VIN_RE.search(html)
            if vm:
                patch["vin"] = vm.group(1).upper()

        if stock_missing(out):
            sm = _DATA_STOCK_RE.search(html)
            if sm:
                cleaned = sanitize_stock_number(
                    sm.group(1), vin=_str(out.get("vin") or patch.get("vin")),
                    year=out.get("year") or 0,
                )
                if cleaned:
                    patch["stockNumber"] = cleaned

        if price_missing(out):
            pm = _DATA_PRICE_RE.search(html)
            if pm:
                patch["price"] = _digits(pm.group(1))
            if not patch.get("price"):
                vm_price = _VDP_PRICE_RE.search(html)
                if vm_price:
                    patch["price"] = _digits(vm_price.group(1))

        if color_missing(out):
            cm = _DATA_COLOR_RE.search(html)
            if cm:
                patch["exteriorColor"] = clean_text(cm.group(1))

        if mileage_missing(out, condition=condition):
            mm = _DATA_MILES_RE.search(html)
            if mm:
                # data-mileage="0" is an explicit reading (incl. New).
                try:
                    miles_n = int(str(mm.group(1)).replace(",", ""))
                except ValueError:
                    miles_n = _digits(mm.group(1))
                if miles_n >= 0:
                    patch["mileage"] = max(0, miles_n)
                    patch["_mileage_resolved"] = True

    out = apply_fill(out, patch, condition=condition)

    if gauntlet_incomplete(out, condition=condition) and page_html:
        vin = _str(out.get("vin")).upper()
        for sp in _sincro_patches_from_state(page_html):
            if vin and _str(sp.get("vin")).upper() == vin:
                out = apply_fill(out, sp, condition=condition)
                break
            if not vin and sp.get("vin"):
                # Seed VIN from Sincro state when card had none.
                out = apply_fill(out, sp, condition=condition)
                break
    return out


# ── STEP 4 — Physical text regex brute-force ─────────────────────────────────

def step4_text_bruteforce(
    vehicle: dict[str, Any],
    card_html: str,
    *,
    condition: str = "Used",
) -> dict[str, Any]:
    """Aggressive plain-text regex over the vehicle card."""
    if gauntlet_complete(vehicle, condition=condition):
        return vehicle
    html = card_html or _str(vehicle.get("_html"))
    plain = _plain(html)
    if not plain and not html:
        return vehicle
    hay = plain or html
    patch: dict[str, Any] = {}

    if stock_missing(vehicle):
        sm = _BF_STOCK_RE.search(hay)
        if sm:
            cleaned = sanitize_stock_number(
                sm.group(1), vin=_str(vehicle.get("vin")), year=vehicle.get("year") or 0,
            )
            if cleaned:
                patch["stockNumber"] = cleaned

    if color_missing(vehicle):
        cm = _BF_COLOR_RE.search(hay)
        if cm:
            color = clean_text(cm.group(1))
            color = re.split(r"\s{2,}|\s+Stock\b|\s+VIN\b|\s+\$|\s+\d", color, maxsplit=1)[0].strip()
            if color and len(color) <= 40:
                patch["exteriorColor"] = color

    if price_missing(vehicle):
        pm = _BF_PRICE_RE.search(hay)
        if pm:
            patch["price"] = _digits(pm.group(1))
        if not patch.get("price"):
            dm = _DOLLAR_RE.search(hay)
            if dm:
                patch["price"] = _digits(dm.group(0))

    if mileage_missing(vehicle, condition=condition):
        mm = _BF_MILES_RE.search(hay)
        if mm:
            raw = mm.group(1) or mm.group(2) or "0"
            patch["mileage"] = _digits(raw)
            patch["_mileage_resolved"] = True
        elif (condition or "").strip().title() == "New":
            # New + blank → 0
            patch["mileage"] = 0
            patch["_mileage_resolved"] = True

    if vin_missing(vehicle):
        vm = VIN_RE.search(hay) or VIN_RE.search(html or "")
        if vm:
            patch["vin"] = vm.group(1).upper()

    return apply_fill(vehicle, patch, condition=condition)


# ── STEP 5 — Optional enrichment (URL stock / In Transit; VDP via pipeline) ──

def step5_optional_stock_enrichment(
    vehicle: dict[str, Any],
    *,
    condition: str = "Used",
) -> dict[str, Any]:
    """Optional final stock enrichment: VDP URL patterns → In Transit → Unavailable.

    VDP HTML fetch hydration is intentionally left to ``vdp_hydrate.hydrate_vehicles``
    in the pipeline so link is never mangled and concurrency stays bounded.
    """
    out = dict(vehicle)
    link = _str(out.get("link") or out.get("vdp_url") or out.get("vdpUrl"))
    html = _str(out.get("_html"))

    if stock_missing(out):
        stock = ""
        if link:
            stock = extract_stock_from_url(
                link, vin=_str(out.get("vin")), year=out.get("year") or 0,
            )
        if not stock:
            stock = resolve_stock_number(
                out, html, vin=_str(out.get("vin")), year=out.get("year") or 0, link=link,
            )
        if stock:
            out["stockNumber"] = stock
            out["stock_number"] = stock
        else:
            out["stockNumber"] = MISSING_STOCK
            out["stock_number"] = MISSING_STOCK

    if mileage_missing(out, condition=condition) and (condition or "").strip().title() == "New":
        out["mileage"] = 0
        out["_mileage_resolved"] = True

    # Preserve link exactly.
    if link:
        out["link"] = link
        out["vdp_url"] = link
        out["vdpUrl"] = link
    return out


# ── Per-vehicle gauntlet runner ──────────────────────────────────────────────

def run_gauntlet(
    vehicle: dict[str, Any] | None,
    *,
    card_html: str = "",
    page_html: str = "",
    condition: str = "Used",
    cosmos_by_vin: dict[str, dict[str, Any]] | None = None,
    finalize_stock: bool = True,
) -> dict[str, Any]:
    """Run steps 1→4 (then optional stock finalize) until critical fields fill.

    Never leaves Unavailable/empty dashes when a step succeeded with true data.
    """
    cond = (condition or "Used").strip().title()
    if cond not in ("New", "Used"):
        cond = "Used"
    out: dict[str, Any] = dict(vehicle or {})
    out["condition"] = cond
    html_card = card_html or _str(out.get("_html"))
    if html_card and not out.get("_html"):
        out["_html"] = html_card
    page = page_html or html_card

    # Strict order — each step only fills still-missing fields.
    out = step1_schema_jsonld(out, html_card or page, condition=cond)
    if gauntlet_incomplete(out, condition=cond):
        # Also try page-level JSON-LD when card has none.
        if page and page is not html_card:
            out = step1_schema_jsonld(out, page, condition=cond)

    if gauntlet_incomplete(out, condition=cond):
        out = step2_dealeron_grid(
            out, html_card, condition=cond, cosmos_by_vin=cosmos_by_vin,
        )

    if gauntlet_incomplete(out, condition=cond):
        out = step3_dealertrack_sincro(
            out, html_card, page_html=page, condition=cond,
        )

    if gauntlet_incomplete(out, condition=cond):
        out = step4_text_bruteforce(out, html_card, condition=cond)

    if finalize_stock:
        out = step5_optional_stock_enrichment(out, condition=cond)

    return out


def _cosmos_index(
    html: str,
    page_url: str,
    *,
    condition: str,
) -> dict[str, dict[str, Any]]:
    """Build VIN→vehicle map from Cosmos when the SRP looks like a skeleton."""
    if not (looks_like_skeleton_srp(html) or parse_srp_config_from_html(html, page_url)):
        return {}
    if not looks_like_skeleton_srp(html) and iter_vehicle_cards(html):
        # Hydrated DOM cards present — Cosmos is optional; still allow if empty parse.
        pass
    try:
        rows = extract_cosmos_inventory(
            html, page_url, condition=condition, max_pages=1, page_size=24,
        )
    except Exception:
        return {}
    by_vin: dict[str, dict[str, Any]] = {}
    for v in rows or []:
        vin = _str(v.get("vin")).upper()
        if vin:
            by_vin[vin] = v
    return by_vin


def extract_with_gauntlet(
    html: str,
    page_url: str,
    *,
    condition: str = "Used",
) -> list[dict[str, Any]]:
    """Page-level extraction: discover seeds, run the gauntlet on each vehicle."""
    cond = (condition or "Used").strip().title()
    if cond not in ("New", "Used"):
        path = (urlparse(page_url).path or "").lower()
        cond = "New" if ("new" in path and "used" not in path) else "Used"

    text = decode_entities(html or "")
    cosmos_by_vin = _cosmos_index(text, page_url, condition=cond)

    seeds: list[dict[str, Any]] = []
    seen: set[str] = set()

    # Prefer DOM cards; fall back to JSON-LD / Cosmos / Sincro state vehicles.
    cards = iter_vehicle_cards(text)
    for card in cards:
        seed = _seed_from_card(card, page_url, condition=cond)
        key = _str(seed.get("vin")).upper() or _str(seed.get("link"))
        if not key:
            # Require some identity signal
            if not (seed.get("year") and seed.get("make")):
                continue
            key = f"ymm:{seed.get('year')}|{seed.get('make')}|{seed.get('model')}"
        if key in seen:
            continue
        seen.add(key)
        seeds.append(seed)

    if not seeds:
        for p in parse_schema_jsonld(text):
            vin = _str(p.get("vin")).upper()
            key = vin or _str(p.get("link"))
            if not key or key in seen:
                continue
            seen.add(key)
            seeds.append({**p, "condition": cond, "_html": ""})

    if not seeds and cosmos_by_vin:
        for vin, row in cosmos_by_vin.items():
            if vin in seen:
                continue
            seen.add(vin)
            seeds.append(dict(row))

    if not seeds:
        for sp in _sincro_patches_from_state(text):
            vin = _str(sp.get("vin")).upper()
            if not vin or vin in seen:
                continue
            seen.add(vin)
            seeds.append({**sp, "condition": cond})

    # Whole-page fallback — one gauntlet pass on the document.
    if not seeds and text.strip():
        seeds.append({"_html": text, "condition": cond})

    vehicles: list[dict[str, Any]] = []
    out_seen: set[str] = set()
    for seed in seeds:
        filled = run_gauntlet(
            seed,
            card_html=_str(seed.get("_html")),
            page_html=text,
            condition=cond,
            cosmos_by_vin=cosmos_by_vin,
            finalize_stock=True,
        )
        norm = normalize_vehicle(filled, condition=cond)
        if not norm:
            continue
        vin = _str(norm.get("vin")).upper()
        if not vin or vin in out_seen:
            continue
        out_seen.add(vin)
        # Drop internal bookkeeping keys from the public payload.
        norm.pop("_mileage_resolved", None)
        vehicles.append(norm)
    return vehicles


def critical_payload(vehicle: dict[str, Any]) -> dict[str, Any]:
    """Compact payload used by one-shot verification prints / tests."""
    return {
        "stockNumber": vehicle.get("stockNumber") or vehicle.get("stock_number") or "",
        "exteriorColor": vehicle.get("exteriorColor") or vehicle.get("exterior_color") or "",
        "price": int(vehicle.get("price") or 0),
        "mileage": int(vehicle.get("mileage") or 0),
        "vin": vehicle.get("vin") or "",
    }
