"""Tier 2 — Structural DOM heuristics (platform-agnostic fallback)."""

from __future__ import annotations

import re
from typing import Any

from .html_utils import absolutize, clean_text, decode_entities
from .schema import VIN_RE, normalize_vehicle
from .stock import extract_stock_from_html, resolve_stock_number
from .tier1_dom import bind_vdp_anchors

_CONTAINER_RE = re.compile(
    r'<(?P<tag>div|li|article|section|tr)[^>]+(?:'
    r'class=["\'][^"\']*(?:vehicle|inventory|card|listing|result|srp)[^"\']*["\']|'
    r'id=["\'][^"\']*(?:srp|inventory|vehicle|results)[^"\']*["\']'
    r')[^>]*>(?P<body>[\s\S]{80,6000}?)</(?P=tag)>',
    re.I,
)

_PRICE_RE = re.compile(
    r'(?:\$|USD)\s*([\d,]{3,7}(?:\.\d{2})?)|'
    r'(?:price|internet|asking)\s*[:\s]*\$?\s*([\d,]{3,7})',
    re.I,
)
_MILES_RE = re.compile(r'([\d,]{1,7})\s*(?:mi|miles|odometer)\b', re.I)
_YMM_RE = re.compile(
    r'\b((?:19|20)\d{2})\s+([A-Z][A-Za-z0-9\-]+)\s+([A-Z0-9][A-Za-z0-9\-]+(?:\s+[A-Z0-9][A-Za-z0-9\-]*)?)',
)
_COLOR_RE = re.compile(
    r'(?:exterior(?:\s*color)?|ext\.?\s*color|color)\s*[:\-]\s*([A-Za-z][A-Za-z0-9 \-/]{1,32})',
    re.I,
)
_IMG_RE = re.compile(r'<img[^>]+(?:src|data-src|data-lazy)=["\']([^"\']+)["\']', re.I)
_HREF_RE = re.compile(r'<a[^>]+href=["\']([^"\']+)["\']', re.I)


def extract_tier2(html: str, page_url: str, *, condition: str = "Used") -> list[dict]:
    text = decode_entities(html or "")
    # Strip scripts/styles so heuristics don't eat JS blobs
    text = re.sub(r"<(script|style|noscript)\b[^>]*>[\s\S]*?</\1>", " ", text, flags=re.I)

    out: list[dict] = []
    seen: set[str] = set()

    for m in _CONTAINER_RE.finditer(text):
        body = m.group("body")
        plain = clean_text(re.sub(r"<[^>]+>", " ", body))
        vin_m = VIN_RE.search(body) or VIN_RE.search(plain)
        if not vin_m:
            continue
        vin = vin_m.group(1).upper()
        if vin in seen:
            continue

        price = 0
        pm = _PRICE_RE.search(plain) or _PRICE_RE.search(body)
        if pm:
            price = int(float((pm.group(1) or pm.group(2) or "0").replace(",", "")))

        mileage = 0
        mm = _MILES_RE.search(plain)
        if mm:
            mileage = int(mm.group(1).replace(",", ""))

        year, make, model = 0, "", ""
        ym = _YMM_RE.search(plain)
        if ym:
            year = int(ym.group(1))
            make = ym.group(2)
            model = ym.group(3).split()[0] if ym.group(3) else ""

        # Stock: data-* / DOM class / "Stock #:" labels BEFORE generic fallbacks.
        # Never accept a bare model year as the stock number.
        stock = extract_stock_from_html(body, vin=vin, year=year) or resolve_stock_number(
            {}, body, vin=vin, year=year,
        )

        color = ""
        cm = _COLOR_RE.search(plain)
        if cm:
            color = clean_text(cm.group(1))

        link = ""
        for hm in _HREF_RE.finditer(body):
            href = absolutize(hm.group(1), page_url)
            if href and (vin in href.upper() or "/vehicle" in href.lower() or "/vdp" in href.lower()):
                link = href
                break
        if not link:
            for hm in _HREF_RE.finditer(body):
                href = absolutize(hm.group(1), page_url)
                if href and href.rstrip("/") != page_url.rstrip("/"):
                    link = href
                    break

        image = ""
        im = _IMG_RE.search(body)
        if im:
            image = absolutize(im.group(1), page_url)

        raw: dict[str, Any] = {
            "vin": vin,
            "year": year,
            "make": make,
            "model": model,
            "price": price,
            "mileage": mileage,
            "stockNumber": stock,
            "exteriorColor": color,
            "link": link,
            "imageUrl": image,
            "_html": body,
        }
        norm = normalize_vehicle(raw, condition=condition)
        if norm:
            seen.add(vin)
            out.append(norm)

    return bind_vdp_anchors(out, html, page_url)
