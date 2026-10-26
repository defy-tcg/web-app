import assert from "node:assert/strict";
import test from "node:test";
import { filterSalesByInventorySource, type SourceSale, type SourceSaleItem } from "../lib/reports/inventory-source.ts";

function sale(changes: Partial<SourceSale> = {}): SourceSale {
  return { id: "order-1", subtotalCents: 1500, discountCents: 101, taxCents: 109,
    totalCents: 1508, cogsCents: 500, itemsCount: 2, ...changes };
}
function line(id: string, changes: Partial<SourceSaleItem> = {}): SourceSaleItem {
  return { id, saleId: "order-1", quantity: 1, unitPriceCents: 1000, unitCostCents: 400, ...changes };
}
const mixed = () => [line("store"), line("bulk", { inventorySource: "bulk_warehouse", unitPriceCents: 500, unitCostCents: 100 })];

test("mixed orders split revenue, discounts, taxes, costs and quantity while preserving All totals", () => {
  const original = sale();
  const all = filterSalesByInventorySource([original], mixed(), "all");
  const store = filterSalesByInventorySource([original], mixed(), "store");
  const bulk = filterSalesByInventorySource([original], mixed(), "bulk_warehouse");
  assert.equal(all.sales[0].sourceScope, "mixed");
  assert.equal(store.sales[0].sourceScope, "mixed");
  assert.equal(store.sales[0].subtotalCents, 1000);
  assert.equal(store.sales[0].discountCents, 67);
  assert.equal(store.sales[0].taxCents, 73);
  assert.equal(store.saleItems[0].revenueCents, 933);
  assert.equal(bulk.saleItems[0].revenueCents, 466);
  for (const key of ["subtotalCents", "discountCents", "taxCents", "totalCents", "cogsCents", "itemsCount"] as const) {
    assert.equal(store.sales[0][key] + bulk.sales[0][key], original[key], key);
    assert.equal(all.sales[0][key], original[key], key);
  }
  assert.equal(original.discountCents, 101);
  assert.equal(mixed()[0].discountCents, undefined);
});

test("exact per-line discount and tax amounts override proportions and preserve partial explicit allocations", () => {
  const lines = mixed();
  lines[1].discountCents = 100;
  lines[1].taxCents = 25;
  const report = filterSalesByInventorySource([sale()], lines, "all");
  assert.deepEqual(report.saleItems.map(item => [item.discountCents, item.taxCents]), [[1, 84], [100, 25]]);
  lines[0].discountCents = 1; lines[0].taxCents = 84;
  assert.deepEqual(filterSalesByInventorySource([sale()], lines, "bulk_warehouse").saleItems.map(item => [item.revenueCents, item.taxCents]), [[400, 25]]);
});

