#!/usr/bin/env python3
"""Seed sample inventory + optional live sync, then verify /api/vehicles.

Usage:
    python seed_inventory.py              # seed + try sync for primary user
    python seed_inventory.py --seed-only  # skip live network scrape
    python seed_inventory.py --user 9     # target a specific user id
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

# Ensure imports resolve when run from any cwd
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

os.environ.pop('DATABASE_URL', None)  # force local SQLite preview path


def main() -> int:
    parser = argparse.ArgumentParser(description='Seed / sync BDC inventory')
    parser.add_argument('--user', type=int, default=0, help='Target user id')
    parser.add_argument('--seed-only', action='store_true',
                        help='Skip live scrape; only upsert sample fleet')
    parser.add_argument('--port', type=int, default=0,
                        help='If set, start API server and hit /api/vehicles')
    args = parser.parse_args()

    import bdc_engine as eng

    eng.init_db()

    # Resolve target user
    conn = eng.sqlite3.connect(eng.DB_FILE)
    conn.row_factory = eng.sqlite3.Row
    if args.user:
        row = conn.execute(
            "SELECT id, username, inventory_url_used, inventory_url_new "
            "FROM users WHERE id=?",
            (args.user,),
        ).fetchone()
    else:
        # Prefer admin / mdemoss, else first user with Moses URLs, else any user
        row = conn.execute(
            "SELECT id, username, inventory_url_used, inventory_url_new "
            "FROM users ORDER BY is_admin DESC, id ASC LIMIT 1"
        ).fetchone()
    conn.close()

    if not row:
        print('ERROR: no users found in bdc_production.db')
        return 1

    uid = int(row['id'])
    used = (row['inventory_url_used'] or '').strip()
    new = (row['inventory_url_new'] or '').strip()
    print(f"[seed] target user={uid} ({row['username']})")
    print(f"[seed] used_url={used!r}")
    print(f"[seed] new_url={new!r}")

    result = {'synced': 0, 'sold': 0, 'reason': 'seed-only'}
    if args.seed_only:
        n = eng.seed_sample_inventory(uid)
        result = {'synced': n, 'sold': 0, 'reason': 'demo'}
        print(f"[seed] inserted/updated {n} sample vehicles")
    else:
        print('[seed] running live sync (Playwright → static → sample fallback)…')
        result = eng._sync_user_inventory(uid, used, new)
        print(f"[seed] sync result: {result}")
        # Guarantee hero sample units are present for local KPI demos
        if result.get('synced', 0) == 0 or result.get('reason') in (
            'demo', 'parse_empty', 'js_render_empty',
        ):
            n = eng.seed_sample_inventory(uid)
            print(f"[seed] ensured sample fleet present ({n} upserts)")

    counts = eng.MarketplaceDB.count(uid)
    inv = eng.MarketplaceDB.get_inventory(uid, status='ACTIVE')
    print(f"[seed] ACTIVE={counts.get('ACTIVE')} total={counts.get('total')} "
          f"rows_returned={len(inv)}")
    heroes = [v for v in inv if v.get('make') in ('Ford', 'Audi')
              and v.get('model') in ('F-150', 'A6', 'Bronco')]
    print(f"[seed] hero units in ACTIVE set: "
          f"{[(v['year'], v['make'], v['model'], v['stock_number']) for v in heroes]}")

    if args.port:
        port = args.port
        eng.SERVER_PORT = port

        def _serve():
            from http.server import HTTPServer
            httpd = HTTPServer(('', port), eng.BDCRequestHandler)
            httpd.serve_forever()

        t = threading.Thread(target=_serve, daemon=True)
        t.start()
        time.sleep(1.2)
        url = f'http://127.0.0.1:{port}/api/vehicles?user_id={uid}&status=ACTIVE'
        print(f'[seed] GET {url}')
        try:
            req = urllib.request.Request(
                url,
                headers={'User-Agent': 'BDC-Seed-Verify/1.0', 'Accept': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode('utf-8'))
            active = payload.get('active') or payload.get('counts', {}).get('ACTIVE', 0)
            nveh = len(payload.get('vehicles') or payload.get('inventory') or [])
            print(f"[seed] /api/vehicles -> active={active} vehicles={nveh}")
            if nveh == 0:
                print('ERROR: /api/vehicles returned empty inventory')
                return 2
            sample = (payload.get('vehicles') or [])[:3]
            for s in sample:
                print(f"  - {s.get('year')} {s.get('make')} {s.get('model')} "
                      f"stock={s.get('stock_number')} price={s.get('price')}")
        except urllib.error.URLError as exc:
            print(f'ERROR fetching /api/vehicles: {exc}')
            return 3

    print('[seed] OK')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
