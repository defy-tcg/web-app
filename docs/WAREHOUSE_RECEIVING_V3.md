# Warehouse receiving v3 — current behavior

This release supersedes the disabled automatic-approval notes in earlier pilot documentation. The owner explicitly requested a strict visual match score above 0.78, batch putaway with photos, and editable automatic batch names. No different image model, calibrated confidence, or measured Epson accuracy is claimed.

## Automatic approval and learning

Uploads are identified using the saved finish/language index and the latest human-confirmed examples. Eligible, uniquely leading matches with an unrounded score strictly greater than 0.78 move immediately to Approved, before finalization. Exactly 0.78 and below remain in Needs review. Recheck review queue applies the same policy to existing unreviewed scans. Merely loading the new release does not approve old scans.

Obvious blank/uniform images, missing matches, tied top printings, invalid finish/language/release eligibility, unacknowledged duplicate files and explicitly withdrawn approvals remain in review. A withdrawn copy requires a new human confirmation instead of being immediately auto-approved again. Existing manual approvals and finalized batches are not reprocessed.

Automatic approvals record their score, threshold, policy version and timestamp and inherit the batch condition. They never create learning labels. Manual approvals and corrections save the scan's real signature for its exact printing, finish and language. Future scans compare against these additional examples with the same similarity formula; no score is artificially incremented and improvement on every future image is not guaranteed. Correcting a manual label replaces it; withdrawal or exclusion removes that example. Automatic matches can still be corrected before finalization. The 8x8 visual signature can confuse near-identical cards; the 0.78 number is not an accuracy percentage or probability.

## Batch putaway and photos

Warehouse has a Batch putaway panel for finalized batches. The gallery shows actual stored scans, printing, finish/language/condition, warehouse serial, assigned address and current status. Photos remain available after putaway and are also shown in the individual inventory list. Photos use the authenticated scan endpoint and can be opened full-size.

Confirm entire batch putaway asks for confirmation that all shown pending copies have been physically placed. One revision-checked state write changes only that batch's awaiting_putaway copies to available. Available, reserved, picked, shipped and quarantined copies are not changed. The server validates the exact pending serial set and every assigned location before changing any copy. Stale selections or invalid locations cause no partial putaway. Single-copy confirmation remains available. Replayed requests with the same operation ID do not repeat work.

## Batch naming and working selection

Default name and permanent batch code: RW-YYYYMMDD-F-001 or RW-YYYYMMDD-NF-002. The date is America/Los_Angeles; sequence is shared across both finishes for each store day. Existing batches count toward that day's sequence. Renames never recycle a code. An optional custom name can be entered during creation. Rename batch changes only the display name, preserving the batch ID/code, scan order, serials and locations. Duplicate names and empty renamed labels are rejected.

A newly created batch immediately becomes the working batch. That selection is saved on the device. Reload selects the saved batch when valid, otherwise the latest draft (or latest batch). A different device opens its saved selection or the latest draft; it does not forcibly interrupt another operator's current batch.

## Release scope and validation

Existing catalog and reference preparation, persisted learning, authentication, SKU separation, finalization and order picking remain in place. No new database tables or Store OS/Shopify writes are required. Optional approval and batch-code fields are backward-compatible with existing JSON state.

A readable pre-release backup branch was created and its warehouse state checksum verified against production. No backup contents, operational records or private scans are committed to the source repository. Reverting code must not restore this old state over subsequent inventory operations.

Run npm test. New deterministic tests cover the strict cutoff, learning then auto-approval, ambiguity/duplicates, naming/timezone/renaming, atomic partial-batch putaway and request replay. A separate isolated browser/SQL harness exercises the displayed queues, photos, bulk confirmation/cancellation, working selection, refresh and a mobile-sized second browser. Fixture success is not production authentication or recognition-accuracy validation.