test("penny allocation uses stable line IDs and does not change when API ordering changes", () => {
  const order = sale({ subtotalCents: 3, discountCents: 1, taxCents: 1, totalCents: 3, cogsCents: 0, itemsCount: 3 });
  const lines = [line("c", { unitPriceCents: 1, unitCostCents: 0 }), line("a", { inventorySource: "bulk_warehouse", unitPriceCents: 1, unitCostCents: 0 }), line("b", { unitPriceCents: 1, unitCostCents: 0 })];
  const project = (items: SourceSaleItem[]) => filterSalesByInventorySource([order], items, "all").saleItems
    .map(item => [item.id, item.discountCents, item.taxCents]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(project(lines), [["a", 1, 0], ["b", 0, 1], ["c", 0, 0]]);
  assert.deepEqual(project(lines), project([...lines].reverse()));
});

test("refunds preserve signed quantities and reverse discounts, taxes and COGS without clamping", () => {
  const original = sale();
  const refunded = sale(Object.fromEntries(["subtotalCents", "discountCents", "taxCents", "totalCents", "cogsCents", "itemsCount"].map(key => [key, -original[key as keyof typeof original]!])) as Partial<SourceSale>);
  const refundLines = mixed().map(item => ({ ...item, quantity: -item.quantity }));
  for (const source of ["all", "store", "bulk_warehouse"] as const) {
    const before = filterSalesByInventorySource([original], mixed(), source);
    const after = filterSalesByInventorySource([refunded], refundLines, source);
    assert.equal(after.sales[0].totalCents, -before.sales[0].totalCents);
    assert.equal(after.sales[0].discountCents, -before.sales[0].discountCents);
    assert.equal(after.sales[0].taxCents, -before.sales[0].taxCents);
    assert.equal(after.sales[0].cogsCents, -before.sales[0].cogsCents);
    assert.equal(after.saleItems[0].revenueCents, -before.saleItems[0].revenueCents);
  }
});

test("a sale and refund in the same order retain exact item allocations even with zero net subtotal", () => {
  const order = sale({ subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0, cogsCents: 0, itemsCount: 0 });
  const lines = [line("store", { discountCents: 100, taxCents: 90 }), line("bulk", { inventorySource: "bulk_warehouse", quantity: -1, discountCents: -100, taxCents: -90 })];
  const store = filterSalesByInventorySource([order], lines, "store");
  const bulk = filterSalesByInventorySource([order], lines, "bulk_warehouse");
  assert.equal(store.sales[0].totalCents, 990);
  assert.equal(bulk.sales[0].totalCents, -990);
  assert.equal(store.saleItems[0].quantity, 1);
  assert.equal(bulk.saleItems[0].quantity, -1);
});

test("legacy unitemized and truncated store sales preserve recorded totals and never become bulk", () => {
  for (const lines of [[], [mixed()[0]]]) {
    const all = filterSalesByInventorySource([sale()], lines, "all");
    const store = filterSalesByInventorySource([sale()], lines, "store");
    const bulk = filterSalesByInventorySource([sale()], lines, "bulk_warehouse");
    assert.equal(all.sales[0].totalCents, 1508);
    assert.equal(store.sales[0].totalCents, 1508);
    assert.equal(store.saleItems.length, 0, "partial rankings must not look complete");
    assert.equal(bulk.sales.length, 0);
    assert.equal(store.unitemizedSales + store.incompleteSales, 1);
  }
});

test("an incomplete order with bulk evidence is included only in All and flagged for source filters", () => {
  const partial = [mixed()[1]];
  const all = filterSalesByInventorySource([sale()], partial, "all");
  assert.equal(all.sales[0].totalCents, 1508);
  assert.equal(all.sales[0].sourceScope, "unclassified");
  for (const source of ["store", "bulk_warehouse"] as const) {
    const result = filterSalesByInventorySource([sale()], partial, source);
    assert.equal(result.sales.length, 0);
    assert.equal(result.saleItems.length, 0);
    assert.equal(result.excludedMixedSales, 1);
  }
});

test("explicit source identifies an unitemized warehouse receipt without guessing from channel or SKU", () => {
  const explicit = sale({ inventorySource: "bulk_warehouse" });
  assert.equal(filterSalesByInventorySource([explicit], [], "bulk_warehouse").sales[0].totalCents, 1508);
  assert.equal(filterSalesByInventorySource([explicit], [], "store").sales.length, 0);
  assert.equal(filterSalesByInventorySource([explicit], [], "bulk_warehouse").unitemizedSales, 1);
});

test("inconsistent exact allocations and duplicated lines never produce fabricated filtered amounts", () => {
  const badAllocations = mixed().map(item => ({ ...item, discountCents: 100, taxCents: 50 }));
  for (const lines of [badAllocations, [...mixed(), mixed()[1]]]) {
    const filtered = filterSalesByInventorySource([sale()], lines, "bulk_warehouse");
    assert.equal(filtered.sales.length, 0);
    assert.equal(filtered.excludedMixedSales, 1);
    assert.equal(filterSalesByInventorySource([sale()], lines, "all").sales[0].totalCents, 1508);
  }
});

test("free items allocate zero adjustments and orphaned item rows do not leak into reports", () => {
  const order = sale({ subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0, cogsCents: 0, itemsCount: 1 });
  const lines = [line("free", { inventorySource: "bulk_warehouse", unitPriceCents: 0, unitCostCents: 0 }), line("orphan", { saleId: "unknown" })];
  const result = filterSalesByInventorySource([order], lines, "bulk_warehouse");
  assert.equal(result.sales.length, 1);
  assert.equal(result.saleItems.length, 1);
  assert.equal(result.saleItems[0].revenueCents, 0);
});

test("unsafe line arithmetic is excluded from itemized projections while original totals remain inspectable", () => {
  const lines = mixed();
  lines[1].quantity = Number.MAX_SAFE_INTEGER;
  const result = filterSalesByInventorySource([sale()], lines, "bulk_warehouse");
  assert.equal(result.excludedMixedSales, 1);
  assert.equal(result.sales.length, 0);
  assert.equal(filterSalesByInventorySource([sale()], lines, "all").sales.length, 1);
});

test("unknown acquisition costs remain explicitly incomplete in every source projection", () => {
  const order = sale({ costIncomplete: true, cogsCents: 400 });
  const items = mixed();
  items[1].unitCostCents = 0;
  for (const source of ["all", "store", "bulk_warehouse"] as const) {
    const result = filterSalesByInventorySource([order], items, source);
    assert.equal(result.sales[0].costIncomplete, true, "a numeric compatibility zero must not imply known free stock");
  }
  const bulk = filterSalesByInventorySource([order], items, "bulk_warehouse");
  assert.equal(bulk.saleItems[0].revenueCents, 466, "unknown costs must not remove real revenue");
  assert.equal(bulk.sales[0].cogsCents, 0, "only the known numeric cost portion is retained");
  assert.equal(order.costIncomplete, true);
});

test("aggregate native orders use exact line totals and never manufacture a rounded unit price", () => {
  const order = sale({ subtotalCents: 1001, discountCents: 1, taxCents: 9, totalCents: 1009, cogsCents: 401, itemsCount: 3, inventorySource: "bulk_warehouse" });
  const item = line("native-order-total", { quantity: 3, inventorySource: "bulk_warehouse", unitPriceCents: null, unitCostCents: null,
    lineSubtotalCents: 1001, lineCostCents: 401, discountCents: 1, taxCents: 9, aggregate: true });
  for (const source of ["all", "bulk_warehouse"] as const) {
    const result = filterSalesByInventorySource([order], [item], source);
    assert.equal(result.sales[0].sourceBreakdown, "complete");
    assert.equal(result.sales[0].itemsCount, 3);
    assert.equal(result.saleItems[0].revenueCents, 1000);
    assert.equal(result.saleItems[0].cogsCents, 401);
    assert.equal(result.saleItems[0].unitPriceCents, null);
    assert.equal(result.saleItems[0].aggregate, true);
  }
  assert.equal(filterSalesByInventorySource([order], [item], "store").sales.length, 0);
});

test("mixed source projection accepts aggregate totals and refuses null unit-price coercion", () => {
  const order = sale({ subtotalCents: 2001, discountCents: 1, taxCents: 9, totalCents: 2009, cogsCents: 801, itemsCount: 4 });
  const item = line("native-order-total", { quantity: 3, inventorySource: "bulk_warehouse", unitPriceCents: null, unitCostCents: null,
    lineSubtotalCents: 1001, lineCostCents: 401, discountCents: 1, taxCents: 9, aggregate: true });
  const items = [line("store", { discountCents: 0, taxCents: 0 }), item];
  const result = filterSalesByInventorySource([order], items, "bulk_warehouse");
  assert.equal(result.sales[0].subtotalCents, 1001);
  assert.equal(result.sales[0].totalCents, 1009);
  assert.equal(result.sales[0].itemsCount, 3);
  const missing = { ...item }; delete missing.lineSubtotalCents;
  assert.equal(filterSalesByInventorySource([order], [items[0], missing], "bulk_warehouse").excludedMixedSales, 1);
});
