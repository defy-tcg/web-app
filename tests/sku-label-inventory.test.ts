import assert from "node:assert/strict";
import test from "node:test";
import { inventoryLabelVariantKey, planInventoryLabels, SkuLabelInventoryError, validateInventoryLabels, validateSkuLabelReservation,
  type InventoryLabelInput } from "../lib/sku-label-inventory.ts";

const input: InventoryLabelInput = {
  sku: "DEFY-1234567890", name: "Ahri", game: "Riftbound", setName: "Origins", cardNumber: "OGN-001",
  condition: "Near Mint", finish: "Normal", quantity: 3, costCents: 150, listPriceCents: 500,
};
const labels = (...rows: InventoryLabelInput[]) => validateInventoryLabels({ labels: rows });
const existing = (patch = {}) => ({ ...labels(input)[0], productType: "Single", barcode: null,
  quantity: 7, costCents: 200, listPriceCents: 700, priceSource: "scrydex", ...patch });
const status = (expected: 400 | 409) => (error: unknown) => error instanceof SkuLabelInventoryError && error.status === expected;

test("label inventory validation preserves exact SKUs, canonical games, Unicode names and defaults location", () => {
  const [label] = labels({ ...input, name: "  蒼き眼の白龍 🃏  " });
  assert.equal(label.name, "蒼き眼の白龍 🃏");
  assert.equal(label.location, "REDMOND");
  assert.equal(label.tcgplayerId, null);
  assert.equal(label.sku, input.sku);
  assert.equal(labels({ ...input, location: " shelf 2 ", tcgplayerId: 123 })[0].location, "SHELF 2");
  assert.equal(labels({ ...input, quantity: 0, costCents: 0, listPriceCents: 0 })[0].quantity, 0);
});

test("validation rejects invalid batch shape, required single metadata and unknown game aliases", () => {
  for (const payload of [null, {}, { labels: [] }, { labels: Array(101).fill(input) }, { labels: [null] }]) {
    assert.throws(() => validateInventoryLabels(payload), status(400));
  }
  for (const patch of [
    { sku: "bad" }, { name: " " }, { name: "A".repeat(241) }, { name: "A\u0000B" }, { game: "pokemon" },
    { game: "" }, { setName: "" }, { cardNumber: "" }, { condition: "NM" }, { finish: " " },
    { finish: "A".repeat(81) }, { finish: "Foil\u0000" },
  ]) assert.throws(() => labels({ ...input, ...patch } as InventoryLabelInput), status(400));
});

test("catalog identities preserve full names, numberless cards, and specific finish treatments", () => {
  const name = "A".repeat(240);
  const [label] = labels({ ...input, name, cardNumber: "", tcgplayerId: 123, finish: "Textured Foil" });
  assert.equal(label.name, name);
  assert.equal(label.cardNumber, "");
  assert.equal(label.finish, "Textured Foil");
  assert.equal(labels({ ...input, name: "🃏".repeat(240) })[0].name.length, 480);
  assert.equal(labels({ ...input, cardNumber: "  ", tcgplayerId: 123 })[0].cardNumber, "");
  assert.throws(() => labels({ ...input, cardNumber: "  " }), status(400));
  assert.throws(() => labels({ ...input, cardNumber: "", tcgplayerId: 0 }), status(400));
  assert.equal(labels({ ...input, finish: "A".repeat(80) })[0].finish.length, 80);
});

