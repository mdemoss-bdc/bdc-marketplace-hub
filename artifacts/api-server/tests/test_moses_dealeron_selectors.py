"""Focused unit tests: Moses / DealerOn DOM selectors for stock, color, miles, price.

Selectors mapped from project-root ``moses_layout.txt`` (UTF-16 dump).
Fixture: ``tests/fixtures/moses_vehicle_card.html``.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from inventory_parser import (  # noqa: E402
    extract_exterior_color,
    extract_mileage,
    extract_price,
    extract_stock_number,
    sanitize_vehicle_record,
)
from scraper.fields import (  # noqa: E402
    extract_exterior_color as fields_color,
    extract_mileage as fields_mileage,
    extract_price as fields_price,
)
from scraper.pipeline import extract_inventory  # noqa: E402
from scraper.schema import normalize_vehicle  # noqa: E402
from scraper.stock import (  # noqa: E402
    MISSING_STOCK,
    extract_stock_from_html,
    resolve_stock_number,
)
from scraper.tier1_dom import parse_data_attributes  # noqa: E402
from scraper.vdp_hydrate import (  # noqa: E402
    extract_from_vdp_html,
    hydrate_vehicles,
    needs_hydration,
)

_FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "fixtures", "moses_vehicle_card.html"
)


def _load_fixture() -> str:
    with open(_FIXTURE_PATH, encoding="utf-8") as f:
        return f.read()

# Sample Moses / DealerOn SRP card HTML (trimmed)
MOSES_CARD_HTML = """
<div class="vehicle-card" data-vin="1HGCV1F3XPA056001" data-year="2025"
     data-make="Honda" data-model="Accord">
  <a href="/vdp/2025-honda-accord/1HGCV1F3XPA056001">2025 Honda Accord Sport</a>
  <div class="stock">Stock: HT60208</div>
  <span class="ext-color">Crystal Black Pearl</span>
  <div class="pricing">
    <span class="price-label">MOSES PRICE</span>
    <span class="price-value">$32,995</span>
  </div>
</div>
"""

# Realistic Moses Honda card — plain text patterns as seen in production SRP
MOSES_PLAIN_CARD = """
<div class="srp-vehicle-card" data-vin="1HGCV1F38PA123456">
  <a href="https://www.mosescars.com/new-St+Albans-2025-Honda-Civic-Sport-1HGCV1F38PA123456">
    2025 Honda Civic Sport
  </a>
  Stock: HT60456
  Ext. Black
  12 mi
  MOSES PRICE $32,995
</div>
"""

MOSES_USED_CARD = """
<div class="srp-vehicle-card">
  <span class="stock-number">VT60109A</span>
  <div>Ext: Radiant Red Metallic</div>
  <div>28,450 mi.</div>
  <div>INTERNET PRICE $24,990</div>
  VIN 2HGFC2F57MH404344
  <a href="/inventory/used/stock-VT60109A/vdp">View</a>
</div>
"""

MOSES_NEW_NO_MILES = """
<article class="inventory-card" data-vin="5FNYF8H59PB001001">
  <div>Stock: NH1003</div>
  <div>Ext Color: Sonic Gray Pearl</div>
  <div>OUR PRICE $48,750</div>
  <a href="/vdp/2025-honda-pilot">Detail</a>
</article>
"""

MOSES_VDP_HTML = """
<html><head>
  <meta property="og:price:amount" content="32995" />
  <script type="application/ld+json">
  {
    "@type": "Vehicle",
    "vehicleIdentificationNumber": "1HGCV1F38PA123456",
    "color": "Black",
    "sku": "HT60456",
    "offers": {"@type": "Offer", "price": "32995", "priceCurrency": "USD"},
    "mileageFromOdometer": {"value": 12}
  }
  </script>
</head><body>
  <div>Stock: HT60456</div>
  <div>Ext. Black</div>
  <div>12 mi</div>
  <div>MOSES PRICE $32,995</div>
