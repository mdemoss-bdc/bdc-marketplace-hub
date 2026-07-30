---
name: Moses Auto Group sitemap crawl
description: How to reliably crawl mosescars.com inventory — sitemap-only approach, VDP enrichment, location resolution
---

## The rule

Use `sitemap.xml` as the exclusive discovery source. DealerOn's SRP (`searchnew.aspx`, `searchall.aspx`) never paginates — it always returns the same 12 VINs regardless of `?page=`, `?start=`, `?rows=`, or `?pt=` parameters.

**Why:** Every prior attempt to paginate the SRP failed. The sitemap contains 2,379 URLs (as of July 2026: 1,392 New + 987 Used) and returns a clean VDP URL per vehicle in ~3–4 seconds.

## Sitemap URL format

`/condition-Location-Year-Make-Model+Trim-VIN`

e.g. `/new-St+Albans-2026-Nissan-Rogue-Dark+Armor-5N1BT3BB7TC835320`

**Key fact:** ALL sitemap URLs use "St+Albans" in the location slot, regardless of the actual rooftop. Do NOT use this field as the location.

## Location resolution

DealerOn VDP pages do NOT expose rooftop location in data attributes or JSON-LD. The `data-location`, `data-dealer-name`, `data-rooftop-name` patterns return nothing useful on mosescars.com.

**Solution for NEW vehicles:** Use `MAKE_TO_LOCATION_NEW` franchise mapping (Honda/VW → Huntington/Barboursville; GMC/Cadillac → Charleston; BMW/Ford/Lincoln/Nissan/Lexus/Toyota → St. Albans).

**For USED vehicles:** Default to "St. Albans" (any brand can appear at any rooftop on CPO/pre-owned lots).

## Image URL formula

`https://www.mosescars.com/inventoryphotos/23991/{vin.lower()}/ip/1.jpg`

Dealer ID is `23991`. No VDP fetch required for images.

## Two-phase sync architecture

- **Phase 1** (~4s): fetch sitemap → `_fetch_moses_sitemap_vehicles()` → upsert all VINs with partial data
- **Phase 2** (~3–5 min): 20-thread pool → `_enrich_from_vdp(vdp_url)` for price/stock/color

Price coverage ~85% after enrichment. VDP pages expose `data-price`, stock number, exterior/interior color via data attributes.

## Make breakdown (July 2026)

Toyota 725, Chevrolet 252, Ford 250, Nissan 202, GMC 141, Lexus 120, VW 107, Honda 98, BMW 85.

## How to apply

When updating the sync logic, always start from `_sync_full_crawl()` in `bdc_engine.py`. The progress endpoint is `GET /api/v1/marketplace/sync-status`. The sync is non-blocking — POST returns immediately, frontend polls.
