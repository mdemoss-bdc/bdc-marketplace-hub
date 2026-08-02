"""Optional Gauntlet STEP 5 — VDP fallback hydration for thin SRP parses.

After gauntlet steps 1–4, when stock is still missing/Unavailable or price is 0,
fetch ``vehicle.link`` (stdlib urllib, short timeout, bounded concurrency) and
fill stock / price / color / mileage from JSON-LD, meta tags, and shared DOM /
text patterns. Never mutates ``vehicle.link``.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from urllib.parse import urlparse

from .fields import extract_exterior_color, extract_mileage, extract_price
from .html_utils import clean_text, decode_entities, fetch_html
from .stock import (
    MISSING_STOCK,
    extract_stock_from_html,
    sanitize_stock_number,
)

_LD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
    re.I,
)
_OG_PRICE_RE = re.compile(
    r'<meta[^>]+property=["\']og:price:amount["\'][^>]+content=["\']([^"\']+)["\']',
    re.I,
)
_OG_PRICE_RE_ALT = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:price:amount["\']',
    re.I,
)
_TWITTER_DATA1_RE = re.compile(
    r'<meta[^>]+name=["\']twitter:data1["\'][^>]+content=["\']([^"\']+)["\']',
    re.I,
)
_TWITTER_DATA1_RE_ALT = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']twitter:data1["\']',
    re.I,
)
_DATA_STOCK_PATTERNS = (
    r'data-stocknum=["\']([^"\']{2,20})["\']',
    r'data-stock-number=["\']([^"\']{2,20})["\']',
    r'data-stocknumber=["\']([^"\']{2,20})["\']',
    r'data-stock-no=["\']([^"\']{2,20})["\']',
    r'data-stockno=["\']([^"\']{2,20})["\']',
    r'data-vehicle-stock=["\']([^"\']{2,20})["\']',
    r'data-stock=["\']([^"\']{2,20})["\']',
)
_JSON_STOCK_PATTERNS = (
    r'"stockNumber"\s*:\s*"([^"]{2,20})"',
    r'"StockNumber"\s*:\s*"([^"]{2,20})"',
    r'"stock_number"\s*:\s*"([^"]{2,20})"',
    r'"stockNo"\s*:\s*"([^"]{2,20})"',
    r'"vehicleStockNumber"\s*:\s*"([^"]{2,20})"',
)
_DATA_COLOR_RE = re.compile(
    r'data-(?:exterior-color|ext-color|color)=["\']([^"\']{2,48})["\']',
    re.I,
)
_DATA_MILES_RE = re.compile(
    r'data-(?:mileage|miles|odometer)=["\'](\d[\d,]*)["\']',
    re.I,
)
_DATA_PRICE_RE = re.compile(r'data-(?:price|internet-price|msrp)=["\'](\d+)["\']', re.I)
# moses_layout.txt VDP / SRP pricing + color DOM
_HIGHLIGHT_AMOUNT_RE = re.compile(
    r'class=["\'][^"\']*\bvehiclePricingHighlightAmount\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_PRICE_BLOC_VALUE_RE = re.compile(
    r'class=["\'][^"\']*\bpriceBlocItemPriceValue\b[^"\']*["\'][^>]*>'
    r'\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*<',
    re.I,
)
_COLORS_EXT_VALUE_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-colors__ext\b[^"\']*["\'][^>]*>'
    r'[\s\S]{0,400}?'
    r'class=["\'][^"\']*\bvehicle-colors__value\b[^"\']*["\'][^>]*>'
    r'\s*([^<]{2,48})\s*<',
    re.I,
)
_VEHICLE_MILEAGE_RE = re.compile(
    r'class=["\'][^"\']*\bvehicle-mileage\b[^"\']*["\'][^>]*>'
    r'\s*([0-9,]+)',
    re.I,
)

DEFAULT_MAX_FETCHES = 40
DEFAULT_WORKERS = 8
DEFAULT_TIMEOUT = 8


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
        n = int(float(m.group(1).replace(",", "")))
    except ValueError:
        return 0
    if 1900 <= n <= 2100:
        return 0
    return n if n > 0 else 0


def _stock_of(vehicle: dict[str, Any]) -> str:
    return clean_text(
        vehicle.get("stockNumber")
        or vehicle.get("stock_number")
        or vehicle.get("stock")
        or ""
    )


def _link_of(vehicle: dict[str, Any]) -> str:
    return clean_text(
        vehicle.get("link")
        or vehicle.get("vdp_url")
        or vehicle.get("vdpUrl")
        or vehicle.get("_vdp_url")
        or vehicle.get("url")
        or vehicle.get("href")
        or ""
    )


def needs_hydration(vehicle: dict[str, Any] | None) -> bool:
    """True when stock is missing/Unavailable or price is 0/missing."""
    if not isinstance(vehicle, dict):
        return False
    if not _link_of(vehicle):
        return False
    stock = _stock_of(vehicle)
    stock_bad = (
        not stock
        or stock.lower() in {"unavailable", "n/a", "na", "none", "-", "—"}
        or stock == MISSING_STOCK
    )
    price_bad = _digits(vehicle.get("price")) <= 0
    return stock_bad or price_bad


def _price_from_offers(offer: Any) -> int:
    if isinstance(offer, list) and offer:
        offer = offer[0]
    if not isinstance(offer, dict):
        return 0
    return _digits(offer.get("price") or offer.get("lowPrice") or offer.get("highPrice"))


def _walk_ld_vehicle(node: Any, out: dict[str, Any]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk_ld_vehicle(item, out)
        return
    if not isinstance(node, dict):
        return
    types = node.get("@type") or node.get("type") or ""
    if isinstance(types, list):
        types_l = " ".join(str(t) for t in types).lower()
    else:
        types_l = str(types).lower()
    if any(t in types_l for t in ("car", "vehicle", "product", "cars", "offer")):
        if not out.get("price"):
            price = _price_from_offers(node.get("offers")) or _digits(node.get("price"))
            if price > 0:
                out["price"] = price
        if not out.get("stock_number"):
            for key in ("sku", "mpn", "productID", "stockNumber", "stock_number"):
                cleaned = sanitize_stock_number(node.get(key) or "")
                if cleaned and cleaned != MISSING_STOCK:
                    out["stock_number"] = cleaned
                    break
        if not out.get("exterior_color"):
            color = clean_text(
                node.get("color") or node.get("vehicleExteriorColor") or ""
            )
            if color:
                out["exterior_color"] = color
        if not out.get("mileage"):
            miles = node.get("mileageFromOdometer")
            if isinstance(miles, dict):
                miles = miles.get("value")
            n = _digits(miles or node.get("mileage"))
            if n > 0:
                out["mileage"] = n
    for v in node.values():
        if isinstance(v, (dict, list)):
            _walk_ld_vehicle(v, out)


def extract_from_vdp_html(html: str, *, condition: str = "Used") -> dict[str, Any]:
    """Parse stock / price / color / mileage from a VDP HTML document."""
    text = decode_entities(html or "")
    if not text:
        return {}

    out: dict[str, Any] = {}

    # 1) JSON-LD Vehicle / Product offers
    for m in _LD_RE.finditer(text):
        blob = m.group(1).strip()
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except Exception:
            try:
                data = json.loads(f"[{blob}]")
            except Exception:
                continue
        _walk_ld_vehicle(data, out)

    # 2) Meta og:price:amount / twitter:data1
    if not out.get("price"):
        for pre in (_OG_PRICE_RE, _OG_PRICE_RE_ALT, _TWITTER_DATA1_RE, _TWITTER_DATA1_RE_ALT):
            mm = pre.search(text)
            if not mm:
                continue
            n = _digits(mm.group(1))
            if n >= 500:
                out["price"] = n
                break

    # 3) data-* attributes
    if not out.get("stock_number"):
        for pat in _DATA_STOCK_PATTERNS:
            m = re.search(pat, text, re.I)
            if m:
                cleaned = sanitize_stock_number(m.group(1))
                if cleaned:
                    out["stock_number"] = cleaned
                    break
    if not out.get("stock_number"):
        for pat in _JSON_STOCK_PATTERNS:
            m = re.search(pat, text, re.I)
            if m:
                cleaned = sanitize_stock_number(m.group(1))
                if cleaned:
                    out["stock_number"] = cleaned
                    break

    if not out.get("exterior_color"):
        cm = _COLORS_EXT_VALUE_RE.search(text) or _DATA_COLOR_RE.search(text)
        if cm:
            c = clean_text(cm.group(1))
            if c and c.lower() not in {"n/a", "none", "unknown", "select"}:
                out["exterior_color"] = c

    if not out.get("mileage"):
        mm = _VEHICLE_MILEAGE_RE.search(text) or _DATA_MILES_RE.search(text)
        if mm:
            n = _digits(mm.group(1))
            if n > 0:
                out["mileage"] = n

    if not out.get("price"):
        for rx in (_HIGHLIGHT_AMOUNT_RE, _PRICE_BLOC_VALUE_RE, _DATA_PRICE_RE):
            m = rx.search(text)
            if not m:
                continue
            n = _digits(m.group(1))
            if n >= 500:
                out["price"] = n
                break

    # 4) Same Stock #: / Ext. / mileage / price patterns used on SRP cards
    if not out.get("stock_number"):
        stock = extract_stock_from_html(text)
        if stock:
            out["stock_number"] = stock

    if not out.get("exterior_color"):
        color = extract_exterior_color(text)
        if color:
            out["exterior_color"] = color

    if not out.get("mileage"):
        miles = extract_mileage(text, condition=condition)
        if miles > 0 or (condition or "").strip().title() == "New":
            out["mileage"] = miles

    if not out.get("price"):
        price = extract_price(text)
        if price > 0:
            out["price"] = price

    return out


def fetch_and_extract_vdp(
    url: str,
    *,
    condition: str = "Used",
    timeout: int = DEFAULT_TIMEOUT,
) -> dict[str, Any]:
    """Fetch one VDP URL and extract enrichment fields. Best-effort."""
    raw = clean_text(url)
    if not raw:
        return {}
    try:
        parsed = urlparse(raw)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            return {}
    except Exception:
        return {}
    try:
        html = fetch_html(raw, timeout=timeout, max_retries=1)
    except Exception:
        return {}
    return extract_from_vdp_html(html, condition=condition)


def _apply_enrichment(
    vehicle: dict[str, Any],
    data: dict[str, Any],
) -> dict[str, Any]:
    """Merge enrichment onto vehicle without mangling link / VDP URL."""
    if not data:
        return vehicle
    out = dict(vehicle)
    link = _link_of(out)

    stock = sanitize_stock_number(data.get("stock_number") or data.get("stockNumber") or "")
    cur_stock = _stock_of(out)
    stock_bad = (
        not cur_stock
        or cur_stock.lower() in {"unavailable", "n/a", "na", "none", "-", "—"}
        or cur_stock == MISSING_STOCK
    )
    if stock and stock_bad:
        out["stockNumber"] = stock
        out["stock_number"] = stock

    if _digits(out.get("price")) <= 0 and _digits(data.get("price")) > 0:
        out["price"] = _digits(data.get("price"))

    color = clean_text(
        data.get("exterior_color") or data.get("exteriorColor") or data.get("color") or ""
    )
    if color and not clean_text(
        out.get("exteriorColor") or out.get("exterior_color") or out.get("color") or ""
    ):
        out["exteriorColor"] = color
        out["exterior_color"] = color

    miles = data.get("mileage")
    if miles is not None:
        try:
            miles_n = int(miles)
        except (TypeError, ValueError):
            miles_n = _digits(miles)
        cur_miles = _digits(out.get("mileage"))
        if miles_n > 0 and cur_miles <= 0:
            out["mileage"] = miles_n
        elif miles_n == 0 and (out.get("condition") or "").strip().title() == "New":
            out["mileage"] = 0

    # Preserve original VDP link exactly.
    if link:
        out["link"] = link
        out["vdp_url"] = link
        out["vdpUrl"] = link
        if "_vdp_url" in vehicle:
            out["_vdp_url"] = vehicle["_vdp_url"] or link

    return out


def hydrate_vehicles(
    vehicles: list[dict[str, Any]],
    *,
    condition: str = "Used",
    max_fetches: int = DEFAULT_MAX_FETCHES,
    workers: int = DEFAULT_WORKERS,
    timeout: int = DEFAULT_TIMEOUT,
) -> list[dict[str, Any]]:
    """Hydrate vehicles missing stock/price via bounded parallel VDP fetches."""
    if not vehicles:
        return []

    targets: list[tuple[int, dict[str, Any], str]] = []
    for i, v in enumerate(vehicles):
        if len(targets) >= max(0, max_fetches):
            break
        if not needs_hydration(v):
            continue
        link = _link_of(v)
        if link:
            targets.append((i, v, link))

    if not targets:
        return list(vehicles)

    results: dict[int, dict[str, Any]] = {}
    n_workers = max(1, min(workers, len(targets)))

    def _one(item: tuple[int, dict[str, Any], str]) -> tuple[int, dict[str, Any]]:
        idx, veh, link = item
        cond = str(veh.get("condition") or condition or "Used").strip().title()
        data = fetch_and_extract_vdp(link, condition=cond, timeout=timeout)
        return idx, _apply_enrichment(veh, data)

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        futs = {pool.submit(_one, t): t[0] for t in targets}
        for fut in as_completed(futs):
            try:
                idx, enriched = fut.result()
                results[idx] = enriched
            except Exception:
                continue

    out: list[dict[str, Any]] = []
    for i, v in enumerate(vehicles):
        out.append(results.get(i, v))
    return out
