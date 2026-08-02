"""Unit tests: Scraper Gauntlet Matrix — each step wins when priors are empty."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scraper.gauntlet import (  # noqa: E402
    critical_payload,
    extract_with_gauntlet,
    gauntlet_complete,
    run_gauntlet,
    step1_schema_jsonld,
    step2_dealeron_grid,
    step3_dealertrack_sincro,
    step4_text_bruteforce,
)
from scraper.pipeline import extract_inventory  # noqa: E402
from scraper.stock import MISSING_STOCK  # noqa: E402

_FIXTURE_PATH = os.path.join(
    os.path.dirname(__file__), "fixtures", "moses_vehicle_card.html"
)

JSON_LD_ONLY = """
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Vehicle",
  "vehicleIdentificationNumber": "1HGCV1F38PA123456",
  "productionDate": "2025",
  "brand": {"@type": "Brand", "name": "Honda"},
  "model": "Civic",
  "color": "Crystal Black Pearl",
  "sku": "HT60456",
  "mileageFromOdometer": {"@type": "QuantitativeValue", "value": 12},
  "offers": {"@type": "Offer", "price": "32995", "priceCurrency": "USD"},
  "url": "https://dealer.example/vdp/civic"
}
</script>
</head><body></body></html>
"""

JSON_LD_GRAPH = """
<script type="application/ld+json">
{
  "@graph": [
    {
      "@type": "Car",
      "vehicleIdentificationNumber": "5FNYF8H59PB001001",
      "modelDate": "2025",
      "brand": "Honda",
      "model": "Pilot",
      "color": "Sonic Gray Pearl",
      "mpn": "NH1003",
      "mileageFromOdometer": {"value": 0},
      "offers": {"price": 48750}
    }
  ]
}
</script>
"""

DEALERON_CARD = """
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
"""

SINCRO_CARD = """
<article class="sincro-srp-card"
         data-vin="1N4BL4BV0RN312345"
         data-stock="NS4412"
         data-price="27990"
         data-color="Gun Metallic"
         data-mileage="8450">
  <div class="vdp-price sincro-pricing">$27,990</div>
  <a href="/inventory/2024-nissan-altima/1N4BL4BV0RN312345">View</a>
</article>
"""

BRUTE_CARD = """
<div class="listing">
  2023 Toyota Camry SE
  stk #: TY-77881
  exterior: Celestial Silver Metallic
  odometer: 31,200 miles
  Ask $21,450 today
  VIN 4T1G11AK0PU123456
  <a href="/vdp/camry">detail</a>