</body></html>
"""


class TestMosesLayoutFixture(unittest.TestCase):
    """Parse the moses_layout.txt-derived card fixture; assert all key fields."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = _load_fixture()

    def test_fixture_fields_populated(self):
        vehicles = parse_data_attributes(
            self.fixture,
            "https://www.mosescars.com/search-all-new-inventory.html",
            condition="New",
        )
        self.assertGreaterEqual(len(vehicles), 1, "expected at least one parsed card")
        v = vehicles[0]
        # One-shot verification log (not a permanent production path).
        print(
            "FIRST_PARSED_VEHICLE",
            {
                "stockNumber": v.get("stockNumber"),
                "exteriorColor": v.get("exteriorColor"),
                "price": v.get("price"),
                "mileage": v.get("mileage"),
                "vin": v.get("vin"),
            },
            flush=True,
        )
        self.assertEqual(v["stockNumber"], "WC40225")
        self.assertNotEqual(v["stockNumber"], MISSING_STOCK)
        self.assertEqual(v["exteriorColor"], "Space Silver Metallic")
        self.assertEqual(v["price"], 111020)
        self.assertEqual(v["mileage"], 4755)
        self.assertEqual(v["vin"], "WBY43EJ00RCR48753")

    def test_pipeline_extract_inventory_fixture(self):
        result = extract_inventory(
            self.fixture,
            "https://www.mosescars.com/search-all-new-inventory.html",
            condition="New",
            min_ok=1,
            enable_llm=False,
        )
        self.assertGreaterEqual(result["count"], 1)
        v = result["vehicles"][0]
        self.assertEqual(v["stockNumber"], "WC40225")
        self.assertEqual(v["exteriorColor"], "Space Silver Metallic")
        self.assertEqual(v["price"], 111020)
        self.assertEqual(v["mileage"], 4755)
        self.assertEqual(v["vin"], "WBY43EJ00RCR48753")

    def test_layout_class_extractors(self):
        html = self.fixture
        self.assertEqual(extract_stock_from_html(html), "WC40225")
        self.assertEqual(fields_color(html), "Space Silver Metallic")
        self.assertEqual(fields_mileage(html, condition="New"), 4755)
        self.assertEqual(fields_price(html), 111020)


class TestMosesStockSelectors(unittest.TestCase):
    def test_stock_colon_regex(self):
        self.assertEqual(extract_stock_from_html("Stock: HT60208"), "HT60208")
        self.assertEqual(extract_stock_from_html("STOCK: VT60109A"), "VT60109A")
        self.assertEqual(extract_stock_from_html("Stock: HT60456"), "HT60456")
        self.assertEqual(extract_stock_from_html("Stock #: HT60456"), "HT60456")
        self.assertEqual(extract_stock_number("Stock: HT60456"), "HT60456")
        self.assertEqual(extract_stock_number("Stock: HT60208"), "HT60208")
        self.assertEqual(extract_stock_number("Stock #: HT60456"), "HT60456")

    def test_stock_class_dom(self):
        html = '<div class="stock">Stock: HT60208</div>'
        self.assertEqual(extract_stock_from_html(html), "HT60208")
        html2 = '<span class="stock-number">VT60109A</span>'
        self.assertEqual(extract_stock_from_html(html2), "VT60109A")
        html3 = '<div data-stock="HT60456">x</div>'
        self.assertEqual(extract_stock_from_html(html3), "HT60456")
        html4 = (
            '<div class="vehicle-identifiers">'
            '<span class="vehicle-identifiers__label">Stock #:</span>'
            '<span class="vehicle-identifiers__value">WC40225</span>'
            "</div>"
        )
        self.assertEqual(extract_stock_from_html(html4), "WC40225")

    def test_stock_never_falls_to_unavailable(self):
        stock = resolve_stock_number(
            {},
            '<div class="stock">Stock: HT60208</div>',
            link="https://dealer.example/vdp/2025-honda",
        )
        self.assertEqual(stock, "HT60208")
        self.assertNotEqual(stock, MISSING_STOCK)
        self.assertNotEqual(stock.upper(), "UNAVAILABLE")

    def test_stock_beats_unavailable_in_sanitize(self):
        row = sanitize_vehicle_record(
            {"vin": "1HGCV1F3XPA056001", "year": 2025, "make": "Honda", "model": "Accord"},
            "Stock: HT60208 MOSES PRICE $32,995",
        )
        self.assertEqual(row["stock_number"], "HT60208")
        self.assertEqual(row["stockNumber"], "HT60208")


