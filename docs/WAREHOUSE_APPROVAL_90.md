# Warehouse auto-approval: 90% or above

This release supersedes the 0.78 cutoff in receiving-v3. New uploads and explicit rechecks of the review queue use the unrounded visual match score >= 0.90. Exactly 0.90 is included; lower scores stay in Needs review. The score is similarity, not a calibrated accuracy percentage.

The duplicate, tied-printing, blank-image, finish/language and withdrawn-approval safeguards remain unchanged. Manual confirmations still teach future comparisons; automatic approvals never train themselves.

Existing approvals, their recorded scores and original cutoffs, inventory, catalog, learning records and putaway status are not retroactively changed. Historical approval details display the saved cutoff rather than the current cutoff. Batch naming and batch putaway are unchanged. No database migration or operational data rewrite is needed.

Tests cover scores immediately below 0.90, exactly 0.90, immediately above 0.90, prior-approval preservation and learning followed by automatic approval.
