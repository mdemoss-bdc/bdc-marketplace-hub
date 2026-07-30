---
name: Playwright browser launch — portable fallback chain
description: How the scraper resolves a Chromium binary across Windows, macOS, standard Linux, and NixOS-style hosts.
---

# Playwright browser launch — portable fallback chain

## The rule
Never assume a single Chromium location. `_launch_chromium()` in
`artifacts/api-server/playwright_scraper.py` tries, in order:

1. `PLAYWRIGHT_CHROMIUM_PATH` when set (explicit override for unusual hosts)
2. Playwright's own bundled browser (`pw.chromium.launch()`) — the normal path
   after `python -m playwright install chromium`
3. The `chrome` / `msedge` channels (uses a locally installed browser)
4. A system binary discovered via `shutil.which('chromium-browser')` or
   `shutil.which('chromium')`

**Why step 4 matters:** on NixOS-style images, Playwright's downloaded
`chromium_headless_shell` links against `/usr/lib/x86_64-linux-gnu/libnspr4.so`
and friends, which do not exist there. The system `chromium` wrapper resolves its
own library paths via patchelf/rpath and works. On Windows and macOS the bundled
browser or an installed Chrome/Edge channel is used instead.

Always launch with `args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']`
so the scraper works inside containers.

## playwright_scraper.py
The full Playwright scraper lives at `artifacts/api-server/playwright_scraper.py`.
It is imported by `_fetch_dealer_page_js` in `bdc_engine.py` as the JS fallback
path. Key behaviors:
- Network response interception (`page.on('response')`) captures raw JSON inventory payloads from background XHRs
- Evaluates 15+ common window state blobs (window.__NEXT_DATA__, window.inventoryData, etc.)
- Follows Next-button pagination (CSS selectors + JS text-content match) up to 30 pages
- Handles infinite scroll by watching scrollHeight growth
- VIN-deduplicated output; 85 s wall-clock budget per URL
- All console output is ASCII-safe so Windows code pages do not raise `UnicodeEncodeError`

## Setup
```bash
pip install -r requirements.txt
python -m playwright install chromium
```

On a bare Debian/Ubuntu container also run `python -m playwright install-deps chromium`
to pull the shared libraries (nspr, nss, alsa-lib, atk, at-spi2-atk, cups, dbus,
expat, fontconfig, freetype, glib, gtk3, libdrm, mesa, pango, cairo, libxkbcommon,
and the libX11/libxcb family).
