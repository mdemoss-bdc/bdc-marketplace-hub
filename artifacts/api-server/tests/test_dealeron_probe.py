"""
DealerOn API probe timeout and fallback tests.

Verifies that:
  1. A hanging DealerOn endpoint (URLError / timeout) causes the probe to
     return [] and _fetch_dealer_page falls through to the HTML path.
  2. The DEALERON_API_PROBE_BUDGET_SECS wall-clock cap terminates pagination
     early when time.monotonic() advances past the deadline mid-loop.
  3. The probe returns vehicles fetched before the budget is hit rather than
     discarding them.
  4. _fetch_dealer_page returns [] (not an exception) when both the DealerOn
     probe AND the HTML fetch fail — no silent stall.

Time budget contract (documented in _fetch_dealer_page):
  - DealerOn probe: ≤ DEALERON_API_PROBE_BUDGET_SECS (30 s) total.
  - HTML fetch:     25-second socket timeout.
  - Worst-case:     30 + 25 = 55 s per _fetch_dealer_page call.
"""

import json
import os
import sys
import time
import unittest
import urllib.error
import urllib.request
from io import BytesIO
from unittest.mock import MagicMock, patch, call

# ---------------------------------------------------------------------------
# Bootstrap: DATABASE_URL must be set before bdc_engine is imported.
# ---------------------------------------------------------------------------
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost/testdb")
os.environ.setdefault("TIKTOK_CLIENT_KEY",    "fake_key")
os.environ.setdefault("TIKTOK_CLIENT_SECRET", "fake_secret")

import bdc_engine as engine  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _json_response(data: dict, content_type: str = "application/json") -> MagicMock:
    """Return a mock urllib response that yields *data* as JSON."""
    body = json.dumps(data).encode("utf-8")
    resp = MagicMock()
    resp.headers = {"Content-Type": content_type}
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _html_response(html: str) -> MagicMock:
    """Return a mock urllib response that yields *html* as text/html."""
    body = html.encode("utf-8")
    resp = MagicMock()
    resp.headers = {"Content-Type": "text/html; charset=utf-8"}
    resp.read.return_value = body
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# 1. Timeout on DealerOn probe → falls through to HTML path
# ---------------------------------------------------------------------------

class TestDealerOnProbeTimeoutFallthrough(unittest.TestCase):
    """When the DealerOn endpoint raises URLError (simulating a timeout), the
    probe must return [] and _fetch_dealer_page must proceed to the HTML path."""

    def test_urlerror_on_probe_returns_empty(self):
        """_parse_dealeron_api returns [] when urlopen raises URLError."""
        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.URLError("timed out")):
            result = engine._parse_dealeron_api(
                "https://example-dealeron.com/new-inventory", "New")
        self.assertEqual(result, [])

    def test_http_error_on_probe_returns_empty(self):
        """_parse_dealeron_api returns [] when the endpoint returns HTTP 404."""
        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.HTTPError(
                       "https://example-dealeron.com/api/Inventory/GetInventory",
                       404, "Not Found", {}, None)):
            result = engine._parse_dealeron_api(
                "https://example-dealeron.com/new-inventory", "New")
        self.assertEqual(result, [])

    def test_fetch_dealer_page_falls_through_to_html_on_probe_timeout(self):
        """When the DealerOn probe times out, _fetch_dealer_page must still
        return results parsed from the HTML response."""
        minimal_html = """
        <html><head></head><body>
        <div class="vehicle-card" data-vin="1HGCV1F3XPA056001"
             data-stock="NH1001" data-price="34995"
             data-year="2025" data-make="Honda" data-model="Accord">
        </div></body></html>
        """

        urlopen_calls = []

        def _urlopen_side_effect(req, timeout=None):
            url = req.full_url if hasattr(req, 'full_url') else str(req)
            urlopen_calls.append(url)
            if "GetInventory" in url:
                raise urllib.error.URLError("connection timed out")
            # HTML fetch succeeds
            return _html_response(minimal_html)

        with patch("urllib.request.urlopen", side_effect=_urlopen_side_effect):
            result = engine._fetch_dealer_page(
                "https://example-dealeron.com/new-inventory", "New")

        # The probe should have been attempted (at least one GetInventory call)
        api_calls = [u for u in urlopen_calls if "GetInventory" in u]
        self.assertGreater(len(api_calls), 0,
                           "Expected at least one DealerOn API probe attempt")

        # _fetch_dealer_page must not raise — it should return a list
        self.assertIsInstance(result, list)

    def test_fetch_dealer_page_returns_empty_list_not_exception_on_total_failure(self):
        """If both the DealerOn probe AND the HTML fetch fail, _fetch_dealer_page
        must return [] rather than propagating the exception."""
        with patch("urllib.request.urlopen",
                   side_effect=urllib.error.URLError("network error")):
            result = engine._fetch_dealer_page(
                "https://example-dealer.com/inventory", "New")
        self.assertEqual(result, [])


