"""Adaptive, platform-agnostic inventory scraper (Gauntlet Matrix + tiers).

Gauntlet per-vehicle fill order (strict):
  1. Schema JSON-LD (Product / Vehicle / Car, incl. @graph)
  2. DealerOn Dynamic Grid (+ Cosmos API skeleton fallback)
  3. Dealertrack / Sincro (data-* + pricing)
  4. Physical text regex brute-force
  5. Optional: VDP hydrate / URL stock / In Transit (never mangles link)

Tier 1–3 remain discovery / LLM safety nets that feed the same gauntlet.
"""

from .cosmos import extract_cosmos_inventory, parse_srp_config_from_html
from .gauntlet import (
    critical_payload,
    extract_with_gauntlet,
    gauntlet_complete,
    run_gauntlet,
)
from .pipeline import extract_inventory, scrape_url
from .stock import (
    IN_TRANSIT_STOCK,
    MISSING_STOCK,
    detect_in_transit,
    extract_stock_from_html,
    extract_stock_from_url,
    resolve_stock_number,
    sanitize_stock_number,
)
from .vdp_hydrate import extract_from_vdp_html, hydrate_vehicles, needs_hydration
from .wipe import clear_feed_caches, urls_changed, wipe_user_inventory

__all__ = [
    "extract_inventory",
    "scrape_url",
    "extract_with_gauntlet",
    "run_gauntlet",
    "gauntlet_complete",
    "critical_payload",
    "extract_cosmos_inventory",
    "parse_srp_config_from_html",
    "IN_TRANSIT_STOCK",
    "MISSING_STOCK",
    "detect_in_transit",
    "extract_stock_from_html",
    "extract_stock_from_url",
    "resolve_stock_number",
    "sanitize_stock_number",
    "extract_from_vdp_html",
    "hydrate_vehicles",
    "needs_hydration",
    "urls_changed",
    "wipe_user_inventory",
    "clear_feed_caches",
]
