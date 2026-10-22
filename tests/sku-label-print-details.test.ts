import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_SKU_INVENTORY_DRAFT, skuLabelPrintDetails } from "../lib/sku-label-draft.ts";

test("old saved batches receive the current saved set and condition for every print output", () => {
  const oldBatch = { sku: "DEFY-5415615027", name: "Typhlosion" };
  const hydrated = skuLabelPrintDetails(oldBatch, { setName: "Neo Premium File 1", condition: "Near Mint" });
  assert.deepEqual(hydrated, { ...oldBatch, setName: "Neo Premium File 1", condition: "Near Mint" });
  assert.deepEqual(oldBatch, { sku: "DEFY-5415615027", name: "Typhlosion" });
});

test("manual drafts print their edited inventory set until the shared saved card is available", () => {
  const label = { sku: "DEFY-1234567890", name: "Card", setName: "Old set", condition: "Near Mint",
    inventory: { ...EMPTY_SKU_INVENTORY_DRAFT, setName: "Corrected set", condition: "Lightly Played" } };
  const draft = skuLabelPrintDetails(label);
  assert.equal(draft.setName, "Corrected set");
  assert.equal(draft.condition, "Lightly Played");
  const saved = skuLabelPrintDetails(label, { setName: "Shared catalog set", condition: "Moderately Played" });
  assert.equal(saved.setName, "Shared catalog set");
  assert.equal(saved.condition, "Moderately Played");
  assert.equal(saved.sku, label.sku);
});

test("an empty saved set clears stale browser metadata without changing the permanent identity", () => {
  const label = { sku: "DEFY-1234567890", name: "Card", setName: "Stale set", condition: "Lightly Played" };
  assert.deepEqual(skuLabelPrintDetails(label, { setName: "", condition: "Near Mint" }),
    { ...label, setName: "", condition: "Near Mint" });
  assert.equal(skuLabelPrintDetails(label).setName, "Stale set");
});
