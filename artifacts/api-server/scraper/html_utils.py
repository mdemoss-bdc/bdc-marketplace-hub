"""HTML fetch helpers and HTML-entity decoding (stdlib stand-in for he.decode)."""

from __future__ import annotations

import html as html_lib
import re
import urllib.error
import urllib.request
from typing import Any

_ENTITY_RE = re.compile(r"&#x([0-9a-fA-F]+);|&#(\d+);|&([a-zA-Z]+);")


def decode_entities(text: str) -> str:
    """Resolve ``&#x2B;``, ``&amp;``, etc. Equivalent to he.decode() for our needs."""
    if not text:
        return ""
    try:
        return html_lib.unescape(str(text))
    except Exception:
        return str(text)


def clean_text(text: Any) -> str:
    s = decode_entities("" if text is None else str(text))
    s = re.sub(r"\s+", " ", s).strip()
    return s


def fetch_html(url: str, *, timeout: int = 25, max_retries: int = 2) -> str:
    """Fetch raw HTML with a realistic browser User-Agent."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    last_err: Exception | None = None
    for _ in range(max(1, max_retries)):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            return raw.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
    raise RuntimeError(f"Failed to fetch {url!r}: {last_err}")


def absolutize(href: str, base_url: str) -> str:
    href = clean_text(href)
    if not href or href.startswith(("#", "javascript:", "mailto:")):
        return ""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("http://") or href.startswith("https://"):
        return href
    from urllib.parse import urljoin
    return urljoin(base_url, href)
