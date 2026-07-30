"""Optional hourly CSV inventory feed ingestion.

Parses remote/local CSV inventory files with flexible header aliases and
returns normalized vehicle dicts ready for ``MarketplaceDB.upsert_vehicles``.
Uses the Python stdlib only (``csv``, ``urllib``) — no pandas dependency.
``main.py`` still boots ``bdc_engine.py``, which wires this module + the
hourly ``CsvFeedWorker``.
"""

from __future__ import annotations

import csv
import io
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable
from urllib.parse import urlparse

# Canonical field → accepted header aliases (normalized: alnum lower only).
_HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "vin": (
        "vin", "vehicleidentificationnumber", "vehiclevin", "vinnumber",
    ),
    "stock_number": (
        "stocknumber", "stocknum", "stockno", "stock", "stk",
    ),
    "price": (
        "price", "internetprice", "internetpricing", "sellingprice",
        "saleprice", "askingprice", "vehicleprice", "listprice",
        "advertisedprice", "webprice", "ourprice",
    ),
    "year": ("year", "modelyear", "vehicleyear", "yr"),
    "make": ("make", "vehiclemake", "brand", "manufacturer"),
    "model": ("model", "vehiclemodel"),
    "trim": ("trim", "trimlevel", "style", "series", "package"),
    "exterior_color": (
        "color", "exteriorcolor", "extcolor", "exterior", "bodycolor",
        "extcolour", "colour",
    ),
    "interior_color": (
        "interiorcolor", "intcolor", "interior", "intcolour",
    ),
    "mileage": (
        "mileage", "miles", "odometer", "odometersmiles", "km",
        "kilometers", "odometerreading",
    ),
    "condition": (
        "condition", "vehiclecondition", "type", "newused", "inventorytype",
    ),
    "image_url": (
        "image", "imageurl", "photo", "photourl", "picture", "pictureurl",
        "img", "imgurl", "primaryimage",
    ),
    "vdp_url": (
        "vdp", "vdpurl", "url", "link", "detailurl", "vehicleurl",
        "listingurl", "webpage",
    ),
    "dealership_group": (
        "dealership", "dealershipgroup", "dealer", "dealergroup", "store",
    ),
}