class TestMosesColorMileagePrice(unittest.TestCase):
    def test_exterior_color_labels(self):
        self.assertEqual(extract_exterior_color("Ext: Crystal Black Pearl"), "Crystal Black Pearl")
        self.assertEqual(extract_exterior_color("Ext. Sonic Gray Pearl Stock: X"), "Sonic Gray Pearl")
        self.assertEqual(extract_exterior_color("Ext. Black"), "Black")
        self.assertEqual(extract_exterior_color("Exterior: Rallye Red"), "Rallye Red")
        self.assertEqual(extract_exterior_color("Ext Color: Radiant Red Metallic"), "Radiant Red Metallic")
        self.assertEqual(
            fields_color('<span class="ext-color">Crystal Black Pearl</span>'),
            "Crystal Black Pearl",
        )
        self.assertEqual(
            fields_color('<div data-color="Aegean Blue Metallic">x</div>'),
            "Aegean Blue Metallic",
        )
        self.assertEqual(
            fields_color(
                '<div class="vehicle-colors__ext">'
                '<span class="vehicle-colors__label">Ext.</span>'
                '<span class="vehicle-colors__value">Space Silver Metallic</span>'
                "</div>"
            ),
            "Space Silver Metallic",
        )

    def test_mileage_mi_suffix(self):
        self.assertEqual(extract_mileage("28,450 mi."), 28450)
        self.assertEqual(extract_mileage("12,345 mi"), 12345)
        self.assertEqual(extract_mileage("12 mi"), 12)
        self.assertEqual(extract_mileage("12 miles"), 12)
        self.assertEqual(fields_mileage("28,450 mi."), 28450)
        self.assertEqual(fields_mileage("12 mi"), 12)
        self.assertEqual(fields_mileage("12 miles"), 12)
        self.assertEqual(
            fields_mileage('<div class="vehicle-mileage">12 mi</div>', condition="New"),
            12,
        )

    def test_new_missing_mileage_defaults_zero(self):
        self.assertEqual(fields_mileage("Stock: NH1003 OUR PRICE $48,750", condition="New"), 0)
        norm = normalize_vehicle(
            {
                "vin": "5FNYF8H59PB001001",
                "year": 2025,
                "make": "Honda",
                "model": "Pilot",
                "link": "https://www.mosescars.com/vdp/pilot",
                "_html": MOSES_NEW_NO_MILES,
            },
            condition="New",
        )
        self.assertIsNotNone(norm)
        assert norm is not None
        self.assertEqual(norm["mileage"], 0)
        self.assertEqual(norm["stockNumber"], "NH1003")

    def test_price_labels_and_card_regex(self):
        self.assertEqual(extract_price("MOSES PRICE $32,995"), 32995)
        self.assertEqual(extract_price("INTERNET PRICE $24,990"), 24990)
        self.assertEqual(extract_price("OUR PRICE $48,750"), 48750)
        self.assertEqual(extract_price("TSRP $35,000"), 35000)
        self.assertEqual(fields_price("Ask about financing $19,995 today"), 19995)
        self.assertEqual(fields_price("MOSES PRICE $32,995"), 32995)
        self.assertEqual(
            fields_price(
                '<div class="vehiclePricingHighlight featuredPrice">'
                '<div class="vehiclePricingHighlightLabel">MOSES PRICE</div>'
                '<div class="vehiclePricingHighlightAmount">$32,995</div>'
                "</div>"
            ),
            32995,
        )


