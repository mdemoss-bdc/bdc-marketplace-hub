"""Convenience entry point: launch the BDC automation engine.

Equivalent to `python artifacts/api-server/bdc_engine.py`, but runnable from the
repository root (`python main.py`), which is what most PaaS hosts expect.

Dealer / scraper URLs persist in ``artifacts/api-server/dealer_config.json``
(plus the ``users`` table). Scrape cancellation is disabled — ``should_stop``
always returns False and ``sync_sessions`` are forced to ``completed`` on boot.
"""

import os
import runpy
import sys

ENGINE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "artifacts", "api-server"
)


def main() -> None:
    # The engine resolves its SQLite file and sibling modules relative to its own
    # directory, so run it with that directory on sys.path and as the CWD.
    sys.path.insert(0, ENGINE_DIR)
    os.chdir(ENGINE_DIR)
    # Location backfill (empty → University Ford - Main Lot / branded rooftops)
    # runs inside bdc_engine.init_db via scraper_engine.ensure_schema +
    # backfill_inventory_rooftops on each sync.
    runpy.run_path(os.path.join(ENGINE_DIR, "bdc_engine.py"), run_name="__main__")


if __name__ == "__main__":
    main()
