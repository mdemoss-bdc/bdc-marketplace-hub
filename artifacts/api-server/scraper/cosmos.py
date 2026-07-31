"""DealerOn Cosmos / Wasabi SRP JS-data path.

``moses_layout.txt`` (UTF-16 dump of mosescars.com search-all-new-inventory)
ships SPA skeleton cards only — ``VehicleListModel: []`` and
``class="vehicle-card vehicle-card--mod skeleton"``.  Real inventory arrives
via the Cosmos REST API using config embedded in ``<script id="dlron-srp-model">``.

Endpoint (DealerOn Wasabi bundle):
  GET /api/{dealerCode}/vehicle-pages/cosmos/srp/vehicles/{dealerId}/{pageId}
      ?baseFilter={btoa(filter)}&pn={pageSize}&pt={pageNumber}
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

from .html_utils import absolutize, clean_text, decode_entities
from .schema import normalize_vehicle
from .stock import resolve_stock_number, sanitize_stock_number

_DLRON_SRP_RE = re.compile(
    r'<script[^>]+id=["\']dlron-srp-model["\'][^>]*>([\s\S]+?)</script>',
    re.I,
)
_DEALER_CODE_RE = re.compile(r"/resources/([a-z0-9]+)/(?:pages|components|vhcliaa)?", re.I)
_DEALER_CODE_FALLBACK_RE = re.compile(r"/resources/([a-z0-9]+)/", re.I)

_PL_ASKING_LABELS = (
    "internet price",
    "selling price",
    "sale price",
    "e-price",
    "eprice",
    "moses price",
    "our price",
    "calc_internet price",
    "final price",
    "calc_final price",
)

_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


def _int_money(value: Any) -> int:
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
    return n if n > 0 else 0


def decode_price_library(raw: Any) -> dict[str, int]:
    """Decode DealerOn ``VehiclePriceLibrary`` base64 → {label: dollars}."""
    if not raw:
        return {}
    text = str(raw).strip()
    if len(text) < 8:
        return {}
    try:
        decoded = base64.b64decode(text + "=" * (-len(text) % 4)).decode(
            "utf-8", "replace"
        )
    except Exception:
        decoded = text
    if ":" not in decoded:
        return {}
    out: dict[str, int] = {}
    for part in decoded.split(";"):
        label, _, value = part.partition(":")
        label = label.strip().lower()
        if not label or not value:
            continue
        dollars = _int_money(value)
        if dollars:
            out[label] = dollars
    return out


def extract_asking_price(card: dict[str, Any]) -> int:
    """Prefer price-library internet/selling; never invent from empty zeros."""
    library = decode_price_library(card.get("VehiclePriceLibrary"))
    for label in _PL_ASKING_LABELS:
        if library.get(label):
            return library[label]
    for key in (
        "VehicleInternetPrice",
        "internetPrice",
        "SellingPrice",
        "salePrice",
        "finalPrice",
        "displayPrice",
    ):
        n = _int_money(card.get(key))
        if n:
            return n
    # PriceStak featured HTML (when present on Wasabi panel)
    wasabi = card.get("WasabiVehiclePricingPanelViewModel") or {}
    stak = (wasabi.get("PriceStakViewModel") or {}) if isinstance(wasabi, dict) else {}
    tabs = (stak.get("PriceStakTabsModel") or {}) if isinstance(stak, dict) else {}
    for html_key in ("BuyContent", "PriceMainHtml", "LeaseContent", "FinanceContent"):
        html = tabs.get(html_key) or stak.get(html_key) or ""
        if not isinstance(html, str) or "$" not in html:
            continue
        m = re.search(
            r'vehiclePricingHighlightAmount[^>]*>\s*\$?\s*([\d,]+)',
            html,
            re.I,
        ) or re.search(
            r'priceBlocItemPriceValue[^>]*>\s*\$?\s*([\d,]+)',
            html,
            re.I,
        ) or re.search(r"\$\s*([\d,]{4,})", html)
        if m:
            n = _int_money(m.group(1))
            if n:
                return n
    # Last resort: MSRP / tagging (sticker) rather than $0
    for key in ("VehicleMsrp", "TaggingPrice", "MSRP", "msrp"):
        n = _int_money(card.get(key))
        if n:
            return n
    return 0


def parse_srp_config_from_html(html: str, page_url: str = "") -> dict[str, Any] | None:
    """Extract Cosmos API config from ``dlron-srp-model`` (+ /resources/ dealer code).

    Works on the UTF-16-decoded ``moses_layout.txt`` dump and live SRP HTML.
    """
    text = decode_entities(html or "")
    if not text:
        return None

    m = _DLRON_SRP_RE.search(text)
    if not m:
        return None
    try:
        model = json.loads(m.group(1))
    except (json.JSONDecodeError, ValueError, TypeError):
        return None

    dealer_id = model.get("DealerId")
    page_id = model.get("PageId")
    base_filter = str(model.get("BaseFilter") or "").strip()
    if not dealer_id or not page_id:
        return None

    code_m = _DEALER_CODE_RE.search(text) or _DEALER_CODE_FALLBACK_RE.search(text)
    dealer_code = code_m.group(1) if code_m else ""
    # Prefer the vhcliaa-style code used by Cosmos inventory-widget paths.
    for cm in _DEALER_CODE_FALLBACK_RE.finditer(text):
        cand = cm.group(1)
        if cand in ("vhcliaa", "external", "global"):
            if cand == "vhcliaa":
                dealer_code = cand
                break
        elif not dealer_code:
            dealer_code = cand
    if not dealer_code:
        return None

    parsed = urlparse(page_url or "")
    if parsed.scheme and parsed.netloc:
        base_url = f"{parsed.scheme}://{parsed.netloc}"
    else:
        host_m = re.search(
            r'https?://(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})',
            text,
            re.I,
        )
        base_url = f"https://{host_m.group(0).split('://', 1)[-1]}" if host_m else ""
        # Prefer canonical / known Moses host from the dump.
        can = re.search(
            r'rel=["\']canonical["\'][^>]+href=["\'](https?://[^"\']+)["\']',
            text,
            re.I,
        ) or re.search(
            r'href=["\'](https?://[^"\']+)["\'][^>]+rel=["\']canonical["\']',
            text,
            re.I,
        )
        if can:
            p2 = urlparse(can.group(1))
            if p2.scheme and p2.netloc:
                base_url = f"{p2.scheme}://{p2.netloc}"

    if not base_url:
        return None

    page_vehicle_type = str(model.get("PageVehicleType") or "").strip()
    return {
        "dealer_code": dealer_code,
        "dealer_id": int(dealer_id),
        "page_id": int(page_id),
        "base_filter": base_filter,
        "base_url": base_url,
        "page_vehicle_type": page_vehicle_type,
        "raw_model": model,
    }


def looks_like_skeleton_srp(html: str) -> bool:
    """True when the page is a DealerOn SPA shell without hydrated cards."""
    text = html or ""
    if not _DLRON_SRP_RE.search(text):
        return False
    if re.search(r'class=["\'][^"\']*\bvehicle-card\b[^"\']*\bskeleton\b', text, re.I):
        return True
    m = _DLRON_SRP_RE.search(text)
    if not m:
        return False
    try:
        model = json.loads(m.group(1))
    except Exception:
        return False
    vlm = model.get("VehicleListModel")
    return isinstance(vlm, list) and len(vlm) == 0


def normalize_cosmos_card(
    vc: dict[str, Any],
    *,
    base_url: str,
    condition: str = "New",
) -> dict[str, Any] | None:
    """Map a Cosmos ``VehicleCard`` dict to the scraper schema (pre-normalize)."""
    if not isinstance(vc, dict):
        return None
    vin = clean_text(vc.get("VehicleVin") or "").upper()
    if not vin:
        vin = clean_text(
            ((vc.get("VehicleImageModel") or {}).get("VehicleImageCarouselModel") or {})
            .get("Vin")
            or ""
        ).upper()
    year = _int_money(vc.get("VehicleYear") or vc.get("VehicleRuleAdjustedYear"))
    # year as money helper strips non-digits fine for 2024
    if year and (year < 1980 or year > 2100):
        year = 0
    make = clean_text(vc.get("VehicleMake") or "")
    model = clean_text(vc.get("VehicleModel") or "")
    if not vin and not (year and make and model):
        return None

    trim = clean_text(vc.get("VehicleTrim") or vc.get("VehicleRuleAdjustedTrim") or "")
    stock_raw = clean_text(vc.get("VehicleStockNumber") or "")
    stock = sanitize_stock_number(stock_raw, vin=vin, year=year) or ""
    vdp = clean_text(vc.get("VehicleDetailUrl") or "")
    if vdp:
        vdp = absolutize(vdp, base_url)
    if not stock:
        stock = resolve_stock_number(
            {"stockNumber": stock_raw, "link": vdp},
            "",
            vin=vin,
            year=year,
            link=vdp,
        )

    miles = _int_money(vc.get("VehicleMileage"))
    if miles <= 0:
        # e.g. Mileage: "5k mi"
        mil_label = clean_text(vc.get("Mileage") or "")
        km = re.search(r"([\d.]+)\s*k\b", mil_label, re.I)
        if km:
            try:
                miles = int(float(km.group(1)) * 1000)
            except ValueError:
                miles = 0
        else:
            md = re.search(r"([\d,]+)", mil_label)
            if md:
                miles = _int_money(md.group(1))

    color = clean_text(
        vc.get("ExteriorColorLabel")
        or vc.get("VehicleGenericColor")
        or ""
    )
    price = extract_asking_price(vc)

    photo = ""
    img_model = vc.get("VehicleImageModel") or {}
    if isinstance(img_model, dict):
        photo = clean_text(img_model.get("VehiclePhotoSrc") or "")
    if photo:
        photo = absolutize(photo, base_url)

    raw_cond = clean_text(vc.get("VehicleCondition") or vc.get("VehicleType") or "").lower()
    if "new" in raw_cond:
        norm_cond = "New"
    elif any(x in raw_cond for x in ("used", "pre-owned", "pre owned", "certified")):
        norm_cond = "Used"
    else:
        norm_cond = (condition or "Used").strip().title()
        if norm_cond not in ("New", "Used"):
            norm_cond = "Used"

    # Optional PriceStak HTML for DOM field enrichers
    wasabi = vc.get("WasabiVehiclePricingPanelViewModel") or {}
    stak = (wasabi.get("PriceStakViewModel") or {}) if isinstance(wasabi, dict) else {}
    tabs = (stak.get("PriceStakTabsModel") or {}) if isinstance(stak, dict) else {}
    buy_html = tabs.get("BuyContent") if isinstance(tabs, dict) else ""
    html_blob = buy_html if isinstance(buy_html, str) else ""

    raw = {
        "vin": vin,
        "stockNumber": stock,
        "year": year,
        "make": make,
        "model": model,
        "trim": trim,
        "price": price,
        "mileage": miles,
        "exteriorColor": color,
        "link": vdp,
        "imageUrl": photo,
        "condition": norm_cond,
        "location": clean_text(vc.get("DealerLocatedAtCity") or vc.get("VehicleLocation") or ""),
        "_html": html_blob,
        "_source": "dealeron_cosmos",
    }
    return normalize_vehicle(raw, condition=norm_cond)


def fetch_cosmos_page(
    config: dict[str, Any],
    *,
    page: int = 1,
    page_size: int = 12,
    timeout: int = 25,
) -> dict[str, Any] | None:
    """GET one Cosmos SRP page; return parsed JSON or None."""
    base_url = config["base_url"]
    dealer_code = config["dealer_code"]
    dealer_id = config["dealer_id"]
    page_id = config["page_id"]
    base_filter = config.get("base_filter") or ""
    b64_filter = base64.b64encode(base_filter.encode()).decode().replace("+", "%2B")
    url = (
        f"{base_url.rstrip('/')}/api/{dealer_code}"
        f"/vehicle-pages/cosmos/srp/vehicles/{dealer_id}/{page_id}"
        f"?baseFilter={b64_filter}&pn={int(page_size)}&pt={int(page)}"
    )
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": _DEFAULT_UA,
            "Accept": "application/json, text/plain, */*",
            "Referer": f"{base_url.rstrip('/')}/",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        return json.loads(body.decode("utf-8", errors="replace"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, OSError):
        return None


def vehicles_from_cosmos_payload(
    data: dict[str, Any] | None,
    *,
    base_url: str,
    condition: str = "New",
) -> list[dict[str, Any]]:
    """Parse ``DisplayCards[].VehicleCard`` from a Cosmos API response."""
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for card_wrap in data.get("DisplayCards") or []:
        if not isinstance(card_wrap, dict):
            continue
        if card_wrap.get("IsAdCard"):
            continue
        vc = card_wrap.get("VehicleCard")
        if not isinstance(vc, dict):
            continue
        norm = normalize_cosmos_card(vc, base_url=base_url, condition=condition)
        if not norm:
            continue
        vin = (norm.get("vin") or "").upper()
        if not vin or vin in seen:
            continue
        seen.add(vin)
        out.append(norm)
    return out


def extract_cosmos_inventory(
    html: str,
    page_url: str,
    *,
    condition: str | None = None,
    max_pages: int = 1,
    page_size: int = 12,
    timeout: int = 25,
) -> list[dict[str, Any]]:
    """Parse SRP config from HTML and fetch Cosmos VehicleCards.

    Designed for skeleton dumps like ``moses_layout.txt`` where DOM cards are
    empty placeholders but ``dlron-srp-model`` carries DealerId / PageId /
    BaseFilter.
    """
    config = parse_srp_config_from_html(html, page_url)
    if not config:
        return []

    cond = (condition or "").strip().title()
    if cond not in ("New", "Used"):
        pvt = str(config.get("page_vehicle_type") or "").lower()
        if "new" in pvt:
            cond = "New"
        elif "used" in pvt:
            cond = "Used"
        else:
            path = (urlparse(page_url).path or "").lower()
            cond = "New" if ("new" in path and "used" not in path) else "Used"

    vehicles: list[dict[str, Any]] = []
    for pt in range(1, max(1, max_pages) + 1):
        payload = fetch_cosmos_page(
            config, page=pt, page_size=page_size, timeout=timeout,
        )
        batch = vehicles_from_cosmos_payload(
            payload, base_url=config["base_url"], condition=cond,
        )
        if not batch:
            break
        vehicles.extend(batch)
        # Stop early when API reports a single page
        paging = (payload or {}).get("Paging") or {}
        total_pages = _int_money(paging.get("TotalPages") or paging.get("totalPages"))
        if total_pages and pt >= total_pages:
            break
    # Dedupe across pages
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for v in vehicles:
        vin = (v.get("vin") or "").upper()
        if not vin or vin in seen:
            continue
        seen.add(vin)
        out.append(v)
    return out
