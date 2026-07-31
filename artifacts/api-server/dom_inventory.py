"""
dom_inventory.py — Stdlib DOM ingestion & noise reduction for inventory HTML.

Mirrors Cheerio/jsdom-style workflows using Python's html.parser:
  1. Strip <script>, <style>, <noscript>, <header>, <footer>, <nav>, <aside>
  2. Isolate primary vehicle listing cards/containers
  3. Extract clean card text for regex sanitization via inventory_parser
"""

from __future__ import annotations

import html as html_lib
import html.parser
import re
from typing import Any

# Tags whose entire subtrees are discarded before text extraction.
_NOISE_TAGS = frozenset({
    "script",
    "style",
    "noscript",
    "svg",
    "iframe",
    "template",
    "header",
    "footer",
    "nav",
    "aside",
})

_VOID = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
})

_CARD_CLASS_RE = re.compile(
    r"(?:^|[\s_-])(?:srp-vehicle-card|vehicle-card|inventory-item|"
    r"inventory-card|vehicle-listing|srp-card|listing-card|"
    r"vdp-card|result-item|vehicle-result)(?:$|[\s_-])",
    re.IGNORECASE,
)

_VIN_RE = re.compile(r"\b([A-HJ-NPR-Z0-9]{17})\b", re.IGNORECASE)

_WHITESPACE_RE = re.compile(r"\s+")


