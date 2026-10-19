# Persistent Mastersheet and automatic upload matching

## Scope

Warehouse-only update to the existing Vercel workspace. No Store OS stock, Shopify code, authentication, warehouse serials, scans, batches, boxes or learned labels are reset. Catalog definitions are not inventory.

The already-imported expanded Sorting Catalog is the active data source. Its 2,896 rows match the supplied CSV after browser UTF-8 BOM normalization: SHA-256 `f68099e02ce1fb49d403abb24c7a8a0b3f346fef29e59c51450019d9de8888b8`. This release does not embed private catalog files or scan images in the public source repository and does not silently substitute public web data. A later reviewed catalog may legitimately become active.

## Daily workflow

Open Card intake, select/create a finish-specific batch, upload fronts, review suggested printings, finalize and confirm putaway. A Mastersheet CSV upload is no longer offered in intake. Language and condition defaults come from the latest saved batch; finish remains an explicit choice. Upload and candidate generation persist in one revision-checked operation. Finalization and learning retain the existing behavior.

All reference signatures live in shared warehouse tables. Switching batches, refreshing, or using another device does not repeat completed image downloads. Each browser loads index status, not every original reference image. Server-side pools are restricted to the batch finish/language and briefly cached; human examples are taken from the latest workflow state.

## Initial preparation and rare catalog updates

The previously active catalog may have only a partially prepared image index. On first opening this release, missing source images are prepared automatically in bounded groups while the page remains open. Each result is saved centrally. Returning resumes only incomplete work. Upload is disabled until preparation is complete, so partial candidate coverage is not presented as ready.

In Mastersheet, Update Mastersheet stages an immutable version. The application automatically reuses signatures for unchanged exact source keys and prepares new images. The active catalog remains unchanged until preparation finishes. Activation is a revision-checked change to the active pointer; old batches pin their previous catalog and all previous definitions remain available.

Failed/missing/non-exact source images are explicit manual-review exceptions, not guessed signatures. Retry unavailable source images is a catalog-maintenance control, not a daily receiving step. At least one usable reference is required for activation. This release does not claim every catalogue definition has a usable exact image.

The automatic preparation worker runs in the open browser and saves to the server. It is not an always-on background service; it does not continue downloading after every browser is closed.

## Recognition and cache identity

The existing `rw-advisory-grid-v1` preprocessing and L1 similarity score are retained. Reference and incoming scan processing share the same browser function. The source key includes the algorithm, provided image URL, front-asset identifier and image-match provenance. Marketplace product IDs never replace printing/finish IDs.

The candidate lookup uses a prefiltered Map rather than repeated full-catalog searches. The original >0.75 automatic-approval rule remains disabled: this work improves setup and routing, not calibration. Human confirmation saves examples; automatic suggestions do not train themselves.

## Storage and rollback

Additive tables only: `rift_warehouse.reference_assets` and `rift_warehouse.reference_attempts`. Existing reference rows, catalog versions and workflow records remain intact. The optional `pendingCatalog` field is backward compatible with existing state records.

Take a database backup before rollout. Reverting code must not restore an old workflow snapshot over subsequent sales, receipts or picks. To roll back a catalogue, use an explicitly reviewed pointer change while retaining catalog rows and their corresponding signature index. Do not replace the operational database with the source SQLite catalogue.

## Research basis

TCGplayer Quicklist separates product-data updates from routine scanning and remembers batch settings. Scan & Identify imports images for automatic catalog matching, keeps duplicate scans separate during review, supports manual correction, and publishes stock after review. These documented workflow patterns informed the UI; no proprietary code or recognition engine was copied.

- https://help.tcgplayer.com/hc/en-us/articles/115004326088-How-to-Begin-Scanning-Cards-with-Quicklist
- https://help.tcgplayer.com/hc/en-us/articles/27303403772823-How-To-Use-Scan-Identify

Run `npm test`. The focused suite includes deterministic planning and unchanged-score regression cases. Additional isolated SQL and browser checks must distinguish fixture testing from production acceptance and actual recognition-accuracy benchmarking.
