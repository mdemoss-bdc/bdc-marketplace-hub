---
name: Dealer.com DDC inventory extraction
description: How to reliably pull inventory from CDK/Dealer.com (DDC v9) sites without a headless browser
---

## The rule
Do NOT call the `/apis/widget/.../getInventory` XHR endpoint directly — it returns `totalCount: 0` from a cold request because it requires a JavaScript-initialized session. Instead, parse the `DDC.WS.state` blob that is server-rendered into every SRP page.

## The data path
```
DDC.WS.state['ws-inv-data']['inventory-data-bus*'].WIS.inventory
```
Array of full vehicle objects. Key field map:
- `vin` → vin
- `stockNumber` → stock_number
- `title[0]` → year (first 4-digit number, e.g. `"2026 Chevrolet"`)
- `make`, `model`, `trim` → direct
- `type` → `"new"` or `"used"` (condition)
- `pricing.dprice[isFinalPrice=true].value` → internet price (strip `$,`)
- `pricing.retailPrice` → MSRP fallback
- `images[0].uri` → image URL (from `pictures.dealer.com`)
- `attributes[]` → scan for `exterior`/`interior` names for colors
- `mileage` / `odometer` → usually 0/null for new vehicles

## Detection
HTML contains `providerID=DDC` meta tag and references to `static.dealer.com` / `pictures.dealer.com`.  
Signature patterns already in `_PLATFORM_SIGS['dealerdotcom']`.

## Function
`_extract_ddc_inventory(html, condition)` — parses the blob directly, returns list of normalized vehicle dicts. Called as Step 0 in `_parse_dealerdotcom` before any API attempts.

**Why:** The CDK data-bus API endpoints (`/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_NEW:inventory-data-bus1/getInventory`) always return `totalCount: 0` without a cookie/session from a prior page-load XHR sequence. Server-side rendering is present for SEO and is always reliable.

**How to apply:** Any time a Dealer.com SRP URL returns 0 vehicles via the API path, the DDC.WS.state blob is the authoritative source. The `ws-inv-data` widget may use any instance name ending in `inventory-data-bus*`.
