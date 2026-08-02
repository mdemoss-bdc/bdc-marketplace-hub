"""One-shot: print the first fully gauntlet-parsed vehicle payload.

Usage (from artifacts/api-server):
  python -m scraper.print_gauntlet_sample
  python scraper/print_gauntlet_sample.py
"""

from __future__ import annotations

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from scraper.gauntlet import critical_payload, extract_with_gauntlet  # noqa: E402

_FIXTURE = os.path.join(_ROOT, "tests", "fixtures", "moses_vehicle_card.html")

_FALLBACK_HTML = """
<html><body>
<div class="vehicle-card vehicle-card--mod el-vehicle-card"
     data-vin="1HGCV1F3XPA056001" data-year="2025" data-make="Honda">
  <a href="/vdp/2025-honda-accord/1HGCV1F3XPA056001">2025 Honda Accord</a>
  <ul class="specs inventory-spec-list">
    <li>Stock: HT60208</li>
    <li>Ext: Radiant Red Metallic | Int: Black</li>
  </ul>
  <div class="vehicle-mileage">12 mi</div>
  <div class="priceStak-final-price"><span class="value">$32,995</span></div>
</div>
</body></html>
"""


def main() -> int:
    if os.path.isfile(_FIXTURE):
        with open(_FIXTURE, encoding="utf-8") as f:
            html = f.read()
        url = "https://www.mosescars.com/search-all-new-inventory.html"
        condition = "New"
    else:
        html = _FALLBACK_HTML
        url = "https://dealer.example/new-inventory"
        condition = "New"

    vehicles = extract_with_gauntlet(html, url, condition=condition)
    if not vehicles:
        print("FIRST_GAUNTLET_VEHICLE", {}, flush=True)
        print("ERROR: no vehicles parsed", file=sys.stderr)
        return 1

    payload = critical_payload(vehicles[0])
    print("FIRST_GAUNTLET_VEHICLE", payload, flush=True)
    print(json.dumps(payload, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
