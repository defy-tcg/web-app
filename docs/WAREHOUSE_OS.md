# Rift Warehouse OS — separate pilot in defy-tcg/web-app

## Scope and provenance

The user requested a second OS inside the connected web-app repository. `/warehouse` is a newly implemented supervised pilot, not the recovered source of the original ChatGPT Site. `/os` is the OS selector. Existing Store OS routes, products, sales, pricing, Shopify integrations, authentication settings and the original Sites deployment are not replaced. No operational data is migrated from the old Site.

## Storage and authorization

The existing Neon Auth authorized-account check protects every warehouse page and API. All SQL is schema-qualified under `rift_warehouse`. `WAREHOUSE_DATABASE_URL`, when configured by the owner, selects a separate database; otherwise the existing `DATABASE_URL` is used with new isolated tables. Do not expose either credential in source or client code. The deployment database role needs permission to create the new schema/tables. Initialization is additive and creates no stock. It does not run Drizzle migrations or change public tables.

State updates use optimistic concurrency and a revision check. Scan previews and corresponding state updates are persisted together in one SQL statement. Operation IDs suppress repeat writes. Existing batches retain their catalog version; new catalog imports never replace unit identities. This pilot keeps workflow data in one JSONB record, capped at 3 MB, separately from catalog and image tables. It must be normalized/paginated and load-tested before large-scale use. A rejected size-limit update makes no partial inventory changes.

## First run

1. Sign in with an account already authorized for Defy, then open `/warehouse`.
2. Import the supplied `Riftbound_Sorting_Catalog(1).csv` (the compact 2,896-record file, not the larger illustrated workbook or operational database). CSV fields and master IDs are preserved. No card stock is seeded. Eligibility and release flags reflect that source snapshot, not a current market verification.
3. Register physical boxes with columns, rows and fixed positions/dividers.
4. Create a batch with explicit Foil or Non-foil, language and condition.
5. Import cropped upright front images only, naturally sorted by filename; reverse order when needed. Do not upload duplex backs as extra cards. The app does not control the Epson USB driver. Input JPG/PNG/WebP images are limited to 12 MB; saved JPEG previews are at most 1,600 px, below 2 MB. Keep original Epson exports outside this preview store.
6. Prepare references for the selected finish/language. This uses source-marked exact images and persists a compact feature cache. Unavailable sources can be retried; the process runs while the page remains open.
7. Run visual suggestions and manually confirm each printing. Approved cards immediately leave Needs review and appear in Approved. Human confirmations save examples; corrections replace labels; withdrawal or exclusion removes the example.
8. Finalize only after every included scan is approved. Capacity failure is atomic. Serial IDs `RW-00000001` are permanent and separate from SKU and location.
9. Confirm actual putaway before stock becomes available. Manual orders reserve exact copies; serial confirmation is required before shipment. Picked cancellations require putaway. Returns enter quarantine and need a new location and condition review.

## Recognition limitation

The original Sites recognizer and its calibration were not recovered. `rw-advisory-grid-v1` is a lightweight visual suggestion baseline, not the RC1 geometric matcher and not a calibrated identification model. The old `>0.75` approval threshold is recorded but **automatic approval is disabled** for this new score scale. Do not describe these scores as probability or accuracy. Finish/language and inventory eligibility are filtered before comparison. Do not enable auto-approval without independently labeled exact-printing validation, ambiguity safeguards and a frozen held-out evaluation.

The supplied RC1 component needs its own preview assets and a server adaptation before use; simply importing its score into the existing cutoff is unsafe. No original recognition accuracy or performance figures are claimed for this new app.

## Tests and operations

Run `npm test` under the repository's locked Node/dependency configuration. Warehouse model tests are included in the existing focused test glob. Verify database initialization and concurrency on a development database before deployment. Never bypass authentication on production for a test. Keep test fixtures out of the live inventory.

The UI workflow export does not include catalog bodies, reference cache or image bytes and is not a full backup. A complete backup requires all `rift_warehouse` tables. Keep code rollback independent of later operational changes. To disable this pilot, revert only its routes and additions; do not drop schema/data or roll back unrelated inventory. No reset/delete endpoint is included.

## Not implemented

Original Site data migration; direct USB scanner control; duplex/front-back pairing; calibrated auto-approval; high-quality production recognition; Shopify order ingestion/fulfillment writes; barcode label generation; large-scale paginated storage; per-operator roles beyond the existing Defy allowlist. These limits are visible in the UI. Use small supervised batches, not unattended fulfillment.