test("known finish aliases share an identity and save canonically without merging specific treatments", () => {
  for (const [finish, canonical] of [[" Nonfoil ", "Normal"], ["Non-Foil", "Normal"], ["Non Foil", "Normal"], ["HOLOFOIL", "Foil"], ["Reverse   Holofoil", "Reverse Holo"]]) {
    const [label] = labels({ ...input, finish });
    assert.equal(label.finish, canonical);
    assert.equal(inventoryLabelVariantKey({ ...input, finish }), inventoryLabelVariantKey({ ...input, finish: canonical }));
    assert.throws(() => labels({ ...input, finish }, { ...input, finish: canonical, sku: "DEFY-1234567891" }), status(409));
    assert.throws(() => labels({ ...input, finish, tcgplayerId: 123 }, {
      ...input, finish: canonical, tcgplayerId: 123, sku: "DEFY-1234567891", name: "Another spelling",
    }), status(409));
    const prior = existing({ finish });
    assert.equal(planInventoryLabels(labels({ ...input, finish: canonical }), [prior]).existing[0], prior);
    assert.throws(() => planInventoryLabels(labels({ ...input, finish: canonical }), [existing({ sku: "OLD-SKU", finish })]), /already exists as OLD-SKU/);
    assert.throws(() => planInventoryLabels(labels({ ...input, finish: canonical, tcgplayerId: 123 }), [existing({
      sku: "CATALOG-SKU", finish, tcgplayerId: 123, name: "Another spelling",
    })]), /already exists as CATALOG-SKU/);
  }
  for (const finish of ["Textured Foil", "Cold Foil", "Rainbow Foil", "Glossy"]) {
    assert.equal(labels({ ...input, finish })[0].finish, finish);
    assert.equal(planInventoryLabels(labels({ ...input, finish }), [existing({ sku: "FOIL-SKU", finish: "Foil" })]).create.length, 1);
  }
  assert.throws(() => labels({ ...input, finish: "Textured Foil", tcgplayerId: 123 }, {
    ...input, finish: "textured   foil", tcgplayerId: 123, sku: "DEFY-1234567891", name: "Another spelling",
  }), status(409));
});

