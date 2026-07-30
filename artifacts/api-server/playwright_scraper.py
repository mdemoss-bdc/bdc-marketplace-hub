"""playwright_scraper.py — Headless browser inventory scraper.

Public API
----------
    fetch_with_playwright(url: str, condition: str) -> list[dict]

Strategy
--------
  1. Launch Chromium with network response interception enabled.
  2. Register a listener that captures every JSON response whose body contains
     vehicle-shaped records (VIN fields, year/make/model combos).  These are
     the raw payloads from internal inventory APIs (XHR / fetch calls) that the
     browser SRP fires in the background.
  3. Navigate to the SRP URL.  Wait for network idle so in-flight XHRs complete.
  4. PRIMARY PATH — intercepted API JSON:
       If any captured response contains VIN records, parse them directly.
       These are the most structured records available and need the least cleanup.
  5. SECONDARY PATH — rendered DOM:
       If no intercepts yielded vehicles, parse the fully-rendered HTML from the
       DOM (page.content()).  At this point JS has executed and the full
       inventory grid is in the DOM.
  6. PAGINATION:
       Detect a "Next" button or page-number links.  Click each one, wait for
       network idle, re-parse.  Stop after 30 pages or 3 consecutive pages that
       add zero new VINs.
  7. INFINITE SCROLL:
       When no Next button is found, scroll to the bottom of the page up to
       20 times and wait for new content to load after each scroll.
  8. Return a VIN-deduplicated list with condition locked and stock_number
     sanitised.

Performance
-----------
  Each URL gets a 90 s wall-clock budget (Playwright timeout = 30 s per
  navigation; pagination gets 20 s per page).  The browser is launched fresh
  per call and shut down cleanly afterward so no state bleeds between URLs.

  The scraper is safe to run from a background thread (it is fully synchronous
  and does not share any globals with bdc_engine.py beyond the VIN/stock
  utility helpers it imports).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from typing import Any

# ---------------------------------------------------------------------------
# VIN / stock-number helpers (duplicated here to avoid circular imports)
# ---------------------------------------------------------------------------

_VIN_RE   = re.compile(r'\b([A-HJ-NPR-Z0-9]{17})\b')
_STOCK_RE = re.compile(r'\b([A-Z]{0,4}\d{3,8}[A-Z]?)\b', re.IGNORECASE)

_COND_LOWER_MAP = {
    'new': 'New', 'used': 'Used', 'certified': 'Used', 'cpo': 'Used',
    'pre-owned': 'Used', 'preowned': 'Used',
}


def _lock_condition(raw: Any, target: str) -> str:
    if isinstance(raw, str):
        mapped = _COND_LOWER_MAP.get(raw.strip().lower(), '')
        if mapped == target:
            return target
    return target


def _stock_safe(val: Any) -> str:
    if not val:
        return 'N/A'
    s = str(val).strip()
    if not s or s.lower() in ('null', 'none', 'n/a', '0'):
        return 'N/A'
    return s


# Empty / placeholder tokens scrapers commonly emit for missing numerics
_EMPTY_NUM_TOKENS = frozenset({
    'n/a', 'na', 'none', 'null', 'undefined',
    '-', '—', '–', '−', '--', '---', '.',
})


def _price_int(val: Any, default: int = 0) -> int:
    """Coerce a price / year / integer-like value to int.

    Strips $, commas, whitespace, and treats em/en dashes as empty → default.
    Never raises — PostgreSQL INTEGER columns reject empty strings.
    """
    if val is None:
        return default
    if isinstance(val, (int, float)):
        try:
            return int(val)
        except (ValueError, OverflowError):
            return default
    s = str(val).strip()
    if not s or s.lower() in _EMPTY_NUM_TOKENS:
        return default
    # Strip decoration: $, commas, whitespace, common currency prefixes
    s = re.sub(r'(?i)^(usd|cad|\$)+', '', s)
    s = re.sub(r'[,$\s]', '', s)
    # Keep only the integer part (digits before any decimal point)
    digits = re.sub(r'[^\d]', '', s.split('.')[0])
    if not digits:
        return default
    try:
        return int(digits)
    except (ValueError, OverflowError):
        return default


def _mileage_int(val: Any, default: int = 0) -> int:
    """Coerce a mileage value to int. Strips commas, spaces, em dashes, and
    unit suffixes (mi, km, miles) so '1,016 mi' → 1016 and '—' → 0."""
    if val is None:
        return default
    if isinstance(val, (int, float)):
        try:
            return int(val)
        except (ValueError, OverflowError):
            return default
    s = str(val).strip()
    if not s or s.lower() in _EMPTY_NUM_TOKENS:
        return default
    # Strip commas, spaces, and any trailing unit label
    s = re.sub(r'[,\s]', '', s)
    s = re.sub(r'(?i)(miles?|km|mi)$', '', s)
    digits = re.sub(r'[^\d]', '', s.split('.')[0])
    if not digits:
        return default
    try:
        return int(digits)
    except (ValueError, OverflowError):
        return default


# ---------------------------------------------------------------------------
# Recursive vehicle extractor — works on any JSON shape
# ---------------------------------------------------------------------------

# Field-name candidates, in PRIORITY ORDER (tuples, not sets — set iteration
# order is arbitrary, which previously made field selection non-deterministic
# between runs, e.g. picking MSRP over the real internet price at random).
#
# The ``Vehicle*``-prefixed names come from DealerOn / Cosmos SRP payloads
# (`DisplayCards[].VehicleCard`), which is the dominant platform among the
# dealer sites we scrape.
_VIN_FIELD_NAMES: tuple[str, ...] = (
    'VehicleVin', 'vehicleVin', 'vin', 'Vin', 'VIN',
    'vehicle_vin', 'stockVin',
)
_STOCK_FIELDS: tuple[str, ...] = (
    'VehicleStockNumber', 'stockNumber', 'StockNumber', 'stock_number',
    'stock', 'Stock', 'stockNo', 'stockNum', 'stocknumber', 'lot_number',
)
_YEAR_FIELDS: tuple[str, ...] = (
    'VehicleYear', 'VehicleRuleAdjustedYear', 'year', 'Year',
    'modelYear', 'model_year', 'vehicleYear',
)
_MAKE_FIELDS: tuple[str, ...] = (
    'VehicleMake', 'make', 'Make', 'vehicleMake', 'vehicle_make', 'makeName',
)
_MODEL_FIELDS: tuple[str, ...] = (
    'VehicleModel', 'model', 'Model', 'vehicleModel', 'vehicle_model',
    'modelName',
)
_TRIM_FIELDS: tuple[str, ...] = (
    'VehicleTrim', 'VehicleRuleAdjustedTrim', 'trim', 'Trim', 'trimLevel',
    'series', 'Series',
)
# The price a customer actually pays.
_PRICE_FIELDS: tuple[str, ...] = (
    'VehicleInternetPrice', 'internetPrice', 'sellingPrice', 'selling_price',
    'salePrice', 'price', 'Price', 'finalPrice', 'displayPrice',
)
# Sticker / window price. Only used for the asking price as a last resort, so a
# card never renders as "$0", but never in preference to a real selling price.
_STICKER_FIELDS: tuple[str, ...] = (
    'TaggingPrice', 'VehicleMsrp', 'msrp', 'Msrp', 'MSRP', 'listPrice',
)
_RETAIL_FIELDS: tuple[str, ...] = (
    'VehicleMsrp', 'msrp', 'Msrp', 'MSRP', 'retailPrice', 'listPrice',
)
_MILEAGE_FIELDS: tuple[str, ...] = (
    'VehicleMileage', 'mileage', 'Mileage', 'miles', 'Miles', 'odometer',
    'odometerReading', 'odometer_reading',
)
_COND_FIELDS: tuple[str, ...] = (
    'VehicleCondition', 'VehicleType', 'condition', 'Condition',
    'vehicleCondition', 'type', 'Type', 'inventoryType', 'usedOrNew',
)
_EXT_COLOR_FIELDS: tuple[str, ...] = (
    'ExteriorColorLabel', 'ExteriorColorIconTitleAttribute',
    'VehicleGenericColor', 'exteriorColor', 'exterior_color',
    'color', 'Color', 'extColor',
)
_INT_COLOR_FIELDS: tuple[str, ...] = (
    'InteriorColorLabel', 'InteriorColorIconTitleAttribute',
    'interiorColor', 'interior_color', 'intColor',
)
_IMG_FIELDS: tuple[str, ...] = (
    'VehiclePhotoSrc', 'image', 'imageUrl', 'image_url', 'primaryImage',
    'photoUrl', 'photo', 'thumbUrl', 'img',
)
# Nested containers that hold the image fields one level down.
_IMG_CONTAINERS: tuple[str, ...] = (
    'VehicleImageModel', 'imageModel', 'images', 'media',
)
_VDP_FIELDS: tuple[str, ...] = (
    'VehicleDetailUrl', 'vdpUrl', 'detailUrl', 'vehicleUrl', 'url', 'Url',
)

# DealerOn ships the full price breakdown as a base64 blob even when
# VehicleInternetPrice is zeroed out by the OEM (Ford Direct does this on every
# SRP).  Decoded form:
#   "MSRP:37236.0;Internet Price:34488.0;Selling Price:34488.0;
#    calc_Savings:2748.0;calc_Dealer Doc Fee:575.0"
_PRICE_LIBRARY_FIELDS: tuple[str, ...] = (
    'VehiclePriceLibrary', 'priceLibrary', 'PriceLibrary',
)
# Label priority when reading the decoded breakdown for the asking price.
# MSRP is deliberately absent — it is a sticker value, handled separately.
_PL_PRICE_LABELS = (
    'internet price', 'selling price', 'sale price', 'e-price', 'eprice',
    'calc_internet price',
)


def _decode_price_library(raw: str) -> dict[str, int]:
    """Decode a DealerOn base64 price-library blob into {label: dollars}.

    Returns {} when the value is missing or undecodable.
    """
    if not raw or len(raw) < 8:
        return {}
    try:
        import base64
        text = base64.b64decode(raw + '=' * (-len(raw) % 4)).decode(
            'utf-8', 'replace'
        )
    except Exception:
        return {}
    if ':' not in text:
        return {}
    out: dict[str, int] = {}
    for part in text.split(';'):
        label, _, value = part.partition(':')
        label = label.strip().lower()
        if not label or not value:
            continue
        dollars = _price_int(value)
        if dollars:
            out[label] = dollars
    return out


def _first_str(obj: dict, fields: tuple[str, ...]) -> str:
    """First non-empty stringified value among ``fields`` (priority order)."""
    for f in fields:
        v = obj.get(f)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return ''


def _first_money(obj: dict, fields: tuple[str, ...]) -> int:
    """First NON-ZERO dollar amount among ``fields`` (priority order).

    Skipping zeros matters: DealerOn returns ``VehicleInternetPrice = 0.0`` on
    price-suppressed OEM inventory, and a naive "first present field" lookup
    would lock in 0 and never consult MSRP or the price library.
    """
    for f in fields:
        v = obj.get(f)
        if v is None:
            continue
        if isinstance(v, dict):
            for sub in ('amount', 'value', 'price', 'selling', 'formatted'):
                cents = _price_int(v.get(sub))
                if cents:
                    return cents
            continue
        dollars = _price_int(v)
        if dollars:
            return dollars
    return 0


def _absolutise(link: str, base_url: str) -> str:
    """Resolve a site-relative asset/page path against the page origin."""
    link = (link or '').strip()
    if not link or not base_url:
        return link
    if link.startswith(('http://', 'https://', 'data:')):
        return link
    if link.startswith('//'):
        return 'https:' + link
    return base_url.rstrip('/') + '/' + link.lstrip('/')


def _extract_vehicle(
    obj: dict, condition: str, base_url: str = ''
) -> dict | None:
    """Convert a raw API record dict into a normalised vehicle dict."""
    vin = ''
    for f in _VIN_FIELD_NAMES:
        v = obj.get(f)
        if v and isinstance(v, str) and _VIN_RE.fullmatch(v.strip()):
            vin = v.strip().upper()
            break
    if not vin:
        return None

    stock = _stock_safe(_first_str(obj, _STOCK_FIELDS))
    year  = _first_str(obj, _YEAR_FIELDS)
    make  = _first_str(obj, _MAKE_FIELDS)
    model = _first_str(obj, _MODEL_FIELDS)
    trim  = _first_str(obj, _TRIM_FIELDS)
    miles = _mileage_int(_first_str(obj, _MILEAGE_FIELDS))
    ext_color = _first_str(obj, _EXT_COLOR_FIELDS)
    int_color = _first_str(obj, _INT_COLOR_FIELDS)
    img   = _first_str(obj, _IMG_FIELDS)
    doc_fee = 0
    savings = 0

    # Nested image containers: {VehicleImageModel: {VehiclePhotoSrc: '...'}}
    if not img:
        for cf in _IMG_CONTAINERS:
            container = obj.get(cf)
            if isinstance(container, dict):
                img = _first_str(container, _IMG_FIELDS) or str(
                    container.get('url') or container.get('src') or ''
                ).strip()
            elif isinstance(container, list) and container:
                head = container[0]
                if isinstance(head, dict):
                    img = _first_str(head, _IMG_FIELDS) or str(
                        head.get('url') or head.get('src') or ''
                    ).strip()
                elif isinstance(head, str):
                    img = head.strip()
            if img:
                break

    # ── Asking price ─────────────────────────────────────────────────────────
    # Resolution order matters. OEM programs (Ford Direct especially) zero out
    # VehicleInternetPrice on the SRP while still shipping the true selling
    # price inside the base64 price library, and TaggingPrice mirrors MSRP.
    # Reading the library first is what keeps the sticker price from being
    # published as the asking price.
    library = _decode_price_library(_first_str(obj, _PRICE_LIBRARY_FIELDS))
    price = 0
    for label in _PL_PRICE_LABELS:
        if library.get(label):
            price = library[label]
            break
    price = price or _first_money(obj, _PRICE_FIELDS)
    retail = library.get('msrp', 0) or _first_money(obj, _RETAIL_FIELDS)
    # Last resort: show the sticker rather than $0.
    price = price or retail or _first_money(obj, _STICKER_FIELDS)
    if library:
        savings = library.get('calc_savings', 0)
        doc_fee = library.get('calc_dealer doc fee', 0)

    # A retail price only means something when it exceeds the asking price.
    if retail and price and retail <= price:
        retail = 0
    if savings and retail and price:
        savings = max(savings, retail - price)

    # Location — try common field names
    location = ''
    for lf in ('location', 'Location', 'rooftop', 'dealerName',
                'dealer_name', 'store', 'storeName', 'lot'):
        v = obj.get(lf)
        if v and isinstance(v, str) and v.strip():
            location = v.strip()
            break

    return {
        'vin':          vin,
        'stock_number': stock,
        'year':         year,
        'make':         make,
        'model':        model,
        'trim':         trim,
        'price':        price,
        'retail_price': retail,
        'savings':      savings,
        'doc_fee':      doc_fee,
        'mileage':      miles,
        'condition':    condition,
        'color':          ext_color,
        'exterior_color': ext_color,
        'interior_color': int_color,
        'image_url':    _absolutise(img, base_url),
        'location':     location,
        'vdp_url':      _absolutise(_first_str(obj, _VDP_FIELDS), base_url),
    }


# Fields that make a record worth keeping when the same VIN shows up twice.
_RICHNESS_FIELDS = (
    'year', 'make', 'model', 'trim', 'price', 'mileage',
    'exterior_color', 'image_url', 'vdp_url', 'stock_number',
)


def _richness(v: dict) -> int:
    """Count populated display fields — used to pick the best duplicate."""
    score = 0
    for key in _RICHNESS_FIELDS:
        val = v.get(key)
        if val in (None, '', 0, 'N/A'):
            continue
        score += 1
    return score


def _merge_vehicle(base: dict, other: dict) -> dict:
    """Fill blank fields in ``base`` from ``other`` (same VIN, two sources)."""
    for key, val in other.items():
        if val in (None, '', 0, 'N/A'):
            continue
        if base.get(key) in (None, '', 0, 'N/A'):
            base[key] = val
    return base


def _collapse_by_vin(vehicles: list[dict]) -> list[dict]:
    """Collapse duplicate VINs into one merged record, richest field wins.

    A single SRP card can surface the same VIN through several nested widget
    objects; without this, VIN-only stubs would shadow the fully populated card
    record and land in the database as blank rows.
    """
    merged: dict[str, dict] = {}
    order: list[str] = []
    passthrough: list[dict] = []
    for v in vehicles:
        vin = v.get('vin', '')
        if not vin:
            passthrough.append(v)
            continue
        if vin not in merged:
            merged[vin] = dict(v)
            order.append(vin)
            continue
        # Keep whichever record has more populated fields as the base.
        if _richness(v) > _richness(merged[vin]):
            richer, poorer = dict(v), merged[vin]
        else:
            richer, poorer = merged[vin], v
        merged[vin] = _merge_vehicle(richer, poorer)
    return [merged[vin] for vin in order] + passthrough


def _extract_vehicles_recursive(
    data: Any,
    condition: str,
    _depth: int = 0,
    _seen_ids: set | None = None,
    base_url: str = '',
) -> list[dict]:
    """Recursively walk arbitrary JSON and extract vehicle records."""
    if _depth > 8:
        return []
    if _seen_ids is None:
        _seen_ids = set()

    results: list[dict] = []
    if isinstance(data, list):
        for item in data:
            results.extend(
                _extract_vehicles_recursive(
                    item, condition, _depth + 1, _seen_ids, base_url
                )
            )
    elif isinstance(data, dict):
        # Try this node itself as a vehicle record
        obj_id = id(data)
        if obj_id not in _seen_ids:
            _seen_ids.add(obj_id)
            v = _extract_vehicle(data, condition, base_url)
            # A record carrying nothing but a VIN is almost always a nested
            # widget stub (compare button, image carousel, analytics tag) whose
            # real siblings live on the parent card.  Keep walking so the parent
            # or a richer sibling wins instead.
            if v and _richness(v) >= 2:
                results.append(v)
                return results  # don't recurse INTO a real vehicle object
            if v:
                results.append(v)
        # Recurse into values
        for val in data.values():
            if isinstance(val, (dict, list)):
                results.extend(
                    _extract_vehicles_recursive(
                        val, condition, _depth + 1, _seen_ids, base_url
                    )
                )
    return results


# ---------------------------------------------------------------------------
# Intercepted-response JSON harvest
# ---------------------------------------------------------------------------

# Minimum number of valid VINs in a JSON response before we trust it as an
# inventory payload rather than a coincidental JSON blob (config, analytics…).
_MIN_VIN_THRESHOLD = 3

# Max bytes to parse from a single intercepted response (4 MB).
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024


def _response_looks_like_inventory(data: Any) -> bool:
    """Quick heuristic: does this JSON tree likely contain vehicle records?"""
    text = json.dumps(data) if not isinstance(data, str) else data
    vin_count = len(_VIN_RE.findall(text))
    return vin_count >= _MIN_VIN_THRESHOLD


# ---------------------------------------------------------------------------
# DOM-based extraction helpers
# ---------------------------------------------------------------------------

# Selector patterns that reliably locate inventory cards in rendered HTML
_CARD_SELECTORS = (
    '[data-vin]',
    '.srp-vehicle-card',
    '.vehicle-card',
    '.inventory-item',
    '.inventory-card',
    '.vehicle-listing',
    '[class*="vehicle-card"]',
    '[class*="inventory-card"]',
    '[class*="inventory-item"]',
    '[class*="srp-vehicle-card"]',
    '[class*="srp-card"]',
    '[class*="vdp-card"]',
    '[class*="listing-card"]',
    '[id*="vehicle-"]',
    'article[data-vin]',
    'li[data-vin]',
    'div[data-vin]',
)

_NEXT_SELECTORS = (
    # Generic text / aria-label patterns
    'a[aria-label*="Next" i]',
    'button[aria-label*="Next" i]',
    'a[title*="Next" i]',
    # Common pagination class names
    '.pagination-next a',
    '.pagination .next a',
    '.pager-next a',
    'li.next a',
    'a.next',
    'button.next',
    '[class*="next-page"]',
    '[class*="nextPage"]',
    # Text-content match handled separately via JS evaluation
)


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

_CHROMIUM_ARGS = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--no-first-run',
    '--no-zygote',
    # '--single-process' intentionally omitted: causes Playwright subprocess
    # instability; Playwright manages its own browser process lifecycle.
    '--mute-audio',
    '--window-size=1366,768',
]

# Realistic desktop UA — avoids "Headless" fingerprint leak in older UA strings
_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/138.0.0.0 Safari/537.36'
)


def _resolve_chromium_executable() -> str | None:
    """Locate a usable Chromium/Chrome/Edge binary across OSes."""
    candidates = (
        'chromium-browser', 'chromium', 'google-chrome', 'chrome',
        'msedge', 'microsoft-edge',
        # Common Windows install locations (when not on PATH)
        r'C:\Program Files\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    )
    for name in candidates:
        if os.path.isabs(name) or (len(name) > 1 and name[1] == ':'):
            if os.path.isfile(name):
                return name
            continue
        found = shutil.which(name)
        if found:
            return found
    return None


def _launch_chromium(pw):
    """Launch Chromium for scraping with broad Windows/Linux fallbacks.

    Order:
      1. Playwright-managed Chromium (``playwright install chromium``)
      2. Installed Chrome / Edge via Playwright channel
      3. Explicit system executable path
    """
    launch_kwargs = {'headless': True, 'args': list(_CHROMIUM_ARGS)}

    # 1. Bundled Playwright browser (preferred)
    try:
        browser = pw.chromium.launch(**launch_kwargs)
        print('[PW] Launched Playwright-managed Chromium')
        return browser
    except Exception as err:
        print(f'[PW] Bundled Chromium unavailable: {err}')

    # 2. Channel launch (uses locally installed Chrome / Edge)
    for channel in ('chrome', 'msedge', 'chromium'):
        try:
            browser = pw.chromium.launch(channel=channel, **launch_kwargs)
            print(f'[PW] Launched via channel={channel!r}')
            return browser
        except Exception as err:
            print(f'[PW] channel={channel!r} failed: {err}')

    # 3. Explicit executable
    chromium_path = _resolve_chromium_executable()
    if chromium_path:
        try:
            browser = pw.chromium.launch(
                executable_path=chromium_path, **launch_kwargs
            )
            print(f'[PW] Launched system browser at {chromium_path!r}')
            return browser
        except Exception as err:
            print(f'[PW] executable_path launch failed: {err}')

    raise RuntimeError(
        'No Chromium/Chrome/Edge available. '
        'Run: python -m pip install playwright && python -m playwright install chromium'
    )


def fetch_with_playwright(url: str, condition: str) -> list[dict]:
    """Full headless-browser scrape of a dealer SRP page.

    Returns a VIN-deduplicated, condition-locked list of vehicle dicts.
    Returns [] on any fatal error (browser launch failure, timeout, etc.).
    """
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except ImportError:
        print('[PW] playwright not installed - skipping headless scrape')
        return []

    print(f'[PW] Starting headless scrape: {url!r} ({condition})')
    t0 = time.monotonic()

    # Origin of the SRP, used to absolutise site-relative photo and VDP paths
    # (DealerOn returns '/inventoryphotos/...' rather than a full URL).
    _om = re.match(r'^(https?://[^/]+)', url.strip(), re.IGNORECASE)
    page_origin = _om.group(1) if _om else ''

    # ── Shared state for the response-intercept closure ──────────────────────
    intercepted_payloads: list[Any] = []   # raw parsed JSON objects

    def _on_response(response) -> None:
        """Fires for every HTTP response the page receives."""
        try:
            ct = response.headers.get('content-type', '')
            if 'json' not in ct and 'javascript' not in ct:
                return
            # Skip tiny responses — not inventory data
            body = response.body()
            if len(body) < 200 or len(body) > _MAX_RESPONSE_BYTES:
                return
            if b'vin' not in body.lower() and b'VIN' not in body:
                return  # Fast-path discard
            data = json.loads(body)
            if _response_looks_like_inventory(data):
                intercepted_payloads.append(data)
                print(f'[PW] Intercepted inventory response from {response.url!r}')
        except Exception:
            pass  # Any decode / parse failure is silently ignored

    try:
        with sync_playwright() as pw:
            try:
                browser = _launch_chromium(pw)
            except Exception as launch_err:
                print(f'[PW] Browser launch failed - skipping headless scrape: {launch_err}')
                return []
            ctx = browser.new_context(
                user_agent=_USER_AGENT,
                viewport={'width': 1366, 'height': 768},
                extra_http_headers={
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept':          (
                        'text/html,application/xhtml+xml,application/xml;'
                        'q=0.9,image/avif,image/webp,*/*;q=0.8'
                    ),
                },
                java_script_enabled=True,
            )
            page = ctx.new_page()
            page.on('response', _on_response)

            # ── Navigate to the SRP ───────────────────────────────────────
            try:
                page.goto(url, timeout=30_000, wait_until='domcontentloaded')
                # Give background XHRs a chance to complete
                try:
                    page.wait_for_load_state('networkidle', timeout=15_000)
                except PWTimeout:
                    pass  # networkidle is best-effort; continue with what we have
                # Wait for common dealership inventory card selectors to render
                for sel in _CARD_SELECTORS[:8]:
                    try:
                        page.wait_for_selector(sel, timeout=4_000)
                        print(f'[PW] DOM ready - matched selector {sel!r}')
                        break
                    except PWTimeout:
                        continue
            except PWTimeout:
                print(f'[PW] Navigation timeout for {url!r}')
                browser.close()
                return []
            except Exception as err:
                print(f'[PW] Navigation error for {url!r}: {err}')
                browser.close()
                return []

            all_vehicles: list[dict] = []
            seen_vins: dict[str, dict] = {}

            def _absorb(vlist: list[dict]) -> int:
                """Add new-VIN vehicles; merge richer data into known VINs.

                A repeat VIN is not simply discarded: the intercepted API JSON
                and the rendered DOM often each carry fields the other lacks
                (price vs. photo, trim vs. mileage), so blanks are filled from
                whichever source has them.  Only genuinely new VINs count toward
                the return value, which drives pagination's stale-page detector.
                """
                added = 0
                for v in vlist:
                    vin = v.get('vin', '')
                    if not vin:
                        all_vehicles.append(v)
                        added += 1
                        continue
                    known = seen_vins.get(vin)
                    if known is not None:
                        _merge_vehicle(known, v)
                        continue
                    seen_vins[vin] = v
                    all_vehicles.append(v)
                    added += 1
                return added

            def _parse_current_page() -> list[dict]:
                """Parse vehicles from the current page state.

                First tries intercepted JSON (most structured), then falls back
                to rendered DOM parsing.
                """
                # 1. Intercepted JSON payloads
                for payload in intercepted_payloads:
                    vs = _extract_vehicles_recursive(
                        payload, condition, base_url=page_origin
                    )
                    if vs:
                        return _collapse_by_vin(vs)

                # 2. window.__NEXT_DATA__ / window.__INITIAL_STATE__ / SSR blobs
                for js_expr in (
                    'window.__NEXT_DATA__',
                    'window.__INITIAL_STATE__',
                    'window.__PRELOADED_STATE__',
                    'window.initialState',
                    'window.APP_STATE',
                    'window.serverData',
                    'window.SRP_DATA',
                    'window.inventoryData',
                    'window.DealerOnSrpData',
                    'window.ddcData',
                    'window.vinData',
                    'window.hn_inventory',
                    'window.__vin_data',
                    'window.inventoryResults',
                    # W3C Digital Data Layer — Dealer.com / DDC, Cobalt, and most
                    # Adobe-Analytics-instrumented SRPs expose the full vehicle
                    # array here even when the DOM is lazily rendered.
                    'window.digitalData',
                    'window.digitalData.vehicle',
                    'window.digitalData.page.vehicles',
                    'window.dataLayer',
                ):
                    try:
                        blob = page.evaluate(
                            f'(() => {{ try {{ return JSON.stringify({js_expr}); }} '
                            f'catch(e) {{ return null; }} }})()'
                        )
                        if blob and isinstance(blob, str) and len(blob) > 100:
                            data = json.loads(blob)
                            vs = _extract_vehicles_recursive(
                                data, condition, base_url=page_origin
                            )
                            if vs:
                                vs = _collapse_by_vin(vs)
                                print(f'[PW] Extracted {len(vs)} vehicles '
                                      f'from {js_expr}')
                                return vs
                    except Exception:
                        pass

                # 3. Rendered DOM — parse page.content()
                try:
                    html = page.content()
                    return _parse_dom(html, condition, page)
                except Exception:
                    return []

            def _parse_dom(html: str, cond: str, pg) -> list[dict]:
                """Extract vehicles from the fully-rendered DOM HTML.

                Tries JSON-LD / JSON in <script> blocks, then data-vin cards.
                """
                results: list[dict] = []

                # ── JSON in <script type="application/ld+json"> ──────────
                for m in re.finditer(
                    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>'
                    r'([\s\S]+?)</script>',
                    html, re.IGNORECASE
                ):
                    try:
                        data = json.loads(m.group(1))
                        vs = _extract_vehicles_recursive(
                            data, cond, base_url=page_origin
                        )
                        results.extend(vs)
                    except Exception:
                        pass
                if results:
                    return _collapse_by_vin(results)

                # ── JSON in any <script> block ────────────────────────────
                for m in re.finditer(
                    r'<script[^>]*>([\s\S]{100,}?)</script>',
                    html, re.IGNORECASE
                ):
                    body_text = m.group(1).strip()
                    # Must look like it begins with { or [ to be JSON
                    if body_text[:1] not in ('{', '['):
                        continue
                    try:
                        data = json.loads(body_text)
                        vs   = _extract_vehicles_recursive(
                            data, cond, base_url=page_origin
                        )
                        if len(vs) >= _MIN_VIN_THRESHOLD:
                            results.extend(vs)
                    except Exception:
                        pass
                if results:
                    return _collapse_by_vin(results)

                # ── Generic vehicle-card DOM extraction via Playwright ───
                try:
                    card_payload = pg.evaluate(
                        """() => {
                            const sels = [
                              '[data-vin]',
                              '.srp-vehicle-card',
                              '.vehicle-card',
                              '.inventory-item',
                              '.inventory-card',
                              '.vehicle-listing',
                              '[class*="vehicle-card"]',
                              '[class*="inventory-item"]',
                              '[class*="srp-vehicle-card"]',
                            ];
                            const nodes = [];
                            const seen = new Set();
                            for (const sel of sels) {
                              document.querySelectorAll(sel).forEach(el => {
                                if (seen.has(el)) return;
                                seen.add(el);
                                nodes.push(el);
                              });
                            }
                            const vinRe = /\\b([A-HJ-NPR-Z0-9]{17})\\b/i;
                            return nodes.map(el => {
                              // Phase 2: strip script/style/header/footer/nav
                              // before raw text extraction from each card.
                              const clone = el.cloneNode(true);
                              clone.querySelectorAll(
                                'script,style,noscript,svg,iframe,header,footer,nav,aside'
                              ).forEach(n => n.remove());
                              const text = (clone.innerText || clone.textContent || '');
                              const html = clone.outerHTML || '';
                              const vinAttr = el.getAttribute('data-vin') || '';
                              const vinMatch = vinAttr || (text.match(vinRe) || html.match(vinRe) || [])[0] || '';
                              const img = el.querySelector('img');
                              const anchor = el.querySelector('a[href]');
                              // Text fallbacks: most SRP cards render a heading
                              // like "2025 Hyundai Santa Fe Hybrid Calligraphy"
                              // and carry no data-* attributes at all.
                              const heading = (clone.querySelector(
                                'h1,h2,h3,h4,[class*="title"],[class*="Title"],[class*="heading"]'
                              ) || {});
                              const headText = (heading.innerText || heading.textContent || '').trim();
                              const ymm = (headText || text).match(
                                /\\b(19[89]\\d|20[0-4]\\d)\\s+([A-Za-z][A-Za-z-]+)\\s+([^\\n|]{1,40})/
                              ) || [];
                              const priceTxt = (text.match(/\\$\\s?([\\d]{1,3}(?:,\\d{3})+)/) || [])[1] || '';
                              const mileTxt = (text.match(/([\\d]{1,3}(?:,\\d{3})*)\\s*(?:mi\\b|miles\\b)/i) || [])[1] || '';
                              return {
                                vin: (vinAttr || vinMatch || '').toString().toUpperCase(),
                                stock: el.getAttribute('data-stock')
                                  || el.getAttribute('data-stock-number')
                                  || el.getAttribute('data-stocknumber')
                                  || (text.match(/stock\\s*#?\\s*:?\\s*([A-Z0-9-]{3,12})/i) || [])[1]
                                  || '',
                                year: el.getAttribute('data-year') || ymm[1] || '',
                                make: el.getAttribute('data-make') || ymm[2] || '',
                                model: el.getAttribute('data-model')
                                  || (ymm[3] || '').trim().split(/\\s{2,}/)[0] || '',
                                trim: el.getAttribute('data-trim') || '',
                                price: el.getAttribute('data-price')
                                  || el.getAttribute('data-internet-price')
                                  || priceTxt || '',
                                mileage: el.getAttribute('data-mileage')
                                  || el.getAttribute('data-miles')
                                  || mileTxt || '',
                                link: (anchor && anchor.getAttribute('href')) || '',
                                image: (img && (img.getAttribute('src')
                                  || img.getAttribute('data-src') || '')) || '',
                                text: text.slice(0, 800),
                              };
                            }).filter(v => v.vin && v.vin.length === 17);
                        }"""
                    )
                    if isinstance(card_payload, list):
                        try:
                            from inventory_parser import sanitize_vehicle_record as _san_v
                        except ImportError:
                            _san_v = None  # type: ignore[assignment]
                        for row in card_payload:
                            raw_card = {
                                'vin':          str(row.get('vin', '')).upper(),
                                'stock_number': _stock_safe(row.get('stock')),
                                'year':         str(row.get('year') or ''),
                                'make':         str(row.get('make') or ''),
                                'model':        str(row.get('model') or ''),
                                'trim':         str(row.get('trim') or ''),
                                'price':        _price_int(row.get('price')),
                                'mileage':      _mileage_int(row.get('mileage')),
                                'condition':    cond,
                                'color':          '',
                                'exterior_color': '',
                                'interior_color': '',
                                'image_url':    _absolutise(
                                    str(row.get('image') or ''), page_origin
                                ),
                                'location':     '',
                                'vdp_url':      _absolutise(
                                    str(row.get('link') or ''), page_origin
                                ),
                            }
                            if _san_v is not None:
                                try:
                                    raw_card = _san_v(
                                        raw_card, str(row.get('text') or '')
                                    )
                                except Exception:
                                    pass
                            results.append(raw_card)
                except Exception:
                    pass
                if results:
                    seen_cards: set[str] = set()
                    deduped_cards = []
                    for v in results:
                        if v['vin'] not in seen_cards:
                            seen_cards.add(v['vin'])
                            deduped_cards.append(v)
                    return deduped_cards

                # ── Fallback: raw VIN scan of noise-stripped HTML ────────
                try:
                    from dom_inventory import strip_dom_noise as _strip_noise
                    scan_html = _strip_noise(html)
                except Exception:
                    scan_html = html
                vins_in_html = _VIN_RE.findall(scan_html)
                try:
                    from inventory_parser import sanitize_vehicle_record as _san_fb
                except ImportError:
                    _san_fb = None  # type: ignore[assignment]
                for vin in vins_in_html:
                    stock = 'N/A'
                    # Try to find a nearby stock number in a small window
                    idx = scan_html.find(vin)
                    window = scan_html[max(0, idx - 200): idx + 200]
                    sm = _STOCK_RE.search(window)
                    if sm:
                        stock = sm.group(1)
                    raw_fb = {
                        'vin':          vin.upper(),
                        'stock_number': _stock_safe(stock),
                        'year':         '',
                        'make':         '',
                        'model':        '',
                        'trim':         '',
                        'price':        0,
                        'mileage':      0,
                        'condition':    cond,
                        'color':        '',
                        'image_url':    '',
                        'location':     '',
                        'vdp_url':      '',
                    }
                    if _san_fb is not None:
                        try:
                            raw_fb = _san_fb(raw_fb, window)
                        except Exception:
                            pass
                    results.append(raw_fb)
                # Deduplicate in case the same VIN appeared multiple times
                seen: set[str] = set()
                deduped = []
                for v in results:
                    if v['vin'] not in seen:
                        seen.add(v['vin'])
                        deduped.append(v)
                return deduped

            # ── First-page parse ──────────────────────────────────────────
            first_page_vehicles = _parse_current_page()
            _absorb(first_page_vehicles)
            print(f'[Scraper] Page 1: {len(first_page_vehicles)} vehicles found '
                  f'({len(seen_vins)} unique so far)')
            print(f'[PW] Page 1 -> {len(first_page_vehicles)} vehicles '
                  f'({len(seen_vins)} unique so far)')

            # ── Pagination (platform-agnostic) ────────────────────────────
            # DealerOn Cosmos maps page number → ``pt`` and page size → ``pn``
            # (see Wasabi bundle: PageSize="pn", PageNumber="pt").  Generic
            # ``?page=N`` is tried next for non-DealerOn SRPs.  Click / scroll
            # is the final fallback for SPA / infinite-scroll sites.
            MAX_PAGES    = 40
            STALE_STOP   = 2
            stale_streak = 0
            _url_sep     = '&' if '?' in url else '?'
            _is_dealeron = any(
                sig in url.lower()
                for sig in ('.aspx', 'searchnew', 'searchused', 'dlron.us', 'dealeron')
            )

            # '' | 'pt_param' | 'url_param' | 'click' — locked after first success
            _pag_strategy: str = ''

            def _page_url(page_num: int, kind: str) -> str:
                if kind == 'pt':
                    return f"{url}{_url_sep}pt={page_num}"
                return f"{url}{_url_sep}page={page_num}"

            for page_num in range(2, MAX_PAGES + 1):
                _budget = 180.0 if _pag_strategy in ('pt_param', 'url_param') else 120.0
                if time.monotonic() - t0 > _budget:
                    print(f'[PW] Time budget exhausted after page {page_num - 1}')
                    break

                intercepted_payloads.clear()

                # Prefer DealerOn ``?pt=N`` when the URL looks like Cosmos /
                # when that strategy already succeeded on an earlier page.
                _param_kinds: list[str] = []
                if _pag_strategy == 'pt_param':
                    _param_kinds = ['pt']
                elif _pag_strategy == 'url_param':
                    _param_kinds = ['page']
                elif _pag_strategy == '':
                    _param_kinds = ['pt', 'page'] if _is_dealeron else ['page', 'pt']

                _param_advanced = False
                for _kind in _param_kinds:
                    if _pag_strategy not in ('', 'pt_param', 'url_param'):
                        break
                    if _pag_strategy == 'pt_param' and _kind != 'pt':
                        continue
                    if _pag_strategy == 'url_param' and _kind != 'page':
                        continue

                    _pn_url = _page_url(page_num, _kind)
                    try:
                        page.goto(_pn_url, timeout=10_000,
                                  wait_until='domcontentloaded')
                        try:
                            page.wait_for_load_state('networkidle',
                                                      timeout=10_000)
                        except PWTimeout:
                            pass
                    except Exception as _nav_err:
                        print(f'[PW] URL-param nav error page {page_num} '
                              f'(?{_kind}=): {_nav_err}')
                        if _pag_strategy in ('pt_param', 'url_param'):
                            break
                        continue

                    _up_veh   = _parse_current_page()
                    _up_added = _absorb(_up_veh)
                    print(f'[Scraper] Page {page_num}: {len(_up_veh)} vehicles found '
                          f'({len(seen_vins)} unique so far)')
                    print(f'[PW] Page {page_num} (?{_kind}={page_num}) -> '
                          f'{len(_up_veh)} found, {_up_added} new '
                          f'(total unique: {len(seen_vins)})')
                    if _up_added > 0:
                        if not _pag_strategy:
                            _pag_strategy = 'pt_param' if _kind == 'pt' else 'url_param'
                            print(f'[PW] Pagination strategy: {_pag_strategy} '
                                  f'(?{_kind}=N)')
                        stale_streak = 0
                        _param_advanced = True
                        break
                    if _pag_strategy in ('pt_param', 'url_param'):
                        stale_streak += 1
                        if stale_streak >= STALE_STOP:
                            print(f'[PW] {STALE_STOP} consecutive stale '
                                  f'pages - stopping pagination')
                            _param_advanced = True  # stop outer loop via break below
                        break
                    # This param kind yielded no new VINs — try the next kind.

                if _param_advanced:
                    if stale_streak >= STALE_STOP and _pag_strategy in (
                        'pt_param', 'url_param'
                    ):
                        break
                    continue
                if _pag_strategy in ('pt_param', 'url_param'):
                    # Strategy locked but this iteration didn't advance — stop.
                    break

                # ── Click / scroll fallback (SPA / infinite-scroll sites) ───
                clicked_next = False

                for sel in _NEXT_SELECTORS:
                    try:
                        btn = page.query_selector(sel)
                        if btn and btn.is_visible() and btn.is_enabled():
                            btn.click()
                            try:
                                page.wait_for_load_state('networkidle',
                                                          timeout=10_000)
                            except PWTimeout:
                                pass
                            clicked_next = True
                            break
                    except Exception:
                        pass

                if not clicked_next:
                    try:
                        found = page.evaluate(r"""
                            () => {
                                const patterns = [/^next$/i, /^next\s+page$/i,
                                                  /^›$/, /^»$/, /^>$/];
                                const els = document.querySelectorAll(
                                    'a, button, [role="button"]'
                                );
                                for (const el of els) {
                                    const txt = (el.textContent || '').trim();
                                    const aria = el.getAttribute('aria-label') || '';
                                    const matches = patterns.some(p =>
                                        p.test(txt) || p.test(aria)
                                    );
                                    if (matches && !el.disabled &&
                                        el.offsetParent !== null) {
                                        el.click();
                                        return true;
                                    }
                                }
                                return false;
                            }
                        """)
                        if found:
                            try:
                                page.wait_for_load_state('networkidle',
                                                          timeout=10_000)
                            except PWTimeout:
                                pass
                            clicked_next = True
                    except Exception:
                        pass

                if not clicked_next:
                    prev_height: int = page.evaluate(
                        'document.documentElement.scrollHeight'
                    )
                    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                    time.sleep(1.5)
                    try:
                        page.wait_for_load_state('networkidle', timeout=8_000)
                    except PWTimeout:
                        pass
                    new_height: int = page.evaluate(
                        'document.documentElement.scrollHeight'
                    )
                    if new_height <= prev_height:
                        print(f'[PW] Infinite scroll exhausted at page {page_num}')
                        break

                page_vehicles = _parse_current_page()
                added = _absorb(page_vehicles)

                if added > 0:
                    if not _pag_strategy:
                        _pag_strategy = 'click'
                        print('[PW] Pagination strategy: click-based')
                    print(f'[Scraper] Page {page_num}: {len(page_vehicles)} vehicles found '
                          f'({len(seen_vins)} unique so far)')
                    print(f'[PW] Page {page_num} -> {len(page_vehicles)} found, '
                          f'{added} new (total unique: {len(seen_vins)})')
                    stale_streak = 0
                else:
                    if not _pag_strategy:
                        _pag_strategy = 'click'
                    print(f'[Scraper] Page {page_num}: {len(page_vehicles)} vehicles found '
                          f'(0 new, {len(seen_vins)} unique so far)')
                    print(f'[PW] Page {page_num} -> {len(page_vehicles)} found, '
                          f'0 new (total unique: {len(seen_vins)})')
                    stale_streak += 1
                    if stale_streak >= STALE_STOP:
                        print(f'[PW] {STALE_STOP} consecutive stale pages - '
                              f'stopping pagination')
                        break

            browser.close()

    except Exception as err:
        print(f'[PW] Fatal error for {url!r}: {err}')
        return []

    elapsed = time.monotonic() - t0
    print(f'[PW] Done: {len(all_vehicles)} unique vehicles from {url!r} '
          f'in {elapsed:.1f}s')

    # Final safety sweep — lock condition, sanitise stock
    return _apply_safety_pw(all_vehicles, condition)


# ---------------------------------------------------------------------------
# Safety sweep (mirrors bdc_engine._apply_safety without importing it)
# ---------------------------------------------------------------------------

def _apply_safety_pw(vehicles: list[dict], condition: str) -> list[dict]:
    """Ensure every record has condition locked, stock_number set, and all
    numeric fields are proper integers.

    PostgreSQL rejects empty strings for INTEGER columns — this sweep is the
    last line of defence before records reach MarketplaceDB.upsert_vehicles.
    All six integer columns (year, price, mileage, doc_fee, retail_price,
    savings) are coerced through the appropriate helper so no empty string,
    text suffix, or None value can trigger an "invalid input syntax for type
    integer" crash.

    Phase 2: also runs inventory_parser.sanitize_vehicle_record so regex
    VIN / price / mileage / YMM fills land as pure integers before upsert.
    """
    try:
        from inventory_parser import sanitize_vehicle_record as _sanitize_vehicle
    except ImportError:
        _sanitize_vehicle = None  # type: ignore[assignment]

    out = []
    for v in vehicles:
        if _sanitize_vehicle is not None:
            try:
                v = _sanitize_vehicle(v)
            except Exception:
                pass
        v['condition']    = condition
        v['stock_number'] = _stock_safe(v.get('stock_number'))

        # String fields — default to ''
        for key in ('make', 'model', 'trim', 'color',
                    'exterior_color', 'interior_color',
                    'image_url', 'location', 'vdp_url'):
            if v.get(key) is None:
                v[key] = ''

        # Numeric fields — coerce '' / None / text suffixes → int
        v['year']         = _price_int(v.get('year'),         0)
        v['price']        = _price_int(v.get('price'),        0)
        v['mileage']      = _mileage_int(v.get('mileage'),    0)
        v['doc_fee']      = _price_int(v.get('doc_fee'),      0)
        v['retail_price'] = _price_int(v.get('retail_price'), 0)
        v['savings']      = _price_int(v.get('savings'),      0)

        out.append(v)
    return out
