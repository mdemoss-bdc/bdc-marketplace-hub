"""Adaptive, platform-agnostic inventory scraper (3-tier pipeline).

Tier 1 — JSON-LD / data-* attributes / VDP anchors (fast)
Tier 1b — DealerOn Cosmos JS-data (skeleton SRP / dlron-srp-model)
Tier 2 — Structural DOM heuristics (platform-agnostic)
Tier 3 — LLM schema normalization (AI safety net)
"""

from .cosmos import extract_cosmos_inventory, parse_srp_config_from_html
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
