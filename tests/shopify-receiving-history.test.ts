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
function stockRecord() {
  const record = savedRecord();
  return { ...record, receipt: { ...record.receipt, inventoryMode: "set", expectedAvailableQuantity: 12, quantity: 4, unitCost: "0.00", storePrice: "24.99" } };
}
function rejectedRecord() {
  const { product } = savedRecord();
  const request = { requestId, barcode: "0196214150478", sku: product.sku, name: product.name, game: product.game,
    unit: product.unit, quantity: 4, inventoryMode: "set", expectedAvailableQuantity: 12, unitCost: "0.00", storePrice: "24.99",
    supplier: "", notes: "Shelf count", receivedDate: "2026-09-18", replaceInvalidBarcode: false, locationId };
  return { version: 1, status: "rejected", fingerprint: JSON.stringify(request, Object.keys(request).sort()), request,
    product: { ...product, tracked: true, barcodeNeedsReview: false, price: "24.99" }, rejectedAt: "2026-09-19T10:00:01.000Z",
    error: { code: "STOCK_CHANGED", message: "Shopify stock changed. Refresh before saving a new current-stock count." } };
}
function rejectionNode(record = rejectedRecord(), id = "gid://shopify/Metaobject/7") {
  return { id, handle: record.request.requestId, payload: { value: JSON.stringify(record) } };
}
function refreshFingerprint(record: ReturnType<typeof rejectedRecord>) {
  const canonical = (value: unknown): string => value !== null && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
  record.fingerprint = canonical(record.request);
  return record;
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
  assert.equal("inventoryMode" in parsed, false);
  assert.equal("expectedAvailableQuantity" in parsed, false);
  assert.equal("storePriceCents" in parsed, false);
  const free = savedRecord(); free.receipt.unitCost = "0.00";
  assert.equal(parseReceivingHistoryReceipt(node(free)).totalCostCents, 0);
});

test("stock counts preserve absolute totals including zero, signed baselines, and separate saved store prices", () => {
  const record = stockRecord();
  const parsed = parseReceivingHistoryReceipt(node(record));
  assert.equal(parsed.inventoryMode, "set");
  assert.equal(parsed.quantity, 4);
  assert.equal(parsed.expectedAvailableQuantity, 12);
  assert.equal(parsed.unitCostCents, 0);
  assert.equal(parsed.totalCostCents, 0);
  assert.equal(parsed.storePriceCents, 2499);
  record.receipt.quantity = 0;
  record.receipt.expectedAvailableQuantity = -2_147_483_648;
  record.receipt.storePrice = "0.00";
  const empty = parseReceivingHistoryReceipt(node(record));
  assert.equal(empty.quantity, 0);
  assert.equal(empty.expectedAvailableQuantity, -2_147_483_648);
  assert.equal(empty.storePriceCents, 0);
  const delivery = savedRecord();
  Object.assign(delivery.receipt, { storePrice: "1000000.00" });
  assert.equal(parseReceivingHistoryReceipt(node(delivery)).storePriceCents, 100_000_000);
  assert.equal(parseReceivingHistoryReceipt(node(delivery)).totalCostCents, 7404);
});

