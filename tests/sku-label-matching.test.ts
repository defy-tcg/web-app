import assert from "node:assert/strict";
import test from "node:test";
import { compareSavedSkuLabels, isSavedSkuLabelMatch, sameSkuLabelCard, sameSkuLabelVariant, savedSkuLabelVariants, type SavedSkuLabelMatch } from "../lib/sku-label-matching.ts";

const card: SavedSkuLabelMatch = {
  id: 10, sku: "DEFY-1234567890", productType: "Single", name: "Time Warp", game: "Riftbound", setName: "Origins",
  cardNumber: "122/298", condition: "Near Mint", finish: "Foil", tcgplayerId: 652905, createdAt: "2026-09-01T00:00:00Z",
};

test("positive catalog ID matches an original card despite changed game and metadata", () => {
  const old = { ...card, name: "Old Time Warp", game: "Other", setName: "Old set", cardNumber: "122" };
  assert.equal(sameSkuLabelCard(old, card), true);
  assert.equal(sameSkuLabelVariant(old, card), true);
  assert.equal(sameSkuLabelVariant({ ...old, condition: "Lightly Played" }, card), false);
  assert.equal(sameSkuLabelVariant({ ...old, finish: "Textured Foil" }, card), false);
});

test("contradictory positive catalog IDs never match identical displayed metadata", () => {
  assert.equal(sameSkuLabelCard({ ...card, tcgplayerId: 652906 }, card), false);
  assert.equal(sameSkuLabelVariant({ ...card, tcgplayerId: 652906 }, card), false);
});

test("an old unlinked identity matches exact metadata with normalized condition and finish", () => {
  assert.equal(sameSkuLabelVariant({ ...card, tcgplayerId: null, condition: " NEAR MINT ", finish: "Holofoil" }, card), true);
  assert.equal(sameSkuLabelVariant({ ...card, tcgplayerId: null, game: "Other" }, card), false);
  assert.equal(sameSkuLabelVariant({ ...card, tcgplayerId: null, name: "Different Time Warp" }, card), false);
});

test("saved variants retain the earliest original SKU per condition and finish, including legacy SKUs", () => {
  const later = { ...card, id: 1, sku: "DEFY-1234567891", createdAt: "2026-09-02T00:00:00Z" };
  const legacy = { ...card, id: 11, sku: "LEGACY-TIME-WARP", condition: "Lightly Played" };
  const foilAlias = { ...card, id: 12, finish: "Holofoil", sku: "DEFY-1234567892" };
  const variants = savedSkuLabelVariants([later, legacy, foilAlias, { ...card, productType: "Sealed" }, { ...card, tcgplayerId: 652906 }, card], card);
  assert.deepEqual(variants.map((product) => product.sku), [card.sku, legacy.sku]);
  assert.ok(compareSavedSkuLabels(card, later) < 0);
  assert.ok(compareSavedSkuLabels({ id: 1 }, { id: 2 }) < 0);
});

test("fresh inventory rows must expose a valid matching identity before allowing generation", () => {
  assert.equal(isSavedSkuLabelMatch(card), true);
  assert.equal(isSavedSkuLabelMatch({ ...card, tcgplayerId: null }), true);
  for (const value of [null, {}, { ...card, id: 0 }, { ...card, tcgplayerId: 0 }, { ...card, condition: null }]) assert.equal(isSavedSkuLabelMatch(value), false);
});