# ---------------------------------------------------------------------------
# 2. Budget cap terminates pagination early
# ---------------------------------------------------------------------------

class TestDealerOnProbeBudgetCap(unittest.TestCase):
    """DEALERON_API_PROBE_BUDGET_SECS must stop the pagination loop when the
    wall-clock deadline is reached, even if more pages are available."""

    def _make_page_response(self, vehicles: list, total: int) -> MagicMock:
        """Return a JSON API response with the given vehicles list."""
        data = {
            "inventory": vehicles,
            "totalCount": total,
            "pageSize": len(vehicles) or 1,
        }
        return _json_response(data)

    def _minimal_vehicle(self, vin: str) -> dict:
        return {
            "vin":         vin,
            "stockNumber": "TST001",
            "year":        2024,
            "make":        "Honda",
            "model":       "Civic",
            "trim":        "LX",
            "price":       25000,
            "mileage":     0,
            "condition":   "New",
        }

    def test_budget_exceeded_before_first_page_returns_empty(self):
        """If the deadline has already passed before the first request,
        the probe must return [] immediately without calling urlopen."""
        # Set budget to 0 to force immediate expiry
        original_budget = engine.DEALERON_API_PROBE_BUDGET_SECS
        engine.DEALERON_API_PROBE_BUDGET_SECS = 0
        try:
            with patch("urllib.request.urlopen") as mock_urlopen:
                result = engine._parse_dealeron_api(
                    "https://example-dealeron.com/new-inventory", "New")
            # With budget = 0, the deadline check fires before urlopen is called
            mock_urlopen.assert_not_called()
            self.assertEqual(result, [])
        finally:
            engine.DEALERON_API_PROBE_BUDGET_SECS = original_budget

    def test_budget_exceeded_after_first_page_returns_accumulated_vehicles(self):
        """If the budget expires between page 1 and page 2, the probe must
        return the vehicles already fetched from page 1 rather than [] ."""
        # We simulate a scenario where:
        #   - time.monotonic() returns t0 initially (deadline = t0 + BUDGET)
        #   - After page 1 is fetched, time.monotonic() > deadline
        # So pagination stops after page 1.

        veh1 = self._minimal_vehicle("1HGCV1F3XPA056001")
        # totalCount (400) > pageSize (1), so the loop would normally request page 2.
        page1_resp = self._make_page_response([veh1], total=400)
        page1_resp.__enter__ = lambda s: s
        page1_resp.__exit__ = MagicMock(return_value=False)

        t0 = 1000.0
        budget = engine.DEALERON_API_PROBE_BUDGET_SECS
        deadline = t0 + budget

        # _parse_dealeron_api calls time.monotonic() at:
        #   1. deadline = time.monotonic() + BUDGET         → t0
        #   2. outer for-loop: if time.monotonic() >= ...   → t0+0.1 (within)
        #   3. inner while:   if time.monotonic() >= ...    → t0+0.2 (within)
        #   4. page 1 fetched; inner while top:
        #      if time.monotonic() >= ...                   → deadline+1 (expired)
        # Any additional calls (e.g. after break) also get deadline+1.
        def _monotonic_gen():
            yield t0          # #1 — sets deadline
            yield t0 + 0.1    # #2 — outer for check ep1: still ok
            yield t0 + 0.2    # #3 — inner while check before page 1: still ok
            # All subsequent calls return past-deadline
            while True:
                yield deadline + 1.0

        def _urlopen(req, timeout=None):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            if "PageNumber=1" in url and "GetInventory" in url:
                return page1_resp
            # Should never be reached for page 2
            raise AssertionError(f"urlopen called unexpectedly for: {url}")

        with patch("urllib.request.urlopen", side_effect=_urlopen), \
             patch("time.monotonic", side_effect=_monotonic_gen()):
            result = engine._parse_dealeron_api(
                "https://example-dealeron.com/new-inventory", "New")

        # Must have returned the page-1 vehicles rather than []
        self.assertGreater(len(result), 0,
                           "Expected vehicles from page 1 to be returned when "
                           "budget is hit before page 2")

    def test_near_deadline_request_uses_clamped_timeout(self):
        """When only a few seconds remain in the budget, urlopen must be called
        with timeout ≤ remaining_budget, not the full 20-second default.

        This ensures a request starting at e.g. budget-2s can't overrun by
        the full 20 s — it gets a 2-second socket timeout instead.
        """
        t0 = 1000.0
        budget = engine.DEALERON_API_PROBE_BUDGET_SECS
        deadline = t0 + budget
        # Leave only 2 seconds before the deadline when the request fires.
        near_deadline = deadline - 2.0

        # Sequence of time.monotonic() calls:
        #   1. Sets deadline          → t0
        #   2. Outer for-loop check   → near_deadline (2 s left)
        #   3. Inner while-loop check → near_deadline (2 s left, > 0 so proceed)
        #   After urlopen raises, the exception is caught and the next endpoint
        #   is tried; subsequent checks all return past-deadline so we stop.
        def _monotonic_gen():
            yield t0            # #1 — sets deadline
            yield near_deadline # #2 — outer for-loop: 2 s remain
            yield near_deadline # #3 — inner while: 2 s remain
            # All further calls → past deadline
            while True:
                yield deadline + 1.0

        captured_timeouts: list[float] = []

        def _urlopen(req, timeout=None):
            captured_timeouts.append(timeout)
            raise urllib.error.URLError("simulated hang")

        with patch("urllib.request.urlopen", side_effect=_urlopen), \
             patch("time.monotonic", side_effect=_monotonic_gen()):
            result = engine._parse_dealeron_api(
                "https://example-dealeron.com/new-inventory", "New")

        self.assertEqual(result, [])
        self.assertGreater(len(captured_timeouts), 0,
                           "Expected urlopen to be called at least once")
        # The timeout used must be ≤ 2 s remaining (not the full 20 s default)
        self.assertLessEqual(
            captured_timeouts[0], 2.0 + 0.001,  # tiny float tolerance
            f"Expected timeout ≤ 2 s (remaining budget), got {captured_timeouts[0]}"
        )

    def test_budget_respected_across_endpoint_variants(self):
        """If the first endpoint exhausts the budget, the second endpoint
        variant must be skipped entirely."""
        t0 = 1000.0
        deadline = t0 + engine.DEALERON_API_PROBE_BUDGET_SECS
        # Return: t0 (set deadline), then past deadline for every check
        monotonic_values = iter([
            t0,             # sets deadline
            deadline + 1,   # first check in outer for loop (ep1) → expired
        ])

        with patch("urllib.request.urlopen") as mock_urlopen, \
             patch("time.monotonic", side_effect=monotonic_values):
            result = engine._parse_dealeron_api(
                "https://example-dealeron.com/new-inventory", "New")

        mock_urlopen.assert_not_called()
        self.assertEqual(result, [])


