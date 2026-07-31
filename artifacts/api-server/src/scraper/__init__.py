"""Adaptive, platform-agnostic inventory scraper (3-tier pipeline).

Tier 1 — JSON-LD / data-* attributes / VDP anchors (fast)
Tier 2 — Structural DOM heuristics (platform-agnostic)
Tier 3 — LLM schema normalization (AI safety net)
"""

from .pipeline import extract_inventory, scrape_url
from .wipe import clear_feed_caches, urls_changed, wipe_user_inventory

__all__ = [
    "extract_inventory",
    "scrape_url",
    "urls_changed",
    "wipe_user_inventory",
    "clear_feed_caches",
]
