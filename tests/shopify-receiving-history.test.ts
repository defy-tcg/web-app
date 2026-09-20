import assert from "node:assert/strict";
import test from "node:test";
import { getReceivingHistory, parseReceivingHistoryReceipt, RECEIVING_HISTORY_PAGE_SIZE, type ReceivingHistoryDependencies } from "../lib/shopify/receiving-history.ts";

const shop = "defy-receiving-test.myshopify.com";
const locationId = "gid://shopify/Location/1";
const requestId = "receipt-2026-09-19-000001";
function savedRecord() {
  const product = { productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/3", inventoryItemId: "gid://shopify/InventoryItem/4",
    sku: "DEFY-000014", barcode: "196214150478", name: "Perfect Order Booster Bundle", game: "Pokémon", unit: "Booster bundle", status: "DRAFT" };
  return { version: 1, fingerprint: "internal receipt fingerprint", product,
    receipt: { ...product, requestId, barcode: "0196214150478", locationId, locationName: "Redmond", quantity: 6, unitCost: "12.34", currencyCode: "USD",
      supplier: "Distributor <invoice>", notes: "Box checked\nSix bundles", receivedDate: "2026-09-18", recordedAt: "2026-09-19T10:00:00.000Z",
      appliedAt: "2026-09-19T10:00:01Z", adjustmentGroupId: "gid://shopify/InventoryAdjustmentGroup/5", createdProduct: false, staged: true } };
}
function node(record = savedRecord(), id = "gid://shopify/Metaobject/6") {
  return { id, handle: record.receipt.requestId, payload: { value: JSON.stringify(record) } };
}
function harness(nodes: unknown[] = [node()], hasNextPage = false, endCursor: string | null = null) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const response = { shop: { myshopifyDomain: shop }, location: { id: locationId }, metaobjects: { nodes, pageInfo: { hasNextPage, endCursor } } };
  const dependencies: ReceivingHistoryDependencies = { shop, locationId, now: () => new Date("2026-09-19T11:00:00Z"), graphql: async <T>(query: string, variables: Record<string, unknown> = {}) => {
    calls.push({ query, variables }); return structuredClone(response) as T;
  } };
  return { calls, response, dependencies };
}

test("completed receipts preserve stable Shopify identities, exact cents, barcode aliases and historical status", () => {
  const parsed = parseReceivingHistoryReceipt(node());
  assert.equal(parsed.id, "gid://shopify/Metaobject/6");
  assert.equal(parsed.requestId, requestId);
  assert.equal(parsed.sku, "DEFY-000014");
  assert.equal(parsed.barcode, "0196214150478");
  assert.equal(parsed.unitCostCents, 1234);
  assert.equal(parsed.totalCostCents, 7404);
  assert.equal(parsed.quantity, 6);
  assert.equal(parsed.supplier, "Distributor <invoice>");
  assert.equal(parsed.notes, "Box checked\nSix bundles");
  assert.equal(parsed.appliedAt, "2026-09-19T10:00:01.000Z");
  assert.equal(parsed.staged, true);
  assert.equal(parsed.createdProduct, false);
  assert.equal("fingerprint" in parsed, false);
  assert.equal("product" in parsed, false);
  const free = savedRecord(); free.receipt.unitCost = "0.00";
  assert.equal(parseReceivingHistoryReceipt(node(free)).totalCostCents, 0);
});

test("receipt ordering respects Shopify's timestamp precision without accepting earlier seconds", () => {
  const record = savedRecord();
  record.receipt.recordedAt = "2026-09-19T10:00:00.500Z";
  record.receipt.appliedAt = "2026-09-19T10:00:00Z";
  assert.equal(parseReceivingHistoryReceipt(node(record)).appliedAt, "2026-09-19T10:00:00.000Z");
  record.receipt.appliedAt = "2026-09-19T10:00:00.500Z";
  assert.doesNotThrow(() => parseReceivingHistoryReceipt(node(record)));
  for (const appliedAt of ["2026-09-19T09:59:59Z", "2026-09-19T10:00:00.499Z"]) {
    record.receipt.appliedAt = appliedAt;
    assert.throws(() => parseReceivingHistoryReceipt(node(record)), { code: "INCOMPLETE_HISTORY" });
  }
});

test("history reads one fixed-size query page using only server shop and location", async () => {
  const f = harness([node()], true, "next-page==");
  const page = await getReceivingHistory(undefined, f.dependencies);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].query, /^query DefyReceivingHistory/);
  assert.doesNotMatch(f.calls[0].query, /\bmutation\b/);
  assert.match(f.calls[0].query, /type: "\$app:receiving_applied"/);
  assert.match(f.calls[0].query, /sortKey: "id", reverse: true/);
  assert.deepEqual(f.calls[0].variables, { first: 25, after: null, locationId });
  assert.equal(page.shop, shop); assert.equal(page.locationId, locationId);
  assert.equal(page.receipts.length, 1); assert.equal(page.scannedCount, 1);
  assert.equal(page.pageSize, 25); assert.equal(page.hasMore, true); assert.equal(page.nextCursor, "next-page==");
  assert.equal(page.fetchedAt, "2026-09-19T11:00:00.000Z");
  await assert.rejects(getReceivingHistory(page.nextCursor, f.dependencies), { code: "INCOMPLETE_HISTORY" });
  assert.equal(f.calls[1].variables.after, "next-page==");
});

