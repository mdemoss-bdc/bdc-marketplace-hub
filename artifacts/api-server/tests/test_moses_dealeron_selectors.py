"""Focused unit tests: Moses / DealerOn DOM selectors for stock, color, miles, price."""

from __future__ import annotations

import os
import sys
import unittest

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
from scraper.schema import normalize_vehicle  # noqa: E402
from scraper.stock import (  # noqa: E402
    MISSING_STOCK,
    extract_stock_from_html,
    resolve_stock_number,
)

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


class TestMosesStockSelectors(unittest.TestCase):
    def test_stock_colon_regex(self):
        self.assertEqual(extract_stock_from_html("Stock: HT60208"), "HT60208")
        self.assertEqual(extract_stock_from_html("STOCK: VT60109A"), "VT60109A")
        self.assertEqual(extract_stock_number("Stock: HT60208"), "HT60208")

    def test_stock_class_dom(self):
        html = '<div class="stock">Stock: HT60208</div>'
        self.assertEqual(extract_stock_from_html(html), "HT60208")
        html2 = '<span class="stock-number">VT60109A</span>'
        self.assertEqual(extract_stock_from_html(html2), "VT60109A")

    def test_stock_never_falls_to_unavailable(self):
        stock = resolve_stock_number(
            {},
            '<div class="stock">Stock: HT60208</div>',
            link="https://dealer.example/vdp/2025-honda",
        )
        self.assertEqual(stock, "HT60208")
        self.assertNotEqual(stock, MISSING_STOCK)

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

    def test_mileage_mi_suffix(self):
        self.assertEqual(extract_mileage("28,450 mi."), 28450)
        self.assertEqual(extract_mileage("12,345 mi"), 12345)
        self.assertEqual(fields_mileage("28,450 mi."), 28450)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
