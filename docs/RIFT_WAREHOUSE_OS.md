# Rift Warehouse OS — isolated reconstructed pilot

Routes: `/warehouse` (new workspace), `/os` (workspace switcher), `/api/warehouse` (authenticated operations).

This is an additive implementation in `defy-tcg/web-app`, not a recovery of the original ChatGPT Sites app. The original Sites source, database, uploaded scans, inventory, prior approvals and learning were unavailable and have NOT been migrated. Existing Defy Store OS routes, inventory, pricing and Shopify services must remain intact.

## Setup

Use existing authorized Neon Auth accounts. The workspace uses only the `rift_warehouse` Postgres schema. `WAREHOUSE_DATABASE_URL` is optional and can point to a dedicated database; otherwise `DATABASE_URL` is used with separate schema-qualified tables. Never commit connection strings. The existing role needs permission to create this new schema and its tables. First authenticated workspace read performs idempotent schema creation, not any migration of store tables. Existing auth middleware and account allowlist protect all new routes. No extra account has been granted access.

Import the supplied compact `Riftbound_Sorting_Catalog(1).csv` in Mastersheet. The source snapshot has 2,896 records; the application displays the count it actually imports. Master IDs, collector-number strings, finishes, languages, physical/reference flags, mapping status and provided image provenance are retained. Omitted fields in a compact source are not fabricated. Importing catalog definitions creates no stock. Catalogs are immutable by SHA-256 and each batch pins its version. Old catalog rows and existing inventory references are retained.

Register a physical box, then create a batch with explicit foil/non-foil, language and default condition. Upload individual FRONT images only in physical order. Natural filename ordering and reversal are supported. Duplex back pairing and Epson USB control are not implemented. Original files stay with the operator; normalized JPEG previews up to 1,600 px are saved in private database storage.

Prepare references for the selected finish/language; unavailable or non-exact source images stay out of the base-image index. New grid-based visual signatures are ADVISORY and uncalibrated. This implementation does NOT reproduce the original matcher or apply its >0.75 auto-approval threshold. Manual selection/approval adds a labeled image example; corrections replace it, withdrawals/exclusions remove it. Automatically generated suggestions do not train themselves.

Approve or exclude every scan, then finalize. Each physical copy gets an `RW-...` permanent serial separate from the supplied commerce SKU, plus box/column/row/position. Capacity failure creates no partial inventory. Physically place the cards and confirm putaway before they become available. Labels should go on sleeves, not cards; the placement table prints, but sleeve/barcode label generation is not included in this pilot.

Create manual single-variant orders in the UI, reserve exact copies, confirm assigned serials, and ship only when all are picked. The domain supports atomic multiple-line requests but the current UI exposes one variant per order. No Shopify order integration is active. Cancellation releases reservations; already-picked copies require putaway again. Returns retain serials and go through quarantine/condition recheck. Moving stock never changes serials.

## Consistency and limits

Warehouse writes use a revision-checked compare-and-swap against an isolated state row. A stale device gets a conflict and must refresh rather than overwriting newer work. Scan metadata and image bytes are committed in one SQL statement. The state payload is capped at 3 MB for this supervised pilot; expand paginated/normalized storage before large daily production use. Do not reset data to evade this guard. A downloaded workflow JSON is NOT a full backup: it omits catalog bodies, image bytes and reference cache. Back up the schema and image rows together before future migration.

## Development and release

Run `npm test` and preserve locked dependencies. Use a development database for interactive tests; never load the signed-in original Store OS while testing against production because it may run inventory-sheet sync. Validate recognition on a separate labeled holdout set before enabling any automatic decision policy. No claim of recognition accuracy is made for grid suggestions.

The new files are scoped to `app/warehouse`, `app/os`, `app/api/warehouse`, `lib/warehouse` and warehouse tests/docs. Any navigation edit should only add a workspace link. Roll back code independently of unrelated subsequent stock operations; do not replace the store operational database with a catalog SQLite file.