test("other-location receipts are excluded without hiding continuation, including an empty filtered page", async () => {
  const other = savedRecord(); other.receipt.locationId = "gid://shopify/Location/99";
  const f = harness([node(other)], true, "older-page");
  const page = await getReceivingHistory(null, f.dependencies);
  assert.deepEqual(page.receipts, []); assert.equal(page.otherLocationCount, 1); assert.equal(page.scannedCount, 1);
  assert.equal(page.hasMore, true); assert.equal(page.nextCursor, "older-page");
  const empty = await getReceivingHistory(undefined, harness([]).dependencies);
  assert.equal(empty.hasMore, false); assert.equal(empty.nextCursor, null); assert.equal(empty.scannedCount, 0);
});

test("invalid cursors and unapproved configuration cannot issue a query", async () => {
  const f = harness();
  for (const value of ["", " ", "x\ny", "x".repeat(2049), {}, 4, "cursor\"query"]) {
    await assert.rejects(getReceivingHistory(value, f.dependencies), { code: "INVALID_CURSOR", status: 400 });
  }
  for (const changed of [{ shop: "attacker.myshopify.com" }, { locationId: "Location/1" }]) {
    await assert.rejects(getReceivingHistory(undefined, { ...f.dependencies, ...changed }), { code: "CONNECTION_REQUIRED", status: 503 });
  }
  assert.equal(f.calls.length, 0);
});

test("malformed, pending and identity-conflicting records never become confirmed receipts", () => {
  for (const change of [
    (r: ReturnType<typeof savedRecord>) => { r.version = 2; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.requestId = "bad-id"; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.variantId = "gid://shopify/ProductVariant/99"; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.sku = "another-sku"; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.adjustmentGroupId = ""; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.barcode = "0196214150479"; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.receivedDate = "2026-02-30"; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.recordedAt = "2026-02-30T10:00:00Z"; },
    (r: ReturnType<typeof savedRecord>) => { r.receipt.appliedAt = "2026-09-19T09:00:00Z"; },
  ]) {
    const record = savedRecord(); change(record);
    assert.throws(() => parseReceivingHistoryReceipt(node(record)), { code: "INCOMPLETE_HISTORY" });
  }
  const mismatch = node(); mismatch.handle = "another-receipt-000000";
  for (const value of [null, {}, mismatch, { ...node(), payload: { value: "{" } }, { ...node(), payload: { value: " ".repeat(65_537) } },
    { ...node(), payload: { value: JSON.stringify({ version: 1, phase: "inventory_pending" }) } }]) {
    assert.throws(() => parseReceivingHistoryReceipt(value), { code: "INCOMPLETE_HISTORY" });
  }
});

test("invalid money, quantities, unsafe receipt totals and missing required fields fail closed", () => {
  for (const unitCost of ["NaN", "-1.00", "1.001", "1e3", "1", "9007199254740991.00"]) {
    const record = savedRecord(); record.receipt.unitCost = unitCost;
    assert.throws(() => parseReceivingHistoryReceipt(node(record)), { code: "INCOMPLETE_HISTORY" });
  }
  for (const quantity of [0, -1, 1.5, 2_147_483_648]) {
    const record = savedRecord(); record.receipt.quantity = quantity;
    assert.throws(() => parseReceivingHistoryReceipt(node(record)), { code: "INCOMPLETE_HISTORY" });
  }
  const huge = savedRecord(); huge.receipt.unitCost = "90071992547409.90";
  assert.throws(() => parseReceivingHistoryReceipt(node(huge)), { code: "INCOMPLETE_HISTORY" });
  for (const key of ["locationId", "currencyCode", "supplier", "notes", "staged", "createdProduct"]) {
    const record = savedRecord(); delete (record.receipt as Record<string, unknown>)[key];
    assert.throws(() => parseReceivingHistoryReceipt(node(record)), { code: "INCOMPLETE_HISTORY" });
  }
});

test("any broken page member, duplicated receipt, invalid page size or cursor prevents partial success", async () => {
  const bad = node(); bad.payload.value = "{}";
  for (const f of [harness([node(), bad]), harness([node(), node()]), harness(Array.from({ length: RECEIVING_HISTORY_PAGE_SIZE + 1 }, () => node())),
    harness([node()], true, null), harness([node()], true, "invalid\n"), harness([], true, "next-page")]) {
    await assert.rejects(getReceivingHistory(undefined, f.dependencies), { code: "INCOMPLETE_HISTORY", status: 503 });
  }
});

test("shop or location mismatch and upstream failures are sanitized without false empty history", async () => {
  const f = harness(); f.response.shop.myshopifyDomain = "other.myshopify.com";
  await assert.rejects(getReceivingHistory(undefined, f.dependencies), { code: "CONNECTION_MISMATCH", status: 503 });
  const changed = harness(); changed.response.location.id = "gid://shopify/Location/99";
  await assert.rejects(getReceivingHistory(undefined, changed.dependencies), { code: "CONNECTION_MISMATCH", status: 503 });
  for (const code of ["ACCESS_DENIED", "SHOPIFY_AUTH_FAILED", "UNKNOWN"]) {
    await assert.rejects(getReceivingHistory(undefined, { ...harness().dependencies, graphql: async () => { throw Object.assign(new Error("PRIVATE_SECRET upstream body"), { code }); } }), error => {
      assert.equal((error as { status: number }).status, 503);
      assert.doesNotMatch((error as Error).message, /PRIVATE_SECRET|upstream body/);
      return true;
    });
  }
});
