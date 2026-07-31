"""Production verification: parse vehicles from root moses_layout.txt.

The dump is a UTF-16 LE SPA skeleton (empty VehicleListModel + skeleton
vehicle-card nodes). Real Stock / Color / Mileage / Price come from the
DealerOn Cosmos API using ``dlron-srp-model`` config embedded in the dump.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DUMP = ROOT / "moses_layout.txt"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scraper.cosmos import (  # noqa: E402
    extract_cosmos_inventory,
    looks_like_skeleton_srp,
    parse_srp_config_from_html,
)
from scraper.pipeline import extract_inventory  # noqa: E402
from scraper.stock import MISSING_STOCK  # noqa: E402


def load_dump(path: Path) -> str:
    raw = path.read_bytes()
    if raw[:2] == b"\xff\xfe":
        return raw.decode("utf-16-le")
    if raw[:2] == b"\xfe\xff":
        return raw.decode("utf-16-be")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    # Heuristic: dense NULs → UTF-16 LE without relying solely on BOM
    if raw[:200].count(0) > 40:
        return raw.decode("utf-16-le", errors="replace")
    return raw.decode("utf-8", errors="replace")


def main() -> int:
    if not DUMP.is_file():
        print(f"MISSING_DUMP: {DUMP}", file=sys.stderr)
        return 2

    html = load_dump(DUMP)
    page_url = "https://www.mosescars.com/search-all-new-inventory.html"
    cfg = parse_srp_config_from_html(html, page_url)
    print("DUMP_CHARS", len(html))
    print("SKELETON_SRP", looks_like_skeleton_srp(html))
    print(
        "SRP_CONFIG",
        {
            k: cfg.get(k)
            for k in ("dealer_code", "dealer_id", "page_id", "base_filter", "base_url")
        }
        if cfg
        else None,
    )

    # Prefer explicit Cosmos path so verification is tied to dump config.
    vehicles = extract_cosmos_inventory(
        html, page_url, condition="New", max_pages=1, page_size=12,
    )
    reason = "cosmos"
    if not vehicles:
        result = extract_inventory(
            html, page_url, condition="New", min_ok=1, enable_llm=False,
        )
        vehicles = result.get("vehicles") or []
        reason = result.get("reason")

    if not vehicles:
        print("NO_VEHICLES_PARSED")
        return 1

    v = vehicles[0]
    summary = {
        "stockNumber": v.get("stockNumber") or v.get("stock_number"),
        "exteriorColor": v.get("exteriorColor") or v.get("exterior_color"),
        "mileage": v.get("mileage"),
        "price": v.get("price"),
        "vin": v.get("vin"),
        "link": v.get("link") or v.get("vdp_url"),
    }
    print("PARSE_REASON", reason)
    print("FIRST_PARSED_VEHICLE", json.dumps(summary, indent=2))

    bad = []
    if not summary["stockNumber"] or summary["stockNumber"] == MISSING_STOCK:
        bad.append("stockNumber")
    if not summary["exteriorColor"]:
        bad.append("exteriorColor")
    if summary["mileage"] in (None, ""):
        bad.append("mileage")
    if not summary["price"]:
        bad.append("price")
    if not summary["vin"]:
        bad.append("vin")
    if not summary["link"]:
        bad.append("link")
    if bad:
        print("FAIL_EMPTY_FIELDS", bad)
        return 1
    print("OK", f"count={len(vehicles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