test("validation rejects fractional, negative, unsafe, and out-of-range quantities and money", () => {
  for (const quantity of [-1, 0.5, 100001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => labels({ ...input, quantity }), status(400));
  }
  for (const value of [-1, 0.5, 100_000_001, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    assert.throws(() => labels({ ...input, costCents: value }), status(400));
    assert.throws(() => labels({ ...input, listPriceCents: value }), status(400));
  }
  for (const tcgplayerId of [0, -1, 1.5, 2_147_483_648]) assert.throws(() => labels({ ...input, tcgplayerId }), status(400));
});

test("duplicate SKUs and variants within one batch are rejected before planning writes", () => {
  assert.throws(() => labels(input, input), status(400));
  assert.throws(() => labels(input, { ...input, sku: "DEFY-1234567891", name: "AHRI", setName: " origins " }), status(409));
  assert.throws(() => labels({ ...input, tcgplayerId: 5 }, { ...input, sku: "DEFY-1234567891", tcgplayerId: 5, name: "Alternate spelling" }), status(409));
  assert.equal(labels(input, { ...input, sku: "DEFY-1234567891", finish: "Foil" }).length, 2);
  assert.throws(() => labels({ ...input, tcgplayerId: 5, game: "Other" }, {
    ...input, sku: "DEFY-1234567891", tcgplayerId: 5, game: "Riftbound", name: "Corrected catalog title", finish: "Nonfoil",
  }), status(409));
});

test("identity normalization handles case and whitespace without collapsing different Unicode cards", () => {
  assert.equal(inventoryLabelVariantKey(input), inventoryLabelVariantKey({ ...input, name: "AHRI", setName: "  Origins  " }));
  assert.notEqual(inventoryLabelVariantKey({ ...input, name: "蒼き眼" }), inventoryLabelVariantKey({ ...input, name: "真紅眼" }));
});

test("saving the same SKU and identity is a reprint and preserves existing stock and managed pricing", () => {
  const product = existing();
  const before = structuredClone(product);
  const plan = planInventoryLabels(labels({ ...input, quantity: 999, costCents: 1, listPriceCents: 1, location: "NEW" }), [product]);
  assert.deepEqual(plan.create, []);
  assert.equal(plan.existing[0], product);
  assert.deepEqual(product, before);
});

test("catalog IDs identify the same variant across corrected game classification and titles", () => {
  const prior = existing({ tcgplayerId: 12, game: "Other" });
  const imported = { ...input, tcgplayerId: 12, game: "Riftbound" as const, name: "Updated catalog title", finish: "Nonfoil" };
  assert.equal(planInventoryLabels(labels(imported), [prior]).existing[0], prior);
  assert.throws(() => planInventoryLabels(labels({ ...imported, sku: "DEFY-1234567891" }), [prior]), /already exists as/);
  assert.throws(() => planInventoryLabels(labels({ ...imported, tcgplayerId: 13 }), [prior]), status(409));
  assert.throws(() => planInventoryLabels(labels({ ...imported, condition: "Damaged" }), [prior]), status(409));
  assert.throws(() => planInventoryLabels(labels({ ...imported, finish: "Foil" }), [prior]), status(409));
});

test("SKU identity mismatches and barcodes owned by another product return actionable conflicts", () => {
  for (const patch of [{ name: "Jinx" }, { finish: "Foil" }, { condition: "Damaged" }, { productType: "Sealed" }]) {
    assert.throws(() => planInventoryLabels(labels(input), [existing(patch)]), status(409));
  }
  assert.throws(() => planInventoryLabels(labels({ ...input, tcgplayerId: 20 }), [existing({ tcgplayerId: 10 })]), status(409));
  assert.throws(() => planInventoryLabels(labels(input), [existing({ sku: "OTHER-SKU", barcode: input.sku, name: "Another card" })]), /barcode for OTHER-SKU/);
  assert.equal(planInventoryLabels(labels(input), [existing({ barcode: input.sku })]).existing.length, 1);
});

test("an existing exact or catalog variant under another SKU is never silently merged or restocked", () => {
  assert.throws(() => planInventoryLabels(labels(input), [existing({ sku: "EXISTING-SKU" })]), /already exists as EXISTING-SKU/);
  assert.throws(() => planInventoryLabels(labels({ ...input, tcgplayerId: 12 }), [existing({ sku: "CATALOG-SKU", name: "Ahri alt spelling", tcgplayerId: 12 })]), /already exists as CATALOG-SKU/);
  assert.equal(planInventoryLabels(labels(input), [existing({ sku: "FOIL-SKU", finish: "Foil" })]).create.length, 1);
  assert.equal(planInventoryLabels(labels(input), [existing({ sku: "DAMAGED-SKU", condition: "Damaged" })]).create.length, 1);
});

test("mixed new/reprint planning does not mutate source records and rejects a later conflict", () => {
  const product = existing();
  const fresh = { ...input, sku: "DEFY-1234567891", name: "Jinx", cardNumber: "OGN-002" };
  const plan = planInventoryLabels(labels(fresh, input), [product]);
  assert.deepEqual(plan.create.map((row) => row.sku), [fresh.sku]);
  assert.deepEqual(plan.existing.map((row) => row.sku), [input.sku]);
  assert.throws(() => planInventoryLabels(labels(fresh, { ...input, name: "Different card" }), [product]), status(409));
  assert.equal(product.quantity, 7);
});

test("evergreen reservations validate initial quantity while pricing remains server-owned", () => {
  const candidate = { ...input, tcgplayerId: 652905, quantity: 12, costCents: 175, listPriceCents: 299, location: " shelf 3 " };
  const original = structuredClone(candidate);
  const label = validateSkuLabelReservation({ label: candidate });
  assert.equal(label.sku, input.sku);
  assert.equal(label.tcgplayerId, 652905);
  assert.equal(label.quantity, 12);
  assert.equal(label.costCents, 0);
  assert.equal(label.listPriceCents, 0);
  assert.equal(label.location, "SHELF 3");
  assert.deepEqual(candidate, original);
});

test("evergreen reservations reject missing catalog identity or malformed full label input", () => {
  for (const payload of [null, {}, { labels: [input] }, { label: null }, { label: input },
    { label: { ...input, tcgplayerId: 0 } }, { label: { ...input, tcgplayerId: 12, sku: "LEGACY-SKU" } },
    { label: { ...input, tcgplayerId: 12, quantity: -1 } },
    { label: { ...input, tcgplayerId: 12, costCents: "100" } },
  ]) assert.throws(() => validateSkuLabelReservation(payload), status(400));
});
