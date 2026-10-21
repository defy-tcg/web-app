# Mac scanning companion 0.1.0 — supervised pilot

This release adds a native OpenCV receiving companion without moving the authoritative inventory out of the cloud. Source lives in `companion/`. A source installer creates a user-local launcher; it is not a signed/notarized standalone binary. macOS installation, Keychain and actual Epson capture must be accepted on a Mac. No speedup is claimed without a hardware benchmark.

## Architecture

Native Python/OpenCV 4.12 AKAZE uses a distinct index version. Scans are normalized to 630x880, retain up to 1,800 keypoints, and are verified with mutual Hamming matches, RANSAC and artwork/name/footer-region comparisons. It compares all cached finish/language-eligible references rather than the cloud's shortlist. Local reference features are disk-backed with a bounded in-memory cache; one worker and two OpenCV threads limit resource pressure. No GPU or Neural Engine execution is claimed.

A loopback-only UI opens in the default browser. The local process watches only a user-selected folder, waits for stable files, preserves natural filename order, and never modifies Epson originals. SQLite stores offline drafts and local labels. Exact duplicate files in one local batch are skipped; different physical copies should be captured separately. No local row is available warehouse stock.

## Conservative cloud boundary

The local ready queue is a strong suggestion, not an approval. On explicit Sync, unconfirmed scans run through the current cloud detailed matcher and existing >=0.90 gate. Manual decisions require an explicit exact-printing selection and duplicate acknowledgment. Native scores and evidence are never trusted as cloud automatic approvals. This first version still spends cloud compute on unconfirmed syncs; it is not a complete native-only fulfillment path.

The local browser computes the original 8x8 signature using the same canvas processing as the website; native scores are never substituted for it. Finalization, warehouse serials, putaway, reservations, shipment and Shopify remain in the existing website. Missing or conflicting evidence stays in review.

## Auth and synchronization

Authenticated `/warehouse/scanner` controls per-device 30-day keys. Only SHA-256 key hashes are stored in additive `rift_warehouse.scanner_devices`. Device administration uses existing authorized sessions, owner checks and same-origin writes. The exact `/api/warehouse-companion` endpoint uses mandatory scoped bearer authentication, no CORS and current authorized-email checks. No other warehouse path is exempted from cookie middleware. Mac credentials use Keychain with no plaintext fallback.

A token may read catalog/exact references/active human examples and create or synchronize receiving batches. It cannot finalize inventory, move stock, ship orders, mutate catalog definitions, manage credentials, or delete data. Renewal keeps the device ID; revocation blocks further API access. Revocation cannot erase locally cached data.

Batch and scan IDs are deterministic from the device identity and persistent local UUIDs. Import replays return existing cloud records even after the rolling operation ledger expires. Original hash, batch binding and catalog are verified. Conflict retries use revision-checked writes. Human-confirmed upload and approval are one state/image transaction. Unconfirmed imports use the existing executeWarehouse path. Existing human/cloud decisions are never overwritten on replay.

## Preservation and rollback

No operational reset, automatic finalize, serial remapping or catalog replacement is performed. The existing schema/index stays in place. `saveScannerState` is an internal trusted adapter export, not a public full-state write API. A pre-release readable backup is taken and verified. Reverting source leaves existing receiving data intact; never restore an old state snapshot over later sales/receipts.

The change to Next tracing includes the existing image runtime in the new API route; Store OS dependency versions are unchanged. Source installer download includes code/docs/tests only—no real scans, catalog, database, device token, test credentials or trained labels.

## Validation

See `companion/VALIDATION.md` for actual local/platform test results. Separate SQL and browser harnesses should exercise token scope/expiry/renewal/revocation, duplicate-safe import, lost acknowledgments, device-bound IDs, explicit manual approval and stock preservation. A real signed-in Mac trial remains necessary. Thresholds remain uncalibrated engineering safeguards, and exact Epson accuracy must be measured on fresh, independently labeled captures.
