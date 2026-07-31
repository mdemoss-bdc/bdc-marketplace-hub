"""Tier 1 — JSON-LD / data-* attributes / VDP anchor binding (fast & free)."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urljoin

from .html_utils import absolutize, clean_text, decode_entities
from .schema import VIN_RE, normalize_vehicle
from .stock import detect_in_transit, extract_stock_from_html, resolve_stock_number

_LD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
    re.I,
)
_CARD_RE = re.compile(
    r'<(?:div|li|article|section)[^>]+(?:'
    r'data-vin=|data-vehicle|data-year=|'
    r'class=["\'][^"\']*(?:vehicle-card|srp-vehicle|inventory-card|listing-card)[^"\']*["\']'
    r')[^>]*>[\s\S]{0,4500}?</(?:div|li|article|section)>',
    re.I,
)
_ATTR_RE = re.compile(
    r'data-(?P<k>vin|year|make|model|trim|price|internet-price|final-price|'
    r'stocknumber|stock-number|vin-stock|stock-no|stockno|stocknum|stock|'
    r'mileage|miles|extcolor|exterior-color|'
    r'color|vehicle)\s*=\s*["\'](?P<v>[^"\']+)["\']',
    re.I,
)
_VDP_HREF_RE = re.compile(
    r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>',
    re.I,
)
_VDP_PATH_HINT = re.compile(
    r"(?:vehicle|inventory|vdp|detail|used|new).{0,80}"
    r"(?:[A-HJ-NPR-Z0-9]{17}|/\d{4}-)",
    re.I,
)


def _walk_ld(node: Any, out: list[dict], condition: str) -> None:
    if isinstance(node, list):
        for item in node:
            _walk_ld(item, out, condition)
        return
    if not isinstance(node, dict):
        return
    types = node.get("@type") or node.get("type") or ""
    if isinstance(types, list):
        types_l = " ".join(str(t) for t in types).lower()
    else:
        types_l = str(types).lower()
    if any(t in types_l for t in ("car", "vehicle", "product", "cars")):
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
        raw = {
            "vin": node.get("vehicleIdentificationNumber") or node.get("sku") or node.get("vin"),
            "year": node.get("vehicleModelDate") or node.get("modelDate") or node.get("productionDate"),
            "make": make or node.get("manufacturer"),
            "model": node.get("model") or node.get("name"),
            "trim": node.get("vehicleConfiguration") or node.get("trim"),
            "price": offer.get("price") or node.get("price"),
            "mileage": (node.get("mileageFromOdometer") or {}).get("value")
            if isinstance(node.get("mileageFromOdometer"), dict)
            else node.get("mileageFromOdometer") or node.get("mileage"),
            "exteriorColor": node.get("color") or node.get("vehicleExteriorColor"),
            "link": node.get("url") or offer.get("url"),
            "imageUrl": (
                node.get("image")[0]
                if isinstance(node.get("image"), list) and node.get("image")
                else node.get("image")
            ),
            "stockNumber": resolve_stock_number(
                {
                    "stockNumber": node.get("sku") or node.get("mpn") or node.get("productID"),
                    "sku": node.get("sku"),
                    "mpn": node.get("mpn"),
                    "link": node.get("url") or offer.get("url"),
                },
                "",
                vin=str(node.get("vehicleIdentificationNumber") or node.get("vin") or ""),
                year=node.get("vehicleModelDate") or node.get("modelDate") or 0,
                link=str(node.get("url") or offer.get("url") or ""),
            ),
        }
        norm = normalize_vehicle(raw, condition=condition)
        if norm:
            out.append(norm)
    for v in node.values():
        if isinstance(v, (dict, list)):
            _walk_ld(v, out, condition)


def parse_json_ld(html: str, *, condition: str = "Used") -> list[dict]:
    out: list[dict] = []
    for m in _LD_RE.finditer(html or ""):
        blob = decode_entities(m.group(1)).strip()
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except Exception:
            # Some pages ship concatenated JSON objects
            try:
                data = json.loads(f"[{blob}]")
            except Exception:
                continue
        _walk_ld(data, out, condition)
    return _dedupe(out)


def parse_data_attributes(html: str, base_url: str, *, condition: str = "Used") -> list[dict]:
    out: list[dict] = []
    text = decode_entities(html or "")
    for card in _CARD_RE.findall(text) or [text]:
        attrs: dict[str, str] = {}
        for am in _ATTR_RE.finditer(card):
            attrs[am.group("k").lower().replace("-", "")] = clean_text(am.group("v"))
        if not attrs.get("vin"):
            vm = VIN_RE.search(card)
            if vm:
                attrs["vin"] = vm.group(1).upper()
        has_ym = bool(attrs.get("year") and attrs.get("make"))
        in_transit = detect_in_transit(card)
        # Keep In Transit / year+make cards even when VIN is omitted on the SRP.
        if not attrs.get("vin") and not has_ym and not in_transit:
            continue
        link = ""
        for hm in _VDP_HREF_RE.finditer(card):
            href = absolutize(hm.group(1), base_url)
            if href and (_VDP_PATH_HINT.search(href) or VIN_RE.search(href)):
                link = href
                break
        if not link:
            for hm in _VDP_HREF_RE.finditer(card):
                href = absolutize(hm.group(1), base_url)
                if href and href != base_url:
                    link = href
                    break
        # Without VIN, require a VDP link (or year+make) so normalize can retain.
        if not attrs.get("vin") and not link and not has_ym:
            continue
        vin = attrs.get("vin") or ""
        year = attrs.get("year") or 0
        # Selector priority: DOM → VDP URL → In Transit → Unavailable.
        stock = extract_stock_from_html(card, vin=vin, year=year) or resolve_stock_number(
            {
                "stockNumber": (
                    attrs.get("stocknumber")
                    or attrs.get("vinstock")
                    or attrs.get("stockno")
                    or attrs.get("stock")
                ),
                "link": link,
            },
            card,
            vin=vin,
            year=year,
            link=link,
        )
        raw = {
            "vin": vin,
            "year": year,
            "make": attrs.get("make"),
            "model": attrs.get("model"),
            "trim": attrs.get("trim"),
            "price": attrs.get("price") or attrs.get("internetprice") or attrs.get("finalprice"),
            "mileage": attrs.get("mileage") or attrs.get("miles"),
            "exteriorColor": attrs.get("extcolor") or attrs.get("exteriorcolor") or attrs.get("color"),
            "stockNumber": stock,
            "link": link,
            "_html": card,
        }
        img_m = re.search(
            r'<img[^>]+(?:src|data-src|data-lazy|data-original)=["\']([^"\']+)["\']',
            card,
            re.I,
        )
        if img_m:
            raw["imageUrl"] = absolutize(img_m.group(1), base_url)
        norm = normalize_vehicle(raw, condition=condition)
        if norm:
            out.append(norm)
    return _dedupe(out)


def bind_vdp_anchors(vehicles: list[dict], html: str, base_url: str) -> list[dict]:
    """Attach missing VDP links by matching VIN / stock in nearby anchors."""
    text = decode_entities(html or "")
    anchors: list[tuple[str, str]] = []
    for m in _VDP_HREF_RE.finditer(text):
        href = absolutize(m.group(1), base_url)
        if not href:
            continue
        # Capture a small window of surrounding text for VIN matching
        start = max(0, m.start() - 200)
        end = min(len(text), m.end() + 400)
        anchors.append((href, text[start:end]))

    for v in vehicles:
        if v.get("link") or v.get("vdp_url"):
            continue
        vin = (v.get("vin") or "").upper()
        stock = (v.get("stockNumber") or v.get("stock_number") or "").upper()
        for href, window in anchors:
            win_u = window.upper()
            if vin and vin in win_u:
                v["link"] = href
                v["vdp_url"] = href
                break
            if (
                stock
                and stock not in ("N/A", "UNAVAILABLE", "IN TRANSIT")
                and stock in win_u
                and _VDP_PATH_HINT.search(href)
            ):
                v["link"] = href
                v["vdp_url"] = href
                break
    return vehicles


def extract_tier1(html: str, page_url: str, *, condition: str = "Used") -> list[dict]:
    vehicles = parse_json_ld(html, condition=condition)
    if len(vehicles) < 5:
        vehicles = _dedupe(vehicles + parse_data_attributes(html, page_url, condition=condition))
    return bind_vdp_anchors(vehicles, html, page_url)


def _dedupe(rows: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for r in rows:
        vin = (r.get("vin") or "").upper()
        if not vin or vin in seen:
            continue
        seen.add(vin)
        out.append(r)
    return out