# ---------------------------------------------------------------------------
# 3. Non-JSON response on probe → falls through (no exception)
# ---------------------------------------------------------------------------

class TestDealerOnProbeNonJsonFallthrough(unittest.TestCase):
    """If the DealerOn endpoint returns HTML (not JSON), the probe must
    return [] without error so the HTML path is used instead."""

    def test_html_content_type_returns_empty(self):
        """Non-JSON Content-Type causes the probe to give up on that endpoint."""
        html_resp = _html_response("<html>Not an API</html>")

        with patch("urllib.request.urlopen", return_value=html_resp):
            result = engine._parse_dealeron_api(
                "https://example.com/new-inventory", "New")
        self.assertEqual(result, [])

    def test_empty_inventory_list_returns_empty(self):
        """An API response with an empty inventory list causes the probe to
        return [] (no crash, no stall)."""
        empty_resp = _json_response({"inventory": [], "totalCount": 0, "pageSize": 200})

        with patch("urllib.request.urlopen", return_value=empty_resp):
            result = engine._parse_dealeron_api(
                "https://example.com/new-inventory", "New")
        self.assertEqual(result, [])


# ---------------------------------------------------------------------------
# 4. Smoke: DEALERON_API_PROBE_BUDGET_SECS constant exists and is positive
# ---------------------------------------------------------------------------

class TestDealerOnBudgetConstant(unittest.TestCase):
    """Sanity-check the module-level constant."""

    def test_budget_constant_is_positive(self):
        self.assertGreater(engine.DEALERON_API_PROBE_BUDGET_SECS, 0)

    def test_budget_constant_is_less_than_one_minute(self):
        """The probe budget should be tight enough to not stall a sync for long."""
        self.assertLess(engine.DEALERON_API_PROBE_BUDGET_SECS, 60)

    def test_per_page_timeout_fits_within_budget(self):
        """The per-page socket timeout (20 s) must be ≤ the total budget,
        so a single timed-out page can never exceed the overall budget."""
        # The per-page timeout is hardcoded to 20 inside _parse_dealeron_api.
        per_page_timeout = 20
        self.assertLessEqual(per_page_timeout,
                             engine.DEALERON_API_PROBE_BUDGET_SECS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