</div>
"""


class TestGauntletStepWins(unittest.TestCase):
    """Each step populates critical fields when earlier steps yield nothing."""

    def test_step1_jsonld_wins_alone(self):
        empty = {"condition": "New"}
        out = step1_schema_jsonld(empty, JSON_LD_ONLY, condition="New")
        self.assertEqual(out.get("vin"), "1HGCV1F38PA123456")
        self.assertEqual(out.get("stockNumber"), "HT60456")
        self.assertEqual(out.get("exteriorColor"), "Crystal Black Pearl")
        self.assertEqual(int(out.get("price") or 0), 32995)
        self.assertEqual(int(out.get("mileage") or 0), 12)
        self.assertTrue(gauntlet_complete(out, condition="New"))

    def test_step1_jsonld_graph(self):
        out = step1_schema_jsonld({}, JSON_LD_GRAPH, condition="New")
        self.assertEqual(out.get("vin"), "5FNYF8H59PB001001")
        self.assertEqual(out.get("stockNumber"), "NH1003")
        self.assertEqual(out.get("exteriorColor"), "Sonic Gray Pearl")
        self.assertEqual(int(out.get("price") or 0), 48750)

    def test_step2_dealeron_wins_when_jsonld_empty(self):
        empty = {"vin": "1HGCV1F3XPA056001", "condition": "New"}
        # Step 1 on empty HTML leaves gaps
        after1 = step1_schema_jsonld(empty, "<html></html>", condition="New")
        self.assertTrue(gauntlet_incomplete_stock_price(after1))
        out = step2_dealeron_grid(after1, DEALERON_CARD, condition="New")
        self.assertEqual(out.get("stockNumber"), "HT60208")
        self.assertIn("Red", out.get("exteriorColor") or "")
        self.assertEqual(int(out.get("price") or 0), 32995)
        self.assertEqual(int(out.get("mileage") or 0), 12)

    def test_step2_cosmos_skeleton_fallback(self):
        thin = {"vin": "WBY43EJ00RCR48753", "condition": "New"}
        cosmos = {
            "WBY43EJ00RCR48753": {
                "vin": "WBY43EJ00RCR48753",
                "stockNumber": "WC40225",
                "exteriorColor": "Space Silver Metallic",
                "price": 111020,
                "mileage": 4755,
            }
        }
        out = step2_dealeron_grid(
            thin,
            '<div class="vehicle-card skeleton"></div>',
            condition="New",
            cosmos_by_vin=cosmos,
        )
        self.assertEqual(out.get("stockNumber"), "WC40225")
        self.assertEqual(out.get("exteriorColor"), "Space Silver Metallic")
        self.assertEqual(int(out.get("price") or 0), 111020)
        self.assertEqual(int(out.get("mileage") or 0), 4755)

    def test_step3_sincro_wins_when_priors_empty(self):
        empty = {"condition": "Used"}
        after1 = step1_schema_jsonld(empty, "", condition="Used")
        after2 = step2_dealeron_grid(after1, "<div></div>", condition="Used")
        out = step3_dealertrack_sincro(after2, SINCRO_CARD, condition="Used")
        self.assertEqual(out.get("vin"), "1N4BL4BV0RN312345")
        self.assertEqual(out.get("stockNumber"), "NS4412")
        self.assertEqual(out.get("exteriorColor"), "Gun Metallic")
        self.assertEqual(int(out.get("price") or 0), 27990)
        self.assertEqual(int(out.get("mileage") or 0), 8450)

    def test_step4_bruteforce_wins_when_priors_empty(self):
        empty = {"condition": "Used", "_html": BRUTE_CARD}
        after1 = step1_schema_jsonld(empty, "", condition="Used")
        after2 = step2_dealeron_grid(after1, "<div></div>", condition="Used")
        after3 = step3_dealertrack_sincro(after2, "<div></div>", condition="Used")
        out = step4_text_bruteforce(after3, BRUTE_CARD, condition="Used")
        self.assertEqual(out.get("vin"), "4T1G11AK0PU123456")
        self.assertEqual(out.get("stockNumber"), "TY-77881")
        self.assertIn("Silver", out.get("exteriorColor") or "")
        self.assertEqual(int(out.get("price") or 0), 21450)
        self.assertEqual(int(out.get("mileage") or 0), 31200)

    def test_run_gauntlet_never_overwrites_true_data(self):
        seed = {
            "vin": "1HGCV1F38PA123456",
            "stockNumber": "KEEPME",
            "exteriorColor": "Blue",
            "price": 99999,
            "mileage": 100,
            "condition": "Used",
            "_mileage_resolved": True,
        }
        out = run_gauntlet(
            seed,
            card_html=DEALERON_CARD,
            page_html=JSON_LD_ONLY,
            condition="Used",
            finalize_stock=False,
        )
        self.assertEqual(out["stockNumber"], "KEEPME")
        self.assertEqual(out["exteriorColor"], "Blue")
        self.assertEqual(out["price"], 99999)
        self.assertEqual(out["mileage"], 100)

    def test_stock_unavailable_only_when_all_fail(self):
        out = run_gauntlet(
            {"year": 2024, "make": "Honda", "model": "Civic", "link": "https://x/vdp/1"},
            card_html="<div class='vehicle-card'>no stock here</div>",
            page_html="",
            condition="Used",
            finalize_stock=True,
        )
        self.assertEqual(out.get("stockNumber"), MISSING_STOCK)


def gauntlet_incomplete_stock_price(v: dict) -> bool:
    stock = (v.get("stockNumber") or "").strip()
    return (not stock or stock == MISSING_STOCK) or int(v.get("price") or 0) <= 0


class TestGauntletPageExtract(unittest.TestCase):
    def test_extract_with_gauntlet_dealeron_card(self):
        html = f"<html><body>{DEALERON_CARD}</body></html>"
        vehicles = extract_with_gauntlet(
            html, "https://www.mosescars.com/search-all-new-inventory.html", condition="New",
        )
        self.assertGreaterEqual(len(vehicles), 1)
        payload = critical_payload(vehicles[0])
        print("FIRST_GAUNTLET_VEHICLE", payload, flush=True)
        self.assertEqual(payload["stockNumber"], "HT60208")
        self.assertNotEqual(payload["stockNumber"], MISSING_STOCK)
        self.assertEqual(payload["price"], 32995)
        self.assertEqual(payload["vin"], "1HGCV1F3XPA056001")
        self.assertEqual(payload["mileage"], 12)

    def test_fixture_pipeline_sample(self):
        if not os.path.isfile(_FIXTURE_PATH):
            self.skipTest("moses fixture missing")
        with open(_FIXTURE_PATH, encoding="utf-8") as f:
            fixture = f.read()
        result = extract_inventory(
            fixture,
            "https://www.mosescars.com/search-all-new-inventory.html",
            condition="New",
            min_ok=1,
            enable_llm=False,
        )
        self.assertGreaterEqual(result["count"], 1)
        sample = critical_payload(result["vehicles"][0])
        print("FIRST_FIXTURE_GAUNTLET_VEHICLE", sample, flush=True)
        self.assertEqual(sample["stockNumber"], "WC40225")
        self.assertEqual(sample["exteriorColor"], "Space Silver Metallic")
        self.assertEqual(sample["price"], 111020)
        self.assertEqual(sample["mileage"], 4755)
        self.assertEqual(sample["vin"], "WBY43EJ00RCR48753")


class TestNewBlankMileage(unittest.TestCase):
    def test_new_blank_miles_become_zero(self):
        card = """
        <div class="vehicle-card" data-vin="5FNYF8H59PB001001">
          Stock: NH1003
          Ext: Sonic Gray Pearl
          OUR PRICE $48,750
          <a href="/vdp/pilot">x</a>
        </div>
        """
        out = run_gauntlet(
            {"condition": "New"},
            card_html=card,
            condition="New",
            finalize_stock=True,
        )
        self.assertEqual(out.get("stockNumber"), "NH1003")
        self.assertEqual(int(out.get("mileage") or 0), 0)
        self.assertTrue(out.get("_mileage_resolved") or out.get("mileage") == 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
