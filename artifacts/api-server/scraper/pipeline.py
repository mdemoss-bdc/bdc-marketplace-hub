"""Adaptive inventory extraction — Gauntlet Matrix + tier fallbacks.

Core per-vehicle fill order lives in ``gauntlet.py`` (JSON-LD → DealerOn →
Dealertrack/Sincro → text brute-force → optional VDP/URL/In Transit).
Tiers 1–3 remain as discovery / LLM safety nets that feed the same gauntlet.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from .gauntlet import (
    critical_payload,
    extract_with_gauntlet,
    gauntlet_complete,
    run_gauntlet,
)
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


def _merge_by_vin(base: list[dict], extra: list[dict]) -> list[dict]:
    by_vin = { (v.get("vin") or "").upper(): v for v in base if v.get("vin") }
    for v in extra:
        vin = (v.get("vin") or "").upper()
        if not vin:
            continue
        prev = by_vin.get(vin)
        if not prev:
            by_vin[vin] = v
            continue
        merged = dict(prev)
        for k, val in v.items():
            if val in ("", 0, None, "N/A", "Unavailable"):
                continue
            if merged.get(k) in ("", 0, None, "N/A", "Unavailable"):
                merged[k] = val
        by_vin[vin] = merged
    return list(by_vin.values())


def extract_inventory(
    html: str,
    page_url: str,
    *,
    condition: str | None = None,
    min_ok: int = 5,
    enable_llm: bool = True,
) -> dict[str, Any]:
    """Run the Scraper Gauntlet Matrix (+ tier fallbacks) against fetched HTML.

    Returns ``{vehicles, tier, reason, count}``.

    Optional final enrichment (after gauntlet steps 1–4): VDP hydrate fills
    remaining stock/price gaps without mangling ``link``. URL stock / In Transit
    are applied inside ``gauntlet.step5_optional_stock_enrichment``.
    """
    cond = condition or _condition_from_url(page_url)
    tier_used = 1
    reason = "gauntlet"

    # Primary path — multi-platform gauntlet (owns per-vehicle fill order).
    vehicles = extract_with_gauntlet(html, page_url, condition=cond)
    ok, why = validate_batch(vehicles, min_count=min_ok)
    if ok:
        reason = "gauntlet_ok"

    # Tier 1 discovery → re-gauntlet thin rows (JSON-LD / data-* cards).
    if not ok:
        tier_used = 1
        reason = f"gauntlet_{why}"
        t1 = extract_tier1(html, page_url, condition=cond)
        vehicles = _merge_by_vin(vehicles, t1)
        ok, why = validate_batch(vehicles, min_count=min_ok)
        if ok:
            reason = "tier1_ok"

    if not ok:
        tier_used = 2
        reason = f"tier1_{why}"
        t2 = extract_tier2(html, page_url, condition=cond)
        vehicles = _merge_by_vin(vehicles, t2)
        ok, why = validate_batch(vehicles, min_count=min_ok)
        if ok:
            reason = "tier2_ok"

    if not ok and enable_llm:
        tier_used = 3
        reason = f"tier2_{why}"
        vehicles = extract_tier3(html, page_url, condition=cond, prior=vehicles)
        ok, why = validate_batch(vehicles, min_count=min(min_ok, 1))
        if ok:
            reason = "tier3_ok"
        else:
            reason = f"tier3_{why}"

    # Final normalize pass
    clean: list[dict] = []
    seen: set[str] = set()
    for raw in vehicles:
        # Re-run gauntlet finalize on residual gaps (no double VDP fetch here).
        if not gauntlet_complete(raw, condition=cond):
            raw = run_gauntlet(
                raw,
                card_html=str(raw.get("_html") or ""),
                page_html=html,
                condition=cond,
                finalize_stock=True,
            )
        n = normalize_vehicle(raw, condition=cond)
        if not n or n["vin"] in seen:
            continue
        seen.add(n["vin"])
        n.pop("_mileage_resolved", None)
        clean.append(n)

    # Optional STEP 5 enrichment: bounded VDP hydrate when stock/price still thin.
    # Documented in gauntlet.py — does not mangle vehicle.link.
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
        "sample": critical_payload(clean[0]) if clean else {},
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
            "sample": {},
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
