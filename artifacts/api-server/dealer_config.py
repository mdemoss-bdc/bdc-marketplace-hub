"""Permanent on-disk dealer / scraper settings (``dealer_config.json``).

The Marketplace Hub saves location URLs here in addition to the ``users``
table so a browser refresh never loses dealership configuration — even when
SQLite user resolution is ambiguous or the DB row is briefly empty.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

_LOCK = threading.Lock()
_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dealer_config.json")


def config_path() -> str:
    return _CONFIG_PATH


def _default_payload() -> dict[str, Any]:
    return {
        "user_id": None,
        "dealer_name": "",
        "inventory_url_used": "",
        "inventory_url_new": "",
        "inventory_locations": [],
        "salesperson_filter": "",
        "scraper_frequency": "daily",
        "facebook_business_manager_id": "",
        "commerce_catalog_id": "",
        "meta_pixel_id": "",
    }


def load_dealer_config() -> dict[str, Any]:
    """Read ``dealer_config.json`` from disk. Returns defaults if missing."""
    path = _CONFIG_PATH
    if not os.path.isfile(path):
        return _default_payload()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return _default_payload()
        out = _default_payload()
        out.update({k: raw[k] for k in out if k in raw})
        # Preserve unknown keys for forward-compat
        for k, v in raw.items():
            if k not in out:
                out[k] = v
        if not isinstance(out.get("inventory_locations"), list):
            out["inventory_locations"] = []
        return out
    except Exception as exc:
        print(f"[CONFIG] Failed to read {path}: {exc}")
        return _default_payload()


def save_dealer_config(payload: dict[str, Any]) -> dict[str, Any]:
    """Atomically write settings to ``dealer_config.json``. Returns the saved dict."""
    current = load_dealer_config()
    merged = dict(current)
    for key, value in (payload or {}).items():
        if value is None:
            continue
        merged[key] = value
    if not isinstance(merged.get("inventory_locations"), list):
        merged["inventory_locations"] = []

    path = _CONFIG_PATH
    tmp = path + ".tmp"
    with _LOCK:
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(merged, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
            os.replace(tmp, path)
        except Exception as exc:
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except Exception:
                pass
            print(f"[CONFIG] Failed to write {path}: {exc}")
            raise
    print(
        f"[CONFIG] Saved dealer_config.json "
        f"(locations={len(merged.get('inventory_locations') or [])}, "
        f"user_id={merged.get('user_id')})"
    )
    return merged


def merge_settings_with_disk(db_settings: dict[str, Any] | None) -> dict[str, Any]:
    """Prefer non-empty disk values when DB rows are blank (refresh-safe)."""
    disk = load_dealer_config()
    db = dict(db_settings or {})
    out = dict(db)

    disk_locs = disk.get("inventory_locations") or []
    db_locs = db.get("inventory_locations") or []
    if isinstance(db_locs, str):
        try:
            db_locs = json.loads(db_locs) if db_locs else []
        except Exception:
            db_locs = []

    if disk_locs and not db_locs:
        out["inventory_locations"] = disk_locs
    elif disk_locs and db_locs:
        # Disk wins when it has more configured rows / URLs
        def _url_score(locs: list) -> int:
            n = 0
            for loc in locs:
                if not isinstance(loc, dict):
                    continue
                if (loc.get("inventory_url_used") or "").strip():
                    n += 1
                if (loc.get("inventory_url_new") or "").strip():
                    n += 1
                if (loc.get("csv_url") or "").strip():
                    n += 1
            return n
        if _url_score(disk_locs) >= _url_score(db_locs):
            out["inventory_locations"] = disk_locs
        else:
            out["inventory_locations"] = db_locs
    elif disk_locs:
        out["inventory_locations"] = disk_locs
    else:
        out["inventory_locations"] = db_locs if isinstance(db_locs, list) else []

    for key in (
        "dealer_name",
        "inventory_url_used",
        "inventory_url_new",
        "salesperson_filter",
        "scraper_frequency",
        "facebook_business_manager_id",
        "commerce_catalog_id",
        "meta_pixel_id",
    ):
        disk_val = (disk.get(key) or "") if isinstance(disk.get(key), str) else disk.get(key)
        db_val = (db.get(key) or "") if isinstance(db.get(key), str) else db.get(key)
        if isinstance(disk_val, str):
            if disk_val.strip() and not str(db_val or "").strip():
                out[key] = disk_val
            elif disk_val.strip():
                # Prefer disk for Hub-owned scraper fields
                out[key] = disk_val
            elif db_val is not None:
                out[key] = db_val
        elif disk_val not in (None, "") and db_val in (None, ""):
            out[key] = disk_val

    # Mirror first location into legacy URL fields when still blank
    locs = out.get("inventory_locations") or []
    if locs and isinstance(locs[0], dict):
        if not str(out.get("inventory_url_used") or "").strip():
            out["inventory_url_used"] = locs[0].get("inventory_url_used") or ""
        if not str(out.get("inventory_url_new") or "").strip():
            out["inventory_url_new"] = locs[0].get("inventory_url_new") or ""
        if not str(out.get("dealer_name") or "").strip():
            out["dealer_name"] = locs[0].get("location_name") or disk.get("dealer_name") or ""

    if disk.get("user_id") is not None:
        out.setdefault("user_id", disk.get("user_id"))
    return out


def apply_disk_config_to_user(conn_factory, user_id: int) -> None:
    """Push ``dealer_config.json`` into the users row on startup (if file has data)."""
    disk = load_dealer_config()
    locs = disk.get("inventory_locations") or []
    used = (disk.get("inventory_url_used") or "").strip()
    new = (disk.get("inventory_url_new") or "").strip()
    if locs and not used and isinstance(locs[0], dict):
        used = (locs[0].get("inventory_url_used") or "").strip()
        new = new or (locs[0].get("inventory_url_new") or "").strip()
    if not locs and not used and not new and not (disk.get("dealer_name") or "").strip():
        return
    locs_json = json.dumps(locs, ensure_ascii=False)
    conn = conn_factory()
    try:
        conn.execute(
            """
            UPDATE users SET
                inventory_locations = ?,
                inventory_url_used = ?,
                inventory_url_new = ?,
                dealer_name = COALESCE(NULLIF(?, ''), dealer_name),
                salesperson_filter = COALESCE(NULLIF(?, ''), salesperson_filter),
                scraper_frequency = COALESCE(NULLIF(?, ''), scraper_frequency),
                facebook_business_manager_id = COALESCE(NULLIF(?, ''), facebook_business_manager_id),
                commerce_catalog_id = COALESCE(NULLIF(?, ''), commerce_catalog_id),
                meta_pixel_id = COALESCE(NULLIF(?, ''), meta_pixel_id)
             WHERE id = ?
            """,
            (
                locs_json,
                used,
                new,
                disk.get("dealer_name") or "",
                disk.get("salesperson_filter") or "",
                disk.get("scraper_frequency") or "",
                disk.get("facebook_business_manager_id") or "",
                disk.get("commerce_catalog_id") or "",
                disk.get("meta_pixel_id") or "",
                user_id,
            ),
        )
        conn.commit()
        print(f"[CONFIG] Hydrated users.id={user_id} from dealer_config.json")
    except Exception as exc:
        print(f"[CONFIG] DB hydrate failed: {exc}")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()
