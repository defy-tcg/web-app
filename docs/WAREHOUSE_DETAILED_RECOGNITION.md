# Accuracy-first detailed recognition

## Active implementation

Warehouse-only feature matcher: `rw-akaze-ransac-630-v1`. It runs on the server using pinned OpenCV.js 4.12.0 (AKAZE / MLDB) and sharp 0.34.5. Its isolated runtime package and lock are installed by the root postinstall hook; the original application dependency lock and package versions are unchanged. After an install using `--ignore-scripts`, run `npm run postinstall` before testing or building. Deployment tracing explicitly includes the runtime and native image decoder.

Input processing decodes with pixel and byte limits, honors orientation, detects a large card-shaped quadrilateral, corrects perspective, and normalizes to 630 by 880 grayscale. A full-frame fallback is marked and aspect checked. CLAHE improves feature extraction. Up to 1,800 distinctive AKAZE keypoints and their binary descriptors are retained. The full normalized grayscale image remains available for regional comparison; no OCR, authenticity grading, or foil detection is claimed.

Retrieval uses a 32 by 44 normalized grayscale probe with artwork and full-card regions, considering 180-degree rotation. The best 96 image references, related same-name printings, and legacy finalists are verified. Verification requires mutual nearest-neighbor Hamming matches with a 0.72 ratio test, RANSAC homography, valid transformed corners, spatially distributed inliers, artwork inliers, and aligned pixel agreement in artwork, name-band and footer regions. This is not an exhaustive comparison to every catalog record, and layout-specific heuristics are not a substitute for benchmark calibration.

## Approval policy and uncertainty

Detailed evidence ranks suggestions. Automatic approval requires BOTH the existing unrounded legacy similarity score >=0.90 and independent geometric/regional checks. The new detailed score is not passed into the old 90% gate, is not a probability, and has no claimed measured accuracy rate. Insufficient scan/reference quality, incomplete indexing, unavailable assets, runtime failures, near-tied detailed candidates, conflicting engines, shared-image printing aliases and uncovered related printings are held for review. Existing duplicate-file, manual-withdrawal, finish/language and release-eligibility safeguards remain in place. Cards recognized after a rotation can still need manual approval if the legacy gate disagrees.

Historical approvals and their saved scores are not recalculated. Rechecking a review scan explicitly applies the new verification; finalized batches are not reprocessed. Diagnostic evidence is saved with each new/rechecked scan. Heavy feature payloads never enter the workflow JSON.

## Durable references and learning

An additive `rift_warehouse.vision_assets` table stores compressed, algorithm-versioned features and source metadata. Existing grid references, catalog versions, stock, batches, orders, locations, serials and approved work remain intact. Assets are addressed by algorithm plus reference URL/front-asset/provenance, or immutable scan image ID. A caller-supplied original-file hash is not used as a trusted detailed-feature cache identity.

The first visit prepares missing detailed assets in small idempotent server requests driven by the open page. Progress is shared across devices and resumes after closing/reopening. There is no ongoing job after every browser is closed. Only source-marked exact eligible images are indexed. Failures are explicit manual-review exceptions; retry controls live in Mastersheet. Unchanged source images are reused during future catalog updates. New catalog activation requires both index versions to finish preparation.

Manual confirmations use the original saved image to create detailed examples. Only labels currently present in the human learning ledger participate. Corrections replace the label; withdrawn/excluded examples stop being used, even when the unlabeled image feature remains cached. Compatible examples can be reused across catalog versions only after master ID, name, set, collector number, finish, language, printing, promo/stamp and physical key checks. No automatic approval trains itself. Duplicate image files still require physical-copy acknowledgment.

## Integrity and rollback

All inventory mutations remain revision-checked and atomic. Server verification is passed internally to the reducer, never accepted from client command fields. If computation fails, the receipt remains in review instead of silently falling back to legacy-only approval. No Shopify or Store OS inventory writes are added. Authentication is unchanged.

A readable pre-release database backup was verified before work. The code baseline is retained in Git history. Revert code to restore the earlier matcher without overwriting later inventory transactions. Old catalog/index assets are intentionally retained. Do not restore an old operational state snapshot over subsequent receiving, picking or sales.

## Validation and limits

`npm test` includes real feature extraction/matching tests for retained detail, same-color wrong artwork, rotation, brightness, borders, blank/malformed images, boundary checks, ambiguity, quality holds, cross-version label compatibility, trusted server decisions, and the unchanged 90% gate. Separate embedded-Postgres and browser harnesses exercise the actual server engine with fixture images and unchanged receiving/putaway/fulfillment behavior.

A development comparison used the SAME three public reference images and 18 synthetic variants (original, upside-down, brightness, skew, border and blur), with learning disabled. Browser-exact legacy top-1 was correct in 17/18 cases; detailed top-1 was correct in 18/18. These are small, correlated reference transformations, not fresh Epson captures, not a full-catalog A/B/C benchmark, and not an accuracy guarantee. Thresholds are engineering safeguards, not statistically calibrated confidence. A larger independently labeled Epson holdout is still required to measure wrong automatic approvals, review rate, missing-reference failures and real latency.

Primary method reference: https://docs.opencv.org/4.12.0/db/d70/tutorial_akaze_matching.html
