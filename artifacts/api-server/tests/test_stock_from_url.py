"""Sanity tests: extract stock numbers from VDP URL query + path patterns."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scraper.stock import (  # noqa: E402
    IN_TRANSIT_STOCK,
    MISSING_STOCK,
    extract_stock_from_url,
    resolve_stock_number,
)


class TestStockFromUrl(unittest.TestCase):
    def test_query_stock(self):
        self.assertEqual(
            extract_stock_from_url(
                "https://dealer.example/vdp/2024-honda?stock=P1234"
            ),
            "P1234",
        )

    def test_query_stock_number_alias(self):
        self.assertEqual(
            extract_stock_from_url(
                "https://dealer.example/vehicle?stockNumber=U89012&foo=1"
            ),
            "U89012",
        )

    def test_query_stk_and_vin_stock(self):
        self.assertEqual(
            extract_stock_from_url("https://d.example/x?stk=1049A"),
            "1049A",
        )
        self.assertEqual(
            extract_stock_from_url("https://d.example/x?vin_stock=NH1001"),
            "NH1001",
        )

    def test_path_stk_dash(self):
        self.assertEqual(
            extract_stock_from_url(
                "https://dealer.example/inventory/stk-P1234/detail"
            ),
            "P1234",
        )

    def test_path_stock_dash_and_underscore(self):
        self.assertEqual(
            extract_stock_from_url(
                "https://dealer.example/used/stock-U89012/vdp"
            ),
            "U89012",
        )
        self.assertEqual(
            extract_stock_from_url(
                "https://dealer.example/new/stock_1049A/"
            ),
            "1049A",
        )

    def test_path_glued_stk(self):
        self.assertEqual(
            extract_stock_from_url(
                "https://dealer.example/vehicle/2024-honda-civic-stkP5555"
            ),
            "P5555",
        )

    def test_reject_year_and_vin(self):
        self.assertEqual(
            extract_stock_from_url("https://d.example/v?stock=2024", year=2024),
            "",
        )
        vin = "1HGCV1F3XPA056001"
        self.assertEqual(
            extract_stock_from_url(f"https://d.example/v?stock={vin}", vin=vin),
            "",
        )

    def test_reject_sentinels(self):
        self.assertEqual(
            extract_stock_from_url("https://d.example/v?stock=Unavailable"),
            "",
        )
        self.assertEqual(
            extract_stock_from_url("https://d.example/v?stock=In%20Transit"),
            "",
        )

    def test_resolve_order_url_before_unavailable(self):
        stock = resolve_stock_number(
            {},
            "",
            link="https://dealer.example/vdp/stk-P9999",
        )
        self.assertEqual(stock, "P9999")

    def test_resolve_order_dom_beats_url(self):
        html = '<div data-stocknumber="DOM123">In Transit</div>'
        stock = resolve_stock_number(
            {},
            html,
            link="https://dealer.example/vdp?stock=URL999",
        )
        self.assertEqual(stock, "DOM123")

    def test_resolve_in_transit_after_url_miss(self):
        stock = resolve_stock_number(
            {"availability": "Arriving Soon"},
            "",
            link="https://dealer.example/vdp/2024-honda-civic",
        )
        self.assertEqual(stock, IN_TRANSIT_STOCK)

    def test_resolve_unavailable_last(self):
        stock = resolve_stock_number(
            {},
            "",
            link="https://dealer.example/vdp/2024-honda-civic",
        )
        self.assertEqual(stock, MISSING_STOCK)

    def test_does_not_mangle_link_on_vehicle(self):
        link = "https://dealer.example/vdp/stk-P1234?utm=keep"
        vehicle = {"link": link}
        stock = resolve_stock_number(vehicle, "", link=link)
        self.assertEqual(stock, "P1234")
        self.assertEqual(vehicle["link"], link)


if __name__ == "__main__":
    unittest.main()
