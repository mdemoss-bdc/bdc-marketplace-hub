"""3-tier self-healing inventory extraction chain."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from .cosmos import extract_cosmos_inventory, looks_like_skeleton_srp, parse_srp_config_from_html
from .html_utils import fetch_html
from .schema import normalize_vehicle, validate_batch
from .stock import MISSING_STOCK
from .tier1_dom import extract_tier1
from .tier2_heuristics import extract_tier2
from .tier3_llm import extract_tier3
from .vdp_hydrate import hydrate_vehicles


def _condition_from_url(url: str, fallback: str = "Used") -> str:
    path = (urlparse(url).path or "").lower()
    if "new" in path and "used" not in path:
        return "New"
    if "used" in path or "pre-owned" in path or "preowned" in path:
        return "Used"
    return fallback


def extract_inventory(
    html: str,
    page_url: str,
    *,
    condition: str | None = None,
    min_ok: int = 5,
    enable_llm: bool = True,
) -> dict[str, Any]:
    """Run tiers 1→2→3 against already-fetched HTML.

    Returns ``{vehicles, tier, reason, count}``.
    """
    cond = condition or _condition_from_url(page_url)
    tier_used = 1
    reason = "tier1"

    vehicles = extract_tier1(html, page_url, condition=cond)
    ok, why = validate_batch(vehicles, min_count=min_ok)

    # DealerOn Cosmos / Wasabi: moses_layout.txt-style SPA shells have skeleton
    # vehicle-card nodes and empty VehicleListModel — hydrate via SRP REST API
    # using embedded <script id="dlron-srp-model"> config.
    if (not ok or looks_like_skeleton_srp(html)) and parse_srp_config_from_html(html, page_url):
        cosmos = extract_cosmos_inventory(
            html,
            page_url,
            condition=cond,
            max_pages=1,
            page_size=24,
        )
        if cosmos:
            by_vin = {v["vin"]: v for v in vehicles}
            for v in cosmos:
                prev = by_vin.get(v["vin"])
                if not prev:
                    by_vin[v["vin"]] = v
                    continue
                merged = dict(prev)
                for k, val in v.items():
                    if val in ("", 0, None, "N/A", "Unavailable"):
                        continue
                    if merged.get(k) in ("", 0, None, "N/A", "Unavailable"):
                        merged[k] = val
                by_vin[v["vin"]] = merged
            vehicles = list(by_vin.values())
            ok, why = validate_batch(vehicles, min_count=min_ok)
            if ok:
                tier_used = 1
                reason = "cosmos_ok"

    if not ok:
        tier_used = 2
        reason = f"tier1_{why}"
        t2 = extract_tier2(html, page_url, condition=cond)
        # Merge by VIN, prefer richer fields
        by_vin = {v["vin"]: v for v in vehicles}
        for v in t2:
            prev = by_vin.get(v["vin"])
            if not prev:
                by_vin[v["vin"]] = v
                continue
            merged = dict(prev)
            for k, val in v.items():
                if val in ("", 0, None, "N/A", "Unavailable"):
                    continue
                if merged.get(k) in ("", 0, None, "N/A", "Unavailable"):
                    merged[k] = val
            by_vin[v["vin"]] = merged
        vehicles = list(by_vin.values())
        ok, why = validate_batch(vehicles, min_count=min_ok)

    if not ok and enable_llm:
        tier_used = 3
        reason = f"tier2_{why}"
        vehicles = extract_tier3(html, page_url, condition=cond, prior=vehicles)
        ok, why = validate_batch(vehicles, min_count=min(min_ok, 1))
        if ok:
            reason = "tier3_ok"
        else:
            reason = f"tier3_{why}"
    elif ok and tier_used == 1:
        reason = "tier1_ok"
    elif ok and tier_used == 2:
        reason = "tier2_ok"

    # Final normalize pass
    clean: list[dict] = []
    seen: set[str] = set()
    for raw in vehicles:
        n = normalize_vehicle(raw, condition=cond)
        if not n or n["vin"] in seen:
            continue
        seen.add(n["vin"])
        clean.append(n)

    # VDP hydration: fill stock/price/color/miles when SRP cards were thin.
    # Bounded concurrency + max fetches keep sync within timeout budgets.
    clean = hydrate_vehicles(
        clean,
        condition=cond,
        max_fetches=40,
        workers=8,
        timeout=8,
    )

    return {
        "vehicles": clean,
        "tier": tier_used,
        "reason": reason,
        "count": len(clean),
        "condition": cond,
        "url": page_url,
    }


def scrape_url(
    url: str,
    *,
    condition: str | None = None,
    min_ok: int = 5,
    enable_llm: bool = True,
) -> dict[str, Any]:
    """Fetch ``url`` then run the adaptive extraction pipeline."""
    try:
        html = fetch_html(url)
    except Exception as exc:  # noqa: BLE001
        return {
            "vehicles": [],
            "tier": 0,
            "reason": f"fetch_error:{exc}",
            "count": 0,
            "condition": condition or _condition_from_url(url),
            "url": url,
        }
    return extract_inventory(
        html, url, condition=condition, min_ok=min_ok, enable_llm=enable_llm,
    )


def to_engine_rows(result: dict[str, Any]) -> list[dict]:
    """Map pipeline vehicles into bdc_engine / marketplace_inventory rows."""
    rows: list[dict] = []
    for v in result.get("vehicles") or []:
        stock = (
            v.get("stock_number")
            or v.get("stockNumber")
            or MISSING_STOCK
        )
        link = v.get("link") or v.get("vdp_url") or v.get("vdpUrl") or ""
        image = v.get("image_url") or v.get("imageUrl") or v.get("image_link") or ""
        color = v.get("exterior_color") or v.get("exteriorColor") or v.get("color") or ""
        rows.append({
            "vin": v.get("vin", ""),
            "stock_number": stock,
            "condition": v.get("condition") or result.get("condition") or "Used",
            "year": int(v.get("year") or 0),
            "make": v.get("make") or "",
            "model": v.get("model") or "",
            "trim": v.get("trim") or "",
            "title": v.get("title") or "",
            "mileage": int(v.get("mileage") or 0),
            "price": int(v.get("price") or 0),
            "exterior_color": color,
            "interior_color": "",
            "image_url": image,
            "image_link": image,
            "vdp_url": link,
            "link": link,
            "location": v.get("location") or "",
            "status": "ACTIVE",
        })
    return rows
