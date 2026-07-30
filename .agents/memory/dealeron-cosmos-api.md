---
name: DealerOn Cosmos SRP API
description: Real DealerOn inventory REST API discovered via SRP JS bundle analysis — replaces the broken /apis/widget/ approach
---

# DealerOn Cosmos SRP API

## The rule
DealerOn's modern Vue-based SRP does NOT use `/apis/widget/INVENTORY_LISTING_DEFAULT_AUTO_USED/getInventory` (that path returns 404 on all tested live sites). The real API is:

```
GET /api/{dealerCode}/vehicle-pages/cosmos/srp/vehicles/{dealerId}/{pageId}
    ?baseFilter={base64(filter)}&pageSize=12&pageNumber={n}
```

**Why:** Discovered by fetching the SRP page's JS bundle (`searchResultsPageWasabiBundle.min.js`) and grepping for `cosmos/srp/vehicles`. The SRP embeds a `<script id='dlron-srp-model' type="application/json">` tag with all three config values.

## How to apply
Config extraction is in `_fetch_dealeron_srp_config(url)`:
- `dealerCode` — from script src pattern `/resources/{code}/pages/` in the HTML
- `DealerId` — from `dlron-srp-model` JSON `.DealerId`
- `PageId` — from `dlron-srp-model` JSON `.PageId` (differs between Used and New SRP pages)
- `BaseFilter` — from `.BaseFilter` (e.g. `"type='u'"` for used); must be `btoa()` encoded

Page size is server-capped at 12 regardless of `pageSize` param. Use `ThreadPoolExecutor(max_workers=10)` to fetch all pages in parallel — 1,362 vehicles fetches in ~1.4s.

## University Ford (live-validated)
- URL: `https://www.universityford.net/SearchUsed.aspx`
- `dealerCode=vhcliaa`, `dealerId=15275`, `pageId=971211` (Used) / `971204` (New)
- 1,368 used / 684 new vehicles
- `VehicleInternetPrice=0` and `VehicleMsrp=0` for all — Ford Direct suppresses prices on SRP; `_enrich_from_vdp` must fill them from VDP pages

## Key field mapping (VehicleCard → our schema)
- `VehicleVin` → vin  
- `VehicleStockNumber` → stock_number  
- `VehicleYear/Make/Model/Trim` → year/make/model/trim  
- `VehicleInternetPrice` → price (0 for Ford Direct)  
- `VehicleMsrp` → msrp  
- `VehicleMileage` → mileage (integer)  
- `VehicleDetailUrl` → vdp_url (already absolute)  
- `VehicleImageModel.VehiclePhotoSrc` → image_url (relative, prefix with base_url)  
- `VehicleCondition` / `VehicleType` → condition  
- `ExteriorColorLabel` / `InteriorColorLabel` → colors

## Bug fixed
`_fetch_page` returns `(batch, paging_meta)` tuple. Phase-2 parallel collection must unpack it: `page_batch, _ = fut.result(); all_vehicles.extend(page_batch)`. Extending with the raw tuple injects the paging dict into the vehicle list → `KeyError: 'vin'` on DB insert.
