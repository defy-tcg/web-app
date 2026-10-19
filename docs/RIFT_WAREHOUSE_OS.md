# Rift Warehouse OS — isolated pilot in the existing web-app

## Scope and provenance

This is a rebuilt warehouse pilot, not a recovered or migrated copy of the original ChatGPT Sites application. The user's latest instruction authorizes placing a distinct OS in the current GitHub-connected web-app. The original Sites source, inventory, scan images and learning are not present. Do not claim they have been migrated.

Routes: `/os` selects the existing Store OS or `/warehouse`. The warehouse APIs are `/api/warehouse` and `/api/warehouse/reference`. All use the existing authenticated, authorized Defy session; the existing middleware already protects these routes. No new public inventory endpoint or authorization bypass is introduced.

## Isolation and deployment

Project: existing `defy3/defy-store-os`; repository: `defy-tcg/web-app`.
Only `rift_warehouse.*` tables are used. No imports of Defy products, sales, movements or Shopify write services exist. `WAREHOUSE_DATABASE_URL`, when configured, overrides the existing `DATABASE_URL` for this module alone. Otherwise it creates its own schema in the same Postgres database, on first authorized access. Never run the existing Drizzle baseline against production to install this module.

Keep the current code commit as the rollback point. The addition is backward-compatible and does not alter existing store tables. Code rollback must not reset warehouse records or unrelated subsequent transactions.

## First use

1. Sign in using an already authorized Defy account. The existing sign-in flow returns to Store OS; reopen `/os` or `/warehouse` afterward.
2. Open Mastersheet and import the user-provided `Riftbound_Sorting_Catalog(1).csv` (the compact CSV, not the SQLite database or ZIP). The file is deliberately not publicly committed with this code. It has 2,896 source reference rows, including 2,417 source-labeled released inventory-eligible printings. Import is one-time, cloud saved; it creates no stock.
3. Register real boxes with columns, rows and fixed positions.
4. Sort cards physically into foil/non-foil and create a batch with an explicit finish, language and condition.
5. Upload cropped FRONT images only. Keep original Epson files. This release normalizes scan previews to JPEG at <=1,600px and does not pair duplex backs or drive the USB scanner.
6. Prepare reference signatures for the selected finish/language. The job is resumable. Images that cannot be fetched remain missing; no substitute image is silently invented.
7. Suggest matches, choose the exact printing and approve. Approved cards leave the review queue before finalization. Human corrections replace their earlier learning label; exclusions and withdrawals remove it.
8. Finalize only after all remaining scans are approved/excluded. Finalization atomically assigns unique RW serials and addresses, initially awaiting putaway.
9. Confirm physical putaway, then create manual pick orders. Only available exact variants are reserved. Pick by serial, ship after every copy is confirmed, or cancel with picked-copy re-putaway.

## Identifiers and data quality

`master_id` is the persistent reference key, never TCGplayer product ID alone. Product SKU is separate from permanent warehouse serial `RW-00000001` and from mutable box/column/row/position. The legacy WH namespace is not reused. Collector-number leading zeroes and suffixes, promo/event, language and image flags remain text. Old catalog versions are immutable and existing batches are pinned; catalog replacement does not rewrite existing units.

The CSV parser retains every supplied column. The compact source omits some extended fields (such as size/finish detail); they are not invented. Import a validated expanded CSV with the same required headers to retain additional columns. Release eligibility is derived from source flags, not a fresh market verification. Unknown finish, future/unconfirmed and reference-only rows are not selectable inventory units.

## Recognition is NOT the old calibrated matcher

The original source and benchmark assets were unavailable. This pilot's `rw-advisory-grid-v1` algorithm compares normalized coarse RGB signatures, supplemented with manually confirmed images. It is an advisory shortlist, not a claim of exact-printing accuracy, foil detection, condition grading, or authenticity. Every scan requires human approval. `AUTO_APPROVAL_CALIBRATED=false` deliberately prevents applying the legacy >0.75 threshold to a new score scale. No A/B/C comparison against the original live application has been performed. Calibrate on independent labeled Epson scans and implement finer verification before enabling automatic decisions.

## Storage and concurrency limits

A revision-checked document stores pilot workflow state. Images and immutable catalogs/reference signatures are separate database tables. State updates use compare-and-swap; an image insert and the corresponding workflow mutation share one SQL statement. Concurrent stale-device writes are rejected rather than overwriting newer work. Operation IDs prevent replayed commits; no unsafe automatic write retries occur.

The workflow document has a 3 MB safety limit and each intake batch has a 500-scan cap. This is a supervised pilot, not an unbounded high-volume warehouse design. Before large-scale use, migrate state entities into indexed normalized tables with pagination, quotas and monitoring without changing serial identity or losing history. Scan images in Postgres should migrate to private object storage with authorized reads and documented backup retention.

## Testing and maintenance

Run `npm ci`, `npm run test:focused`, `npm run lint`, `npm run build`. Use a development Neon branch or an isolated PostgreSQL test database for interactive tests. Do not load the signed-in Store OS root page against production during tests because its existing sync behavior can write inventory. Never add development-auth bypasses to committed routes.

A workflow JSON export is NOT a complete backup: database backup must also include catalog versions, reference cache and image bytes. Keep Epson originals separately. Current role separation follows existing authorized Defy access (all authorized users can operate the pilot). No new collaborator email or public sharing permission is granted by this change.