class _DomNoiseStripper(html.parser.HTMLParser):
    """Remove noise tags and emit a cleaned HTML fragment (cards preserved)."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        low = tag.lower()
        if self._skip_depth:
            if low not in _VOID:
                self._skip_depth += 1
            return
        if low in _NOISE_TAGS:
            if low not in _VOID:
                self._skip_depth = 1
            return
        attr_s = "".join(
            f' {k}="{html_lib.escape(v, quote=True)}"' if v is not None else f" {k}"
            for k, v in attrs
        )
        self._parts.append(f"<{low}{attr_s}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        low = tag.lower()
        if self._skip_depth:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if low in _NOISE_TAGS or low in _VOID:
            return
        self._parts.append(f"</{low}>")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth and data:
            self._parts.append(data)

    def get_html(self) -> str:
        return "".join(self._parts)


class _VehicleCardCollector(html.parser.HTMLParser):
    """Isolate primary vehicle listing cards and capture their visible text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.cards: list[dict[str, Any]] = []
        self._depth = 0
        self._skip_depth = 0
        self._cur: dict[str, Any] | None = None
        self._cur_depth = -1
        self._text_buf: list[str] = []
        self._html_buf: list[str] = []

    def _attr_map(self, attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {k.lower(): (v or "") for k, v in attrs}

    def _looks_like_card(self, tag: str, d: dict[str, str]) -> bool:
        if d.get("data-vin"):
            return True
        if d.get("data-vehicle") or d.get("data-vehicle-id"):
            return True
        class_attr = d.get("class", "")
        if _CARD_CLASS_RE.search(class_attr):
            return True
        # Broad data-* inventory markers used by DealerOn / DDC / etc.
        if any(
            k.startswith("data-") and k.endswith(("vin", "stock", "stock-number", "year"))
            for k in d
        ) and tag in ("div", "li", "article", "section"):
            if d.get("data-year") or d.get("data-make") or d.get("data-stock"):
                return True
        return False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        low = tag.lower()
        d = self._attr_map(attrs)

        if self._skip_depth:
            if low not in _VOID:
                self._skip_depth += 1
            return

        if low in _NOISE_TAGS:
            if low not in _VOID:
                self._skip_depth = 1
            return

        self._depth += 1

        if self._cur is None and self._looks_like_card(low, d):
            self._cur = {
                "vin": (d.get("data-vin") or "").upper(),
                "stock_number": (
                    d.get("data-stock-number")
                    or d.get("data-stocknumber")
                    or d.get("data-stock-no")
                    or d.get("data-stockno")
                    or d.get("data-stock")
                    or d.get("data-vehicle-stock")
                    or d.get("data-stocknum")
                    or ""
                ),
                "year": d.get("data-year") or "",
                "make": d.get("data-make") or "",
                "model": d.get("data-model") or "",
                "trim": d.get("data-trim") or "",
                "mileage": d.get("data-mileage") or d.get("data-miles") or d.get("data-odometer") or "",
                "price": (
                    d.get("data-price")
                    or d.get("data-internet-price")
                    or d.get("data-internetprice")
                    or d.get("data-final-price")
                    or d.get("data-finalprice")
                    or ""
                ),
                "exterior_color": (
                    d.get("data-exterior-color")
                    or d.get("data-exteriorcolor")
                    or d.get("data-extcolor")
                    or d.get("data-ext-color")
                    or d.get("data-color")
                    or ""
                ),
                "interior_color": (
                    d.get("data-interior-color")
                    or d.get("data-interiorcolor")
                    or ""
                ),
                "image_url": "",
                "location": (
                    d.get("data-location")
                    or d.get("data-dealer-name")
                    or d.get("data-store")
                    or ""
                ),
                "raw_text": "",
            }
            self._cur_depth = self._depth
            self._text_buf = []
            self._html_buf = []

        if self._cur is not None:
            attr_s = "".join(
                f' {k}="{html_lib.escape(v, quote=True)}"' if v is not None else f" {k}"
                for k, v in attrs
            )
            self._html_buf.append(f"<{low}{attr_s}>")
            if low == "img":
                src = d.get("src") or d.get("data-src") or d.get("data-lazy") or ""
                if src and not src.startswith("data:") and not self._cur.get("image_url"):
                    self._cur["image_url"] = src

        if low in _VOID:
            self._depth -= 1

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._cur is not None and data and data.strip():
            self._text_buf.append(data.strip())
            self._html_buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        low = tag.lower()
        if self._skip_depth:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if low in _NOISE_TAGS or low in _VOID:
            return

        if self._cur is not None:
            self._html_buf.append(f"</{low}>")

        if self._cur is not None and self._depth == self._cur_depth:
            blob = _WHITESPACE_RE.sub(" ", " ".join(self._text_buf)).strip()
            html_frag = "".join(self._html_buf)
            self._cur["raw_text"] = blob
            if not self._cur.get("vin") and blob:
                m = _VIN_RE.search(blob)
                if m:
                    self._cur["vin"] = m.group(1).upper()
            # Moses / DealerOn class + label fallbacks when data-* attrs empty.
            if not self._cur.get("stock_number"):
                sm = re.search(
                    r'class=["\'][^"\']*\b(?:stock-number|stock)\b[^"\']*["\'][^>]*>\s*'
                    r'(?:Stock\s*:\s*)?([A-Za-z0-9]{3,15})\s*<',
                    html_frag,
                    re.I,
                ) or re.search(r"Stock:\s*([A-Za-z0-9]+)", blob, re.I)
                if sm:
                    self._cur["stock_number"] = sm.group(1).strip()
            if not self._cur.get("exterior_color"):
                cm = re.search(
                    r'class=["\'][^"\']*\b(?:ext-color|exterior-color)\b[^"\']*["\'][^>]*>\s*'
                    r'([^<]{2,48})\s*<',
                    html_frag,
                    re.I,
                ) or re.search(r'data-color=["\']([^"\']+)["\']', html_frag, re.I)
                if cm:
                    self._cur["exterior_color"] = cm.group(1).strip()
            if not self._cur.get("mileage"):
                mm = re.search(r"([0-9,]+)\s*(?:mi\.?|miles)\b", blob, re.I)
                if mm:
                    self._cur["mileage"] = mm.group(1)
            if not self._cur.get("price"):
                pm = re.search(
                    r"(?:MOSES\s+PRICE|INTERNET\s+PRICE|OUR\s+PRICE|TSRP)\s*:?\s*\$?\s*"
                    r"([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})",
                    blob,
                    re.I,
                ) or re.search(r"\$([0-9]{2,3},[0-9]{3})", blob)
                if pm:
                    self._cur["price"] = pm.group(1)
            if self._cur.get("vin") and len(str(self._cur["vin"])) == 17:
                self.cards.append(dict(self._cur))
            self._cur = None
            self._cur_depth = -1
            self._text_buf = []
            self._html_buf = []

        self._depth -= 1


def strip_dom_noise(html_text: str) -> str:
    """Strip script/style/header/nav/footer noise; return cleaned HTML."""
    parser = _DomNoiseStripper()
    try:
        parser.feed(str(html_text or ""))
        parser.close()
    except Exception:
        # Fallback: regex strip when the streaming parser chokes on broken HTML.
        text = str(html_text or "")
        text = re.sub(
            r"<(script|style|noscript|header|footer|nav|aside)\b[^>]*>[\s\S]*?</\1>",
            " ",
            text,
            flags=re.IGNORECASE,
        )
        return text
    return parser.get_html()


def isolate_listing_cards(html_text: str) -> list[dict[str, Any]]:
    """Isolate vehicle listing cards after DOM noise reduction."""
    cleaned = strip_dom_noise(html_text)
    collector = _VehicleCardCollector()
    try:
        collector.feed(cleaned)
        collector.close()
    except Exception:
        pass
    return collector.cards


def cards_to_vehicles(
    cards: list[dict[str, Any]],
    *,
    condition: str = "",
) -> list[dict[str, Any]]:
    """Run each card through inventory_parser regex sanitization."""
    try:
        from inventory_parser import sanitize_vehicle_record
    except ImportError:
        sanitize_vehicle_record = None  # type: ignore[assignment]

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for card in cards:
        raw_text = str(card.get("raw_text") or "")
        record = dict(card)
        record.pop("raw_text", None)
        if condition:
            record["condition"] = condition
        if sanitize_vehicle_record is not None:
            try:
                record = sanitize_vehicle_record(record, raw_text)
            except Exception:
                pass
        vin = str(record.get("vin") or "").upper()
        if len(vin) != 17 or vin in seen:
            continue
        seen.add(vin)
        record["vin"] = vin
        out.append(record)
    return out


def parse_inventory_html(html_text: str, condition: str = "") -> list[dict[str, Any]]:
    """Full pipeline: DOM strip → card isolate → regex sanitize → typed dicts."""
    cards = isolate_listing_cards(html_text)
    vehicles = cards_to_vehicles(cards, condition=condition)
    if vehicles:
        return vehicles

    # Fallback: strip noise, then regex-scan clean text windows around VINs.
    try:
        from inventory_parser import sanitize_vehicle_record, extract_vin
    except ImportError:
        return []

    cleaned = strip_dom_noise(html_text)
    text = re.sub(r"<[^>]+>", " ", cleaned)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    vins = _VIN_RE.findall(text)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for vin in vins:
        vin_u = vin.upper()
        if vin_u in seen:
            continue
        seen.add(vin_u)
        idx = text.upper().find(vin_u)
        window = text[max(0, idx - 180) : idx + 220]
        record = sanitize_vehicle_record(
            {"vin": vin_u, "condition": condition},
            window,
        )
        if extract_vin(record.get("vin") or "") or len(vin_u) == 17:
            out.append(record)
    return out