def _norm_header(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _build_header_map(fieldnames: list[str] | None) -> dict[str, str]:
    """Map canonical field → original CSV header name present in this file."""
    if not fieldnames:
        return {}
    by_norm = {_norm_header(h): h for h in fieldnames if h}
    mapping: dict[str, str] = {}
    for canonical, aliases in _HEADER_ALIASES.items():
        for alias in aliases:
            if alias in by_norm:
                mapping[canonical] = by_norm[alias]
                break
        # Also accept exact canonical name
        if canonical not in mapping and _norm_header(canonical) in by_norm:
            mapping[canonical] = by_norm[_norm_header(canonical)]
    # Prefer longer stock aliases when multiple match
    for preferred in ("stocknumber", "stocknum", "stockno", "stock", "stk"):
        if preferred in by_norm:
            mapping["stock_number"] = by_norm[preferred]
            break
    return mapping


def _int_clean(raw: Any, default: int = 0) -> int:
    if raw is None:
        return default
    s = str(raw).strip()
    if not s:
        return default
    s = s.replace(",", "").replace("$", "").replace(" ", "")
    m = re.search(r"-?\d+", s)
    if not m:
        return default
    try:
        return int(m.group(0))
    except ValueError:
        return default


def _cell(row: dict[str, str], header_map: dict[str, str], field: str) -> str:
    src = header_map.get(field)
    if not src:
        return ""
    return str(row.get(src) or "").strip()


def _normalize_condition(raw: str, mileage: int) -> str:
    t = (raw or "").strip().lower()
    if t in ("new", "n", "1"):
        return "New"
    if t in ("used", "u", "preowned", "pre-owned", "certified", "cpo", "0"):
        return "Used"
    if "new" in t and "used" not in t:
        return "New"
    if mileage and mileage < 50:
        return "New"
    return "Used"


def _normalize_vin(raw: str) -> str:
    vin = re.sub(r"[^A-Za-z0-9]", "", (raw or "")).upper()
    return vin if len(vin) >= 11 else ""


def fetch_csv_text(csv_url: str, timeout: float = 60.0) -> str:
    """Download a remote CSV or read a local filesystem path."""
    source = (csv_url or "").strip()
    if not source:
        raise ValueError("csv_url is required")

    parsed = urlparse(source)
    if parsed.scheme in ("http", "https"):
        req = urllib.request.Request(
            source,
            headers={
                "User-Agent": "BDC-CSV-Feed/1.0",
                "Accept": "text/csv,text/plain,*/*",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise ValueError(f"CSV download failed HTTP {exc.code}: {source}") from exc
        except Exception as exc:
            raise ValueError(f"CSV download failed: {exc}") from exc
        for enc in ("utf-8-sig", "utf-8", "latin-1"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="replace")

    # file:// or bare local path
    path = source
    if parsed.scheme == "file":
        path = urllib.request.url2pathname(parsed.path)
    if not os.path.isfile(path):
        raise ValueError(f"CSV file not found: {path}")
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
        return fh.read()


def parse_csv_inventory(
    csv_text: str,
    location_name: str = "",
) -> list[dict[str, Any]]:
    """Parse CSV text into vehicle dicts stamped with ``location``."""
    if not csv_text or not csv_text.strip():
        return []

    sample = csv_text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",\t|;")
    except csv.Error:
        dialect = csv.excel

    reader = csv.DictReader(io.StringIO(csv_text), dialect=dialect)
    header_map = _build_header_map(list(reader.fieldnames or []))
    if "vin" not in header_map:
        raise ValueError(
            "CSV is missing a VIN column (accepted: VIN, Vin, VehicleIdentificationNumber, …)"
        )

    loc = (location_name or "").strip()
    vehicles: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in reader:
        if not row:
            continue
        vin = _normalize_vin(_cell(row, header_map, "vin"))
        if not vin or vin in seen:
            continue
        seen.add(vin)

        mileage = _int_clean(_cell(row, header_map, "mileage"))
        condition = _normalize_condition(
            _cell(row, header_map, "condition"), mileage
        )
        vehicles.append({
            "vin": vin,
            "stock_number": _cell(row, header_map, "stock_number"),
            "condition": condition,
            "year": _int_clean(_cell(row, header_map, "year")),
            "make": _cell(row, header_map, "make"),
            "model": _cell(row, header_map, "model"),
            "trim": _cell(row, header_map, "trim"),
            "mileage": mileage,
            "price": _int_clean(_cell(row, header_map, "price")),
            "exterior_color": _cell(row, header_map, "exterior_color"),
            "interior_color": _cell(row, header_map, "interior_color"),
            "image_url": _cell(row, header_map, "image_url"),
            "vdp_url": _cell(row, header_map, "vdp_url"),
            "dealership_group": _cell(row, header_map, "dealership_group"),
            "location": loc,
            "doc_fee": 0,
            "retail_price": 0,
            "savings": 0,
        })
    return vehicles


def ingest_csv_inventory(
    csv_url: str,
    location_name: str,
    user_id: int | None = None,
    upsert_fn: Callable[[list[dict], int], int] | None = None,
) -> dict[str, Any]:
    """Download/parse a CSV feed and upsert vehicles for ``user_id``.

    ``upsert_fn(vehicles, user_id) -> count`` is injected by ``bdc_engine``
    (``MarketplaceDB.upsert_vehicles``) to keep this module DB-agnostic.
    """
    loc = (location_name or "").strip() or "Main Lot"
    source = (csv_url or "").strip()
    if not source:
        return {
            "ok": False,
            "synced": 0,
            "parsed": 0,
            "location": loc,
            "error": "csv_url is empty",
        }
    if user_id is None:
        return {
            "ok": False,
            "synced": 0,
            "parsed": 0,
            "location": loc,
            "error": "user_id is required",
        }
    if upsert_fn is None:
        return {
            "ok": False,
            "synced": 0,
            "parsed": 0,
            "location": loc,
            "error": "upsert_fn is required",
        }

    try:
        text = fetch_csv_text(source)
        vehicles = parse_csv_inventory(text, location_name=loc)
        # Ensure location stamp even if parser skipped empty name
        for v in vehicles:
            v["location"] = loc
        synced = upsert_fn(vehicles, int(user_id)) if vehicles else 0
        print(
            f"[CSV] u{user_id} location={loc!r} parsed={len(vehicles)} "
            f"upserted={synced} from {source!r}"
        )
        return {
            "ok": True,
            "synced": synced,
            "parsed": len(vehicles),
            "location": loc,
            "csv_url": source,
            "error": "",
        }
    except Exception as exc:
        print(f"[CSV] u{user_id} location={loc!r} FAILED: {exc}")
        return {
            "ok": False,
            "synced": 0,
            "parsed": 0,
            "location": loc,
            "csv_url": source,
            "error": str(exc),
        }


def ingest_enabled_locations(
    user_id: int,
    locations: list[dict[str, Any]] | None,
    upsert_fn: Callable[[list[dict], int], int],
) -> dict[str, Any]:
    """Run ``ingest_csv_inventory`` for every location with csv_enabled + csv_url."""
    results: list[dict[str, Any]] = []
    total = 0
    for loc in locations or []:
        if not isinstance(loc, dict):
            continue
        enabled = loc.get("csv_enabled")
        if isinstance(enabled, str):
            enabled = enabled.strip().lower() in ("1", "true", "yes", "on")
        if not enabled:
            continue
        csv_url = str(loc.get("csv_url") or "").strip()
        if not csv_url:
            continue
        name = str(loc.get("location_name") or "Main Lot").strip() or "Main Lot"
        r = ingest_csv_inventory(
            csv_url, name, user_id=user_id, upsert_fn=upsert_fn,
        )
        results.append(r)
        total += int(r.get("synced") or 0)
    return {
        "ok": all(r.get("ok") for r in results) if results else True,
        "synced": total,
        "feeds": len(results),
        "results": results,
    }
