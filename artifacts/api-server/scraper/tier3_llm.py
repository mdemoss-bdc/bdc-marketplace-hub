"""Tier 3 — Adaptive LLM parsing & schema normalization (AI safety net)."""

from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Any

from .html_utils import clean_text, decode_entities
from .schema import normalize_vehicle

_SYSTEM = (
    "You are an automotive inventory extraction engine. "
    "Extract vehicle listings from the provided dealership HTML/markdown chunk. "
    "Return ONLY a JSON array. Each object MUST use exactly these keys: "
    "stockNumber (string), year (number), make (string), model (string), "
    "trim (string), price (number), mileage (number), exteriorColor (string), "
    "link (string), imageUrl (string), vin (string). "
    "Use empty string or 0 when unknown. Never invent VINs. No markdown fences."
)


def _call_llm(messages: list[dict[str, str]], *, max_tokens: int = 2500) -> str | None:
    api_key = (
        os.environ.get("OPENAI_API_KEY")
        or os.environ.get("AI_INTEGRATIONS_OPENAI_API_KEY")
        or ""
    )
    base = (
        os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("AI_INTEGRATIONS_OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    if not api_key:
        return None
    model = os.environ.get("SCRAPER_LLM_MODEL") or os.environ.get(
        "AI_MODEL", "gpt-5-nano"
    )
    payload = json.dumps({
        "model": model,
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "messages": messages,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        print(f"[SCRAPER:T3] LLM call failed: {exc}")
        return None


def _html_to_compact_markdown(html: str, *, limit: int = 14000) -> str:
    text = decode_entities(html or "")
    text = re.sub(r"<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?</\1>", " ", text, flags=re.I)
    # Keep href/src hints for link binding
    text = re.sub(
        r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',
        lambda m: f" [link:{m.group(1)}] {clean_text(m.group(2))} ",
        text,
        flags=re.I,
    )
    text = re.sub(
        r'<img[^>]+(?:src|data-src)=["\']([^"\']+)["\'][^>]*>',
        lambda m: f" [image:{m.group(1)}] ",
        text,
        flags=re.I,
    )
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(?:p|div|li|tr|h\d)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:limit]


def _parse_llm_json(content: str) -> list[dict[str, Any]]:
    raw = (content or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except Exception:
        m = re.search(r"\[[\s\S]*\]", raw)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except Exception:
            return []
    if isinstance(data, dict):
        data = data.get("vehicles") or data.get("items") or data.get("inventory") or [data]
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def extract_tier3(
    html: str,
    page_url: str,
    *,
    condition: str = "Used",
    prior: list[dict] | None = None,
) -> list[dict]:
    """Ask the LLM to extract vehicles when tiers 1–2 under-deliver."""
    chunk = _html_to_compact_markdown(html)
    if len(chunk) < 80:
        return list(prior or [])

    hint = ""
    if prior:
        hint = (
            f"\nPrior partial extract found {len(prior)} vehicles; "
            "fill gaps and return the full corrected list."
        )

    content = _call_llm([
        {"role": "system", "content": _SYSTEM},
        {
            "role": "user",
            "content": (
                f"Page URL: {page_url}\nCondition context: {condition}.{hint}\n\n"
                f"Inventory page content:\n{chunk}"
            ),
        },
    ])
    if not content:
        return list(prior or [])

    out: list[dict] = []
    seen: set[str] = set()
    for raw in _parse_llm_json(content):
        if raw.get("link") and not str(raw["link"]).startswith("http"):
            from .html_utils import absolutize
            raw["link"] = absolutize(str(raw["link"]), page_url)
        norm = normalize_vehicle(raw, condition=condition)
        if not norm:
            continue
        vin = norm["vin"]
        if vin in seen:
            continue
        seen.add(vin)
        out.append(norm)

    print(f"[SCRAPER:T3] LLM extracted {len(out)} vehicles from {page_url!r}")
    return out or list(prior or [])
