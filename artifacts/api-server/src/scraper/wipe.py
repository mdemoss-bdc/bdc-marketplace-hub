"""Inventory wipe + feed-cache clear when Target URLs change."""

from __future__ import annotations

import json
import os
import sqlite3
from typing import Any
from urllib.parse import urlparse


def _norm_url(url: str) -> str:
    u = (url or "").strip().lower().rstrip("/")
    return u


def _host(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower().removeprefix("www.")
    except Exception:
        return ""


def _url_fingerprint(used: str, new: str, locations: list[dict] | None = None) -> tuple[str, ...]:
    parts: list[str] = []
    for u in (used, new):
        n = _norm_url(u)
        if n:
            parts.append(n)
    for loc in locations or []:
        if not isinstance(loc, dict):
            continue
        for key in ("inventory_url_used", "inventory_url_new"):
            n = _norm_url(str(loc.get(key) or ""))
            if n:
                parts.append(n)
    # Unique, sorted for stable compare
    return tuple(sorted(set(parts)))


def urls_changed(
    prev_used: str,
    prev_new: str,
    next_used: str,
    next_new: str,
    *,
    prev_locations: list[dict] | str | None = None,
    next_locations: list[dict] | str | None = None,
) -> bool:
    """True when Target URL set/domain meaningfully changes."""

    def _locs(raw: Any) -> list[dict]:
        if raw is None or raw == "":
            return []
        if isinstance(raw, str):
            try:
                data = json.loads(raw)
            except Exception:
                return []
            return data if isinstance(data, list) else []
        return raw if isinstance(raw, list) else []

    prev_fp = _url_fingerprint(prev_used, prev_new, _locs(prev_locations))
    next_fp = _url_fingerprint(next_used, next_new, _locs(next_locations))
    if not next_fp:
        return False
    if not prev_fp:
        return True  # first configuration — wipe any leftover demo/stale rows
    if prev_fp != next_fp:
        return True
    # Domain-level change even if path-only fingerprint somehow matched empty
    prev_hosts = {_host(u) for u in prev_fp if _host(u)}
    next_hosts = {_host(u) for u in next_fp if _host(u)}
    return bool(next_hosts) and prev_hosts != next_hosts


def wipe_user_inventory(db_file: str, user_id: int) -> int:
    """DELETE all marketplace_inventory rows for ``user_id``. Returns rowcount."""
    if not user_id:
        return 0
    conn = sqlite3.connect(db_file)
    try:
        cur = conn.execute(
            "DELETE FROM marketplace_inventory WHERE user_id = ?",
            (user_id,),
        )
        conn.commit()
        return int(cur.rowcount or 0)
    finally:
        conn.close()


def clear_feed_caches(base_dir: str | None = None) -> list[str]:
    """Remove cached meta/tiktok feed artifacts if present on disk."""
    root = base_dir or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    candidates = [
        "meta-feed.csv",
        "meta-feed.xml",
        "tiktok-feed.xml",
        "tiktok-feed.csv",
        os.path.join("feeds", "meta-feed.csv"),
        os.path.join("feeds", "meta-feed.xml"),
        os.path.join("feeds", "tiktok-feed.xml"),
        os.path.join("cache", "meta-feed.csv"),
        os.path.join("cache", "tiktok-feed.xml"),
        os.path.join("artifacts", "meta-feed.csv"),
        os.path.join("artifacts", "tiktok-feed.xml"),
    ]
    removed: list[str] = []
    for rel in candidates:
        path = rel if os.path.isabs(rel) else os.path.join(root, rel)
        try:
            if os.path.isfile(path):
                os.remove(path)
                removed.append(path)
        except OSError:
            pass
    return removed