test("stock counts reject malformed modes, totals, baselines, acquisition costs, and manual prices", () => {
  for (const [key, values] of Object.entries({
    inventoryMode: [null, "receive", "SET", false],
    quantity: ["4", -1, 0.5, 2_147_483_648, null],
    expectedAvailableQuantity: [undefined, "12", null, 0.5, -2_147_483_649, 2_147_483_648],
    unitCost: ["1.00", "00.00", "0", 0],
    storePrice: [null, 24.99, "", "-1.00", "1.001", "1000000.01"],
  })) {
    for (const value of values) {
      const record = stockRecord();
      (record.receipt as Record<string, unknown>)[key] = value;
      assert.throws(() => parseReceivingHistoryReceipt(node(record)), { code: "INCOMPLETE_HISTORY" });
    }
  }
  const delivery = savedRecord();
  Object.assign(delivery.receipt, { expectedAvailableQuantity: 12 });
  assert.throws(() => parseReceivingHistoryReceipt(node(delivery)), { code: "INCOMPLETE_HISTORY" });
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

test("validated stock rejections are skipped without changing pagination or other-location receipt counts", async () => {
  const rejected = rejectedRecord(); rejected.request.requestId = "receipt-2026-09-19-000002";
  rejected.request.locationId = "gid://shopify/Location/99";
  refreshFingerprint(rejected);
  const other = savedRecord(); other.receipt.requestId = "receipt-2026-09-19-000003"; other.receipt.locationId = "gid://shopify/Location/99";
  const f = harness([node(), rejectionNode(rejected), node(other, "gid://shopify/Metaobject/8")], true, "older-page");
  const page = await getReceivingHistory(null, f.dependencies);
  assert.equal(page.receipts.length, 1);
  assert.equal(page.receipts[0].requestId, requestId);
  assert.equal(page.scannedCount, 3);
  assert.equal(page.otherLocationCount, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, "older-page");
  const rejectedOnly = await getReceivingHistory(null, harness([rejectionNode()], true, "next-page").dependencies);
  assert.deepEqual(rejectedOnly.receipts, []);
  assert.equal(rejectedOnly.scannedCount, 1);
  assert.equal(rejectedOnly.otherLocationCount, 0);
  assert.equal(rejectedOnly.hasMore, true);
  assert.equal(rejectedOnly.nextCursor, "next-page");
  const finalPage = await getReceivingHistory(null, harness([rejectionNode()]).dependencies);
  assert.equal(finalPage.hasMore, false);
  assert.equal(finalPage.nextCursor, null);
  assert.throws(() => parseReceivingHistoryReceipt(rejectionNode()), { code: "INCOMPLETE_HISTORY" });
});

test("rejections must have a complete canonical set request, verified product and terminal error", async () => {
  const mutations: ((record: ReturnType<typeof rejectedRecord>) => void)[] = [
    record => { record.fingerprint = "changed"; },
    record => { record.status = "pending"; },
    record => { record.error.code = "NETWORK_TIMEOUT"; },
    record => { record.error.message = ""; },
    record => { record.rejectedAt = "2026-02-30T10:00:01Z"; },
    record => { record.request.inventoryMode = "receive"; refreshFingerprint(record); },
    record => { record.request.quantity = -1; refreshFingerprint(record); },
    record => { record.request.expectedAvailableQuantity = 1.5; refreshFingerprint(record); },
    record => { record.request.unitCost = "1.00"; refreshFingerprint(record); },
    record => { record.request.locationId = "Location/1"; refreshFingerprint(record); },
    record => { record.request.receivedDate = "2026-02-30"; refreshFingerprint(record); },
    record => { record.product.sku = "another-sku"; },
    record => { record.product.unit = "Booster box"; },
    record => { record.product.barcode = "0196214150479"; },
    record => { record.product.inventoryItemId = "InventoryItem/4"; },
    record => { record.product.tracked = false; },
    record => { record.product.barcodeNeedsReview = true; },
    record => { Object.assign(record, { receipt: savedRecord().receipt }); },
  ];
  for (const mutate of mutations) {
    const rejected = rejectedRecord(); mutate(rejected);
    await assert.rejects(getReceivingHistory(undefined, harness([rejectionNode(rejected)]).dependencies), { code: "INCOMPLETE_HISTORY" });
  }
  for (const key of ["request", "product", "fingerprint", "rejectedAt", "error"]) {
    const rejected = rejectionNode();
    const payload = JSON.parse(rejected.payload.value); delete payload[key]; rejected.payload.value = JSON.stringify(payload);
    await assert.rejects(getReceivingHistory(undefined, harness([rejected]).dependencies), { code: "INCOMPLETE_HISTORY" });
  }
  const unknown = node();
  unknown.payload.value = JSON.stringify({ ...savedRecord(), status: "unknown" });
  await assert.rejects(getReceivingHistory(undefined, harness([unknown]).dependencies), { code: "INCOMPLETE_HISTORY" });
});

test("rejection filtering cannot conceal duplicate IDs or request IDs", async () => {
  for (const nodes of [
    [node(), rejectionNode()],
    [rejectionNode(), rejectionNode()],
  ]) {
    await assert.rejects(getReceivingHistory(undefined, harness(nodes).dependencies), { code: "INCOMPLETE_HISTORY" });
  }
  const rejected = rejectedRecord(); rejected.request.requestId = "receipt-2026-09-19-000002"; refreshFingerprint(rejected);
  await assert.rejects(getReceivingHistory(undefined, harness([node(), rejectionNode(rejected, "gid://shopify/Metaobject/6")]).dependencies), { code: "INCOMPLETE_HISTORY" });
});

test("rejections allow new-product requests and zero counts against negative stock", async () => {
  const record = rejectedRecord();
  record.request.sku = "";
  record.request.quantity = 0;
  record.request.expectedAvailableQuantity = -1;
  record.product.status = "UNLISTED";
  refreshFingerprint(record);
  const page = await getReceivingHistory(undefined, harness([rejectionNode(record)]).dependencies);
  assert.equal(page.scannedCount, 1);
  assert.deepEqual(page.receipts, []);
});

test("rejected Gundam and Magic catalog stock counts require canonical games and never become confirmed receipts", async () => {
  for (const fixture of [
    { game: "gundam", label: "Gundam", id: "GD01-s1", setName: "Newtype Rising", mismatchedLabel: "Riftbound" },
    { game: "magicthegathering", label: "MTG", id: "fdn-s1", setName: "Foundations", mismatchedLabel: "Magic: The Gathering" },
  ]) {
    const record = rejectedRecord();
    record.request.game = record.product.game = fixture.label;
    record.request.name = record.product.name = `${fixture.setName} Booster Box`;
    record.request.unit = record.product.unit = "Booster box";
    const catalog = { game: fixture.game, id: fixture.id, name: record.request.name, setName: fixture.setName, language: "English" };
    Object.assign(record.request, { catalog });
    refreshFingerprint(record);
    const page = await getReceivingHistory(undefined, harness([rejectionNode(record)]).dependencies);
    assert.equal(page.scannedCount, 1);
    assert.deepEqual(page.receipts, []);
    record.request.game = fixture.mismatchedLabel;
    refreshFingerprint(record);
    await assert.rejects(getReceivingHistory(undefined, harness([rejectionNode(record)]).dependencies), { code: "INCOMPLETE_HISTORY" });
    if (fixture.game === "magicthegathering") {
      record.request.game = fixture.label;
      catalog.game = "mtg";
      refreshFingerprint(record);
      await assert.rejects(getReceivingHistory(undefined, harness([rejectionNode(record)]).dependencies), { code: "INCOMPLETE_HISTORY" });
    }
  }
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