class TestMosesCardNormalize(unittest.TestCase):
    def test_full_moses_card(self):
        norm = normalize_vehicle(
            {
                "vin": "1HGCV1F3XPA056001",
                "year": 2025,
                "make": "Honda",
                "model": "Accord",
                "link": "https://www.mosescars.com/vdp/2025-honda-accord/1HGCV1F3XPA056001",
                "_html": MOSES_CARD_HTML,
            },
            condition="New",
        )
        self.assertIsNotNone(norm)
        assert norm is not None
        self.assertEqual(norm["stockNumber"], "HT60208")
        self.assertEqual(norm["exteriorColor"], "Crystal Black Pearl")
        self.assertEqual(norm["price"], 32995)
        self.assertEqual(norm["mileage"], 0)  # New, miles omitted
        self.assertTrue(norm["link"])

    def test_plain_text_moses_card_ht60456(self):
        """Production-shaped card: Stock: HT60456 / Ext. Black / 12 mi / MOSES PRICE."""
        norm = normalize_vehicle(
            {
                "vin": "1HGCV1F38PA123456",
                "year": 2025,
                "make": "Honda",
                "model": "Civic",
                "link": (
                    "https://www.mosescars.com/new-St+Albans-2025-Honda-Civic-Sport-"
                    "1HGCV1F38PA123456"
                ),
                "_html": MOSES_PLAIN_CARD,
            },
            condition="New",
        )
        self.assertIsNotNone(norm)
        assert norm is not None
        self.assertEqual(norm["stockNumber"], "HT60456")
        self.assertNotEqual(norm["stockNumber"], MISSING_STOCK)
        self.assertEqual(norm["exteriorColor"], "Black")
        self.assertEqual(norm["mileage"], 12)
        self.assertEqual(norm["price"], 32995)

    def test_used_card_with_miles(self):
        norm = normalize_vehicle(
            {
                "vin": "2HGFC2F57MH404344",
                "year": 2022,
                "make": "Honda",
                "model": "Civic",
                "link": "https://www.mosescars.com/inventory/used/stock-VT60109A/vdp",
                "_html": MOSES_USED_CARD,
            },
            condition="Used",
        )
        self.assertIsNotNone(norm)
        assert norm is not None
        self.assertEqual(norm["stockNumber"], "VT60109A")
        self.assertEqual(norm["mileage"], 28450)
        self.assertEqual(norm["price"], 24990)
        self.assertIn("Red", norm["exteriorColor"])


class TestMosesVdpHydrate(unittest.TestCase):
    def test_extract_from_vdp_html(self):
        data = extract_from_vdp_html(MOSES_VDP_HTML, condition="New")
        self.assertEqual(data.get("stock_number"), "HT60456")
        self.assertEqual(data.get("price"), 32995)
        self.assertEqual(data.get("exterior_color"), "Black")
        self.assertEqual(data.get("mileage"), 12)

    def test_needs_hydration(self):
        self.assertTrue(
            needs_hydration(
                {
                    "stockNumber": MISSING_STOCK,
                    "price": 0,
                    "link": "https://www.mosescars.com/vdp/x",
                }
            )
        )
        self.assertFalse(
            needs_hydration(
                {
                    "stockNumber": "HT60456",
                    "price": 32995,
                    "link": "https://www.mosescars.com/vdp/x",
                }
            )
        )
        self.assertFalse(needs_hydration({"stockNumber": MISSING_STOCK, "price": 0}))

    def test_hydrate_vehicles_mocked(self):
        thin = {
            "vin": "1HGCV1F38PA123456",
            "stockNumber": MISSING_STOCK,
            "stock_number": MISSING_STOCK,
            "year": 2025,
            "make": "Honda",
            "model": "Civic",
            "price": 0,
            "mileage": 0,
            "exteriorColor": "",
            "link": "https://www.mosescars.com/vdp/civic",
            "condition": "New",
        }
        with mock.patch(
            "scraper.vdp_hydrate.fetch_html",
            return_value=MOSES_VDP_HTML,
        ):
            out = hydrate_vehicles([thin], condition="New", max_fetches=5, workers=2)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["stockNumber"], "HT60456")
        self.assertEqual(out[0]["price"], 32995)
        self.assertEqual(out[0]["exteriorColor"], "Black")
        self.assertEqual(out[0]["mileage"], 12)
        # Link must not be mangled
        self.assertEqual(out[0]["link"], "https://www.mosescars.com/vdp/civic")


if __name__ == "__main__":
    unittest.main(verbosity=2)
