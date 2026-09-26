import assert from "node:assert/strict";
import test from "node:test";
import { skuLabelFeedbackText } from "../lib/sku-label-feedback.ts";

const sku = "DEFY-4591494231";
const ready = { status: "ready" as const, message: "Linked to Shopify POS." };
const pending = { status: "pending" as const, message: "Shopify has not confirmed POS readiness yet; retry this same QR code." };

test("an automatic successful retry replaces the stale pending save banner", () => {
  const confirmation = { text: `${sku} is saved in Defy.`, skus: [sku] };
  assert.match(skuLabelFeedbackText(confirmation, { [sku]: pending }), /not confirmed/);
  const completed = skuLabelFeedbackText(confirmation, { [sku]: ready });
  assert.match(completed, /Linked to Shopify POS/);
  assert.doesNotMatch(completed, /not confirmed|retry/);
  assert.ok(completed.startsWith(confirmation.text));
});

test("live status can replace pending with a concrete blocker or revoke readiness", () => {
  const confirmation = { text: "QR saved.", skus: [sku] };
  assert.match(skuLabelFeedbackText(confirmation, {}), /pending/);
  assert.match(skuLabelFeedbackText(confirmation, { [sku]: { status: "blocked", message: "Review the card's exact printing." } }), /Review the card's exact printing/);
  assert.doesNotMatch(skuLabelFeedbackText(confirmation, { [sku]: pending }), /Linked to Shopify POS/);
});

test("batch and print confirmations wait for every saved QR and ignore unrelated cards", () => {
  const second = "DEFY-1234567890";
  const confirmation = { text: "2 singles saved.", skus: [sku, second] };
  assert.match(skuLabelFeedbackText(confirmation, { [sku]: ready, [second]: pending }), /1 label is not ready/);
  assert.match(skuLabelFeedbackText(confirmation, { [sku]: ready, [second]: ready, unrelated: pending }), /All labels are linked/);
});

test("later copy, download, or cleared-batch messages are not replaced by link updates", () => {
  for (const text of ["SKU copied.", "PDF ready.", "Batch cleared.", ""]) {
    assert.equal(skuLabelFeedbackText(text, { [sku]: ready }), text);
  }
});
