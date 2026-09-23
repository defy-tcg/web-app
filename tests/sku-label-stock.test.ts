import assert from "node:assert/strict";
import test from "node:test";
import { addSkuLabelStock, parseSkuLabelStockRequest, SkuLabelStockInputError } from "../lib/sku-label-stock.ts";
import { digest } from "../lib/singles/intake.ts";
import type { SkuLabelShopifyDependencies, SkuLabelShopifyProduct } from "../lib/sku-label-shopify.ts";
import type { SkuLabelStockRequest } from "../lib/sku-label-stock-types.ts";

const card: SkuLabelShopifyProduct = { id: 77, sku: "DEFY-9775456393", name: "Time Warp", game: "Magic: The Gathering", setName: "Test set", cardNumber: "122", condition: "Near Mint", finish: "Foil", tcgplayerId: 652905, costCents: 1000, listPriceCents: 4500, quantity: 2, initialQuantity: 2 };
const input: SkuLabelStockRequest = { requestId: "67d266fc-c4ee-4b40-b052-a27eae34b000", sku: card.sku, quantity: 5 };
const second = { ...input, requestId: "67d266fc-c4ee-4b40-b052-a27eae34b001", quantity: 3 };
const setInput: SkuLabelStockRequest = { ...input, mode: "set", quantity: 4, expectedAvailableQuantity: 2 };
const location = "gid://shopify/Location/1";
const identity = JSON.stringify(["single:tcgplayer:printing:652905", "Near Mint", "foil", "English"]);
const linkKey = `qr_${digest(card.sku).slice(0, 60)}`;
const clone = <T>(value: T): T => structuredClone(value);

function fixture(options: { loseAdjustment?: boolean; loseCompletion?: boolean; reject?: boolean; rejectionCode?: string; duplicate?: boolean; failPreflight?: boolean } = {}) {
  let time = 1_800_000_000_000, serial = 0, lostAdjustment = false, lostCompletion = false;
  const calls: { name: string; variables: Record<string, unknown> }[] = [];
  const adjustments = new Map<string, string>();
  const journals = new Map<string, { value: string; compareDigest: string }>();
  const variant = {
    id: "gid://shopify/ProductVariant/123", sku: card.sku, barcode: card.sku, price: "45.00", inventoryQuantity: 2, inventoryPolicy: "DENY",
    selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }],
    barcodes: { nodes: [{ value: "9780262033848", type: "ISBN" }, { value: card.sku, type: null }], pageInfo: { hasNextPage: false } },
    pos: true, qrIdentity: { value: identity },
    inventoryItem: { id: "gid://shopify/InventoryItem/1234", tracked: true, unitCost: { amount: "10.00" }, inventoryLevel: { location: { id: location }, quantities: [{ name: "available", quantity: 2 }] } },
    product: { id: "gid://shopify/Product/12", status: "ACTIVE", pos: true, catalogId: { value: "single:tcgplayer:printing:652905" }, sourceId: { value: "652905" }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/123" }], pageInfo: { hasNextPage: false } } },
  };
  const original = { version: 1, identity, sku: card.sku, owner: null, expiresAt: 0, productId: variant.product.id, variantId: variant.id, shopifySku: variant.sku, initialQuantity: 2, adjustmentId: "gid://shopify/InventoryAdjustmentGroup/initial", publicationId: "gid://shopify/Publication/2", status: { sku: card.sku, status: "ready" } };
  journals.set(linkKey, { value: JSON.stringify(original), compareDigest: "initial" });
  const deps: SkuLabelShopifyDependencies = {
    settings: { shop: "defy-receiving-test.myshopify.com", locationId: location }, clock: () => time,
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "";
      calls.push({ name, variables: clone(variables) });
      let result: unknown;
      switch (name) {
        case "SinglesRecord": result = { shop: { id: "gid://shopify/Shop/1", metafield: journals.get(String(variables.key)) ?? null } }; break;
        case "SinglesRecordCAS": {
          const field = (variables.metafields as { key: string; value: string; compareDigest: string | null }[])[0];
          assert.ok(field.key.startsWith("qr_stock_"), "Never change the QR link or initial stock journal");
          const current = journals.get(field.key);
          if ((current?.compareDigest ?? null) !== field.compareDigest) result = { metafieldsSet: { metafields: [], userErrors: [{ code: "INVALID_COMPARE_DIGEST", message: "race" }] } };
          else {
            const saved = { value: field.value, compareDigest: String(++serial) }; journals.set(field.key, saved);
            if (options.loseCompletion && !lostCompletion && JSON.parse(field.value).status === "complete") { lostCompletion = true; throw new Error("lost completion journal response"); }
            result = { metafieldsSet: { metafields: [{ compareDigest: saved.compareDigest }], userErrors: [] } };
          }
          break;
        }
        case "QrStockConnection": result = { shop: { myshopifyDomain: deps.settings.shop }, location: { id: location, isActive: !options.failPreflight }, currentAppInstallation: { accessScopes: ["write_products", "write_inventory", "read_locations", "write_publications"].map(handle => ({ handle })) } }; break;
        case "QrStockTarget": assert.equal(variables.id, variant.id); assert.equal(variables.location, location); result = { productVariant: variant }; break;
        case "QrStockScanCode": result = { productVariants: { nodes: [variant, ...(options.duplicate ? [{ ...variant, id: "gid://shopify/ProductVariant/999" }] : [])], pageInfo: { hasNextPage: false } } }; break;
        case "QrStockReceive": {
          assert.match(query, /@idempotent\(key: \$key\)/);
          const receipt = variables.input as { name: string; reason: string; referenceDocumentUri: string; changes: { inventoryItemId: string; locationId: string; delta: number; changeFromQuantity: null }[] };
          assert.deepEqual(Object.keys(receipt).sort(), ["changes", "name", "reason", "referenceDocumentUri"]);
          assert.equal(receipt.name, "available"); assert.equal(receipt.reason, "received"); assert.equal(receipt.changes.length, 1);
          assert.equal(receipt.changes[0].inventoryItemId, variant.inventoryItem.id); assert.equal(receipt.changes[0].locationId, location); assert.equal(receipt.changes[0].changeFromQuantity, null);
          if (options.reject) { result = { inventoryAdjustQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ code: options.rejectionCode ?? "INVALID", message: "test rejection" }] } }; break; }
          const key = String(variables.key);
          if (!adjustments.has(key)) {
            adjustments.set(key, `gid://shopify/InventoryAdjustmentGroup/${adjustments.size + 1}`);
            variant.inventoryQuantity += receipt.changes[0].delta;
            variant.inventoryItem.inventoryLevel.quantities[0].quantity += receipt.changes[0].delta;
          }
          if (options.loseAdjustment && !lostAdjustment) { lostAdjustment = true; throw new Error("lost successful Shopify adjustment response with secret information"); }
          result = { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: adjustments.get(key) }, userErrors: [] } }; break;
        }
        case "QrStockSet": {
          assert.match(query, /@idempotent\(key: \$key\)/);
          const receipt = variables.input as { name: string; reason: string; referenceDocumentUri: string; quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity: number }[] };
          assert.deepEqual(Object.keys(receipt).sort(), ["name", "quantities", "reason", "referenceDocumentUri"]);
          assert.equal(receipt.name, "available"); assert.equal(receipt.reason, "correction"); assert.equal(receipt.quantities.length, 1);
          const change = receipt.quantities[0];
          assert.deepEqual(Object.keys(change).sort(), ["changeFromQuantity", "inventoryItemId", "locationId", "quantity"]);
          assert.equal(change.inventoryItemId, variant.inventoryItem.id); assert.equal(change.locationId, location);
          assert.ok(Number.isSafeInteger(change.changeFromQuantity), "An absolute correction must always compare the original available count");
          if (options.reject) { result = { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ code: options.rejectionCode ?? "INVALID", message: "test rejection" }] } }; break; }
          const key = String(variables.key);
          if (!adjustments.has(key)) {
            if (change.changeFromQuantity !== variant.inventoryItem.inventoryLevel.quantities[0].quantity) {
              result = { inventorySetQuantities: { inventoryAdjustmentGroup: null, userErrors: [{ code: "CHANGE_FROM_QUANTITY_STALE", message: "Shopify availability changed" }] } }; break;
            }
            adjustments.set(key, `gid://shopify/InventoryAdjustmentGroup/${adjustments.size + 1}`);
            variant.inventoryQuantity = change.quantity;
            variant.inventoryItem.inventoryLevel.quantities[0].quantity = change.quantity;
          }
          if (options.loseAdjustment && !lostAdjustment) { lostAdjustment = true; throw new Error("lost successful Shopify correction response with secret information"); }
          result = { inventorySetQuantities: { inventoryAdjustmentGroup: { id: adjustments.get(key) }, userErrors: [] } }; break;
        }
        default: throw new Error(`Unexpected operation ${name}`);
      }
      return clone(result) as T;
    },
  };
  return { deps, variant, journals, calls, adjustments, options, advance: (ms: number) => { time += ms; }, available: () => variant.inventoryItem.inventoryLevel.quantities[0].quantity, initial: clone(journals.get(linkKey)) };
}

test("stock requests accept only an exact saved SKU, stable UUID and positive bounded whole quantity", () => {
  assert.deepEqual(parseSkuLabelStockRequest(input), input);
  for (const quantity of [0, -1, 100001, 1.5, "5", NaN, Infinity]) assert.throws(() => parseSkuLabelStockRequest({ ...input, quantity }), SkuLabelStockInputError);
  for (const patch of [{ requestId: "short" }, { sku: "DEFY-RFB-652905-FOIL-EN-NM" }, { inventoryItemId: "injected" }]) assert.throws(() => parseSkuLabelStockRequest({ ...input, ...patch }), SkuLabelStockInputError);
});

test("set requests require an explicit valid baseline and allow zero totals without changing legacy add parsing", () => {
  assert.deepEqual(parseSkuLabelStockRequest({ ...input, mode: "add" }), { ...input, mode: "add" });
  for (const quantity of [0, 1, 100000]) assert.deepEqual(parseSkuLabelStockRequest({ ...setInput, quantity }), { ...setInput, quantity });
  assert.equal(parseSkuLabelStockRequest({ ...setInput, expectedAvailableQuantity: -2 }).expectedAvailableQuantity, -2);
  for (const patch of [{ quantity: -1 }, { quantity: 100001 }, { quantity: 1.5 }, { expectedAvailableQuantity: undefined }, { expectedAvailableQuantity: null }, { expectedAvailableQuantity: "2" }, { expectedAvailableQuantity: 1.5 }, { expectedAvailableQuantity: NaN }, { expectedAvailableQuantity: Infinity }]) {
    assert.throws(() => parseSkuLabelStockRequest({ ...setInput, ...patch }), SkuLabelStockInputError);
  }
  for (const patch of [{ mode: "replace" }, { mode: null }, { expectedAvailableQuantity: 2 }, { mode: "add", expectedAvailableQuantity: 2 }]) {
    assert.throws(() => parseSkuLabelStockRequest({ ...input, ...patch }), SkuLabelStockInputError);
  }
});

test("set total supports increase, reduction and zero while preserving prices, QR identity and original stock receipt", async () => {
  for (const quantity of [0, 1, 2, 7]) {
    const f = fixture(); const before = clone(f.variant);
    const response = await addSkuLabelStock(card, { ...setInput, quantity }, f.deps);
    assert.equal(response.status, "complete"); assert.equal(response.mode, "set"); assert.equal(response.expectedAvailableQuantity, 2);
    assert.equal(response.availableQuantity, quantity); assert.equal(f.available(), quantity); assert.equal(f.adjustments.size, 1);
    assert.deepEqual(f.journals.get(linkKey), f.initial);
    assert.deepEqual({ ...f.variant, inventoryQuantity: before.inventoryQuantity, inventoryItem: { ...f.variant.inventoryItem, inventoryLevel: before.inventoryItem.inventoryLevel } }, before);
    assert.equal(f.calls.filter(call => call.name === "QrStockReceive").length, 0);
    assert.match(response.message, /total was set/);
  }
});

test("set total can correct an oversold negative live availability", async () => {
  const f = fixture(); f.variant.inventoryQuantity = -2; f.variant.inventoryItem.inventoryLevel.quantities[0].quantity = -2;
  const response = await addSkuLabelStock(card, { ...setInput, expectedAvailableQuantity: -2 }, f.deps);
  assert.equal(response.status, "complete"); assert.equal(response.availableQuantity, 4); assert.equal(f.available(), 4);
});

test("stale total corrections are durably rejected without overwriting a sale or another stock change", async () => {
  const f = fixture(); f.variant.inventoryQuantity = 1; f.variant.inventoryItem.inventoryLevel.quantities[0].quantity = 1;
  const response = await addSkuLabelStock(card, setInput, f.deps);
  assert.equal(response.status, "rejected"); assert.equal(response.retryable, false); assert.match(response.message, /Refresh availability/);
  assert.equal(response.availableQuantity, 1); assert.equal(f.available(), 1); assert.equal(f.adjustments.size, 0);
  assert.equal((await addSkuLabelStock(card, setInput, f.deps)).status, "rejected");
  assert.equal(f.calls.filter(call => call.name === "QrStockSet").length, 1);
  const changedBaseline = await addSkuLabelStock(card, { ...setInput, expectedAvailableQuantity: 1 }, f.deps);
  assert.equal(changedBaseline.status, "pending"); assert.equal(changedBaseline.retryable, false);
  const refreshed = await addSkuLabelStock(card, { ...setInput, requestId: second.requestId, expectedAvailableQuantity: 1 }, f.deps);
  assert.equal(refreshed.status, "complete"); assert.equal(f.available(), 4);
});

test("a sale between target validation and the correction is protected by Shopify compare-and-swap", async () => {
  const f = fixture(); const original = f.deps.graphql;
  f.deps.graphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    if (query.includes("mutation QrStockSet")) { f.variant.inventoryQuantity--; f.variant.inventoryItem.inventoryLevel.quantities[0].quantity--; }
    return original<T>(query, variables);
  };
  assert.equal((await addSkuLabelStock(card, setInput, f.deps)).status, "rejected");
  assert.equal(f.available(), 1); assert.equal(f.adjustments.size, 0);
});

test("lost total correction responses replay only the original baseline and never restore later sold stock", async () => {
  for (const options of [{ loseAdjustment: true }, { loseCompletion: true }]) {
    const f = fixture(options);
    const first = await addSkuLabelStock(card, setInput, f.deps);
    assert.equal(first.status, "pending"); assert.equal(first.retryable, true); assert.doesNotMatch(first.message, /secret/); assert.equal(f.available(), 4);
    f.variant.inventoryQuantity--; f.variant.inventoryItem.inventoryLevel.quantities[0].quantity--;
    const retry = await addSkuLabelStock(card, setInput, f.deps);
    assert.equal(retry.status, "complete"); assert.equal(retry.availableQuantity, 3); assert.equal(f.available(), 3); assert.equal(f.adjustments.size, 1);
    const writes = f.calls.filter(call => call.name === "QrStockSet");
    assert.ok(writes.length > 0);
    for (const write of writes) assert.deepEqual(write.variables, writes[0].variables, "Retries must retain the original comparison and idempotency key");
    assert.deepEqual(f.journals.get(linkKey), f.initial);
  }
});

test("uncertain total corrections cannot switch mode, baseline or total or be replayed after the safe window", async () => {
  for (const changed of [input, { ...setInput, expectedAvailableQuantity: 4 }, { ...setInput, quantity: 0 }]) {
    const f = fixture({ loseAdjustment: true }); await addSkuLabelStock(card, setInput, f.deps);
    const retry = await addSkuLabelStock(card, changed, f.deps);
    assert.equal(retry.status, "pending"); assert.equal(retry.retryable, false); assert.equal(f.calls.filter(call => call.name === "QrStockSet").length, 1); assert.equal(f.available(), 4);
  }
  const f = fixture({ loseAdjustment: true }); await addSkuLabelStock(card, setInput, f.deps); f.advance(23 * 60 * 60 * 1000);
  const expired = await addSkuLabelStock(card, setInput, f.deps);
  assert.equal(expired.status, "pending"); assert.equal(expired.retryable, false); assert.equal(f.calls.filter(call => call.name === "QrStockSet").length, 1);
});

test("an uncertain correction receiving a later stale error stays pending until Shopify confirms the original result", async () => {
  const f = fixture({ loseAdjustment: true }); await addSkuLabelStock(card, setInput, f.deps);
  f.options.reject = true; f.options.rejectionCode = "CHANGE_FROM_QUANTITY_STALE";
  const replay = await addSkuLabelStock(card, setInput, f.deps);
  assert.equal(replay.status, "pending"); assert.equal(replay.retryable, true); assert.equal(f.available(), 4);
  f.options.reject = false;
  assert.equal((await addSkuLabelStock(card, setInput, f.deps)).status, "complete"); assert.equal(f.adjustments.size, 1);
});

test("legacy add receipts can resume with explicit add mode and cannot be repurposed as a total correction", async () => {
  for (const loseAdjustment of [false, true]) {
    const f = fixture({ loseAdjustment }); await addSkuLabelStock(card, input, f.deps);
    const existing = JSON.parse(f.journals.get(`qr_stock_${digest(input.requestId).slice(0, 55)}`)!.value);
    assert.equal(existing.mode, undefined); assert.equal(existing.expectedAvailableQuantity, undefined);
    const attemptedSet = await addSkuLabelStock(card, { ...setInput, quantity: input.quantity }, f.deps);
    assert.equal(attemptedSet.status, "pending"); assert.equal(attemptedSet.retryable, false);
    const resumed = await addSkuLabelStock(card, { ...input, mode: "add" }, f.deps);
    assert.equal(resumed.status, "complete"); assert.equal(f.available(), 7); assert.equal(f.adjustments.size, 1);
    assert.equal(f.calls.filter(call => call.name === "QrStockSet").length, 0);
  }
});

test("add stock uses one distinct additive receipt and leaves card details and initial receipt untouched", async () => {
  const f = fixture(); const before = clone(f.variant);
  const response = await addSkuLabelStock(card, input, f.deps);
  assert.equal(response.status, "complete"); assert.equal(response.availableQuantity, 7); assert.equal(f.available(), 7);
  assert.equal(f.adjustments.size, 1); assert.deepEqual(f.journals.get(linkKey), f.initial);
  assert.deepEqual({ ...f.variant, inventoryQuantity: before.inventoryQuantity, inventoryItem: { ...f.variant.inventoryItem, inventoryLevel: before.inventoryItem.inventoryLevel } }, before);
  assert.deepEqual([...new Set(f.calls.filter(call => call.name.startsWith("QrStock") && call.name === "QrStockReceive").map(call => call.name))], ["QrStockReceive"]);
  assert.equal((await addSkuLabelStock(card, input, f.deps)).availableQuantity, 7);
  assert.equal(f.calls.filter(call => call.name === "QrStockReceive").length, 1);
  const next = await addSkuLabelStock(card, second, f.deps); assert.equal(next.availableQuantity, 10); assert.equal(f.adjustments.size, 2);
});

test("concurrent submissions of the same receipt add stock exactly once", async () => {
  const f = fixture();
  const results = await Promise.all([addSkuLabelStock(card, input, f.deps), addSkuLabelStock(card, input, f.deps)]);
  assert.ok(results.some(result => result.status === "complete"));
  assert.ok(results.every(result => ["complete", "pending"].includes(result.status)));
  assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "complete");
  assert.equal(f.available(), 7); assert.equal(f.adjustments.size, 1);
});

test("concurrent submissions of one total correction apply once and a competing baseline cannot overwrite it", async () => {
  const f = fixture();
  const sameRequest = await Promise.all([addSkuLabelStock(card, setInput, f.deps), addSkuLabelStock(card, setInput, f.deps)]);
  assert.ok(sameRequest.some(result => result.status === "complete"));
  assert.ok(sameRequest.every(result => ["complete", "pending"].includes(result.status)));
  assert.equal(f.available(), 4); assert.equal(f.adjustments.size, 1);
  const competing = await addSkuLabelStock(card, { ...setInput, requestId: second.requestId, quantity: 10 }, f.deps);
  assert.equal(competing.status, "rejected"); assert.equal(f.available(), 4); assert.equal(f.adjustments.size, 1);
  assert.equal((await addSkuLabelStock(card, setInput, f.deps)).status, "complete");
});

test("a ready zero-starting-stock QR can receive its first explicit additional quantity", async () => {
  const f = fixture();
  const journal = JSON.parse(f.journals.get(linkKey)!.value); journal.initialQuantity = 0; delete journal.adjustmentId;
  f.journals.set(linkKey, { value: JSON.stringify(journal), compareDigest: "zero" });
  const original = clone(f.journals.get(linkKey));
  f.variant.inventoryQuantity = 0; f.variant.inventoryItem.inventoryLevel.quantities[0].quantity = 0;
  const result = await addSkuLabelStock({ ...card, quantity: 0, initialQuantity: 0 }, input, f.deps);
  assert.equal(result.status, "complete"); assert.equal(result.availableQuantity, 5); assert.equal(f.adjustments.size, 1);
  assert.deepEqual(f.journals.get(linkKey), original);
});

test("a completed receipt reports current availability after a sale without restoring sold stock", async () => {
  const f = fixture(); await addSkuLabelStock(card, input, f.deps);
  f.variant.inventoryQuantity--; f.variant.inventoryItem.inventoryLevel.quantities[0].quantity--;
  const replay = await addSkuLabelStock(card, input, f.deps);
  assert.equal(replay.status, "complete"); assert.equal(replay.availableQuantity, 6);
  assert.equal(f.available(), 6); assert.equal(f.calls.filter(call => call.name === "QrStockReceive").length, 1);
  assert.deepEqual(f.journals.get(linkKey), f.initial);
});

test("lost stock or completion responses retry the same receipt without duplicate quantity", async () => {
  for (const options of [{ loseAdjustment: true }, { loseCompletion: true }]) {
    const f = fixture(options);
    const first = await addSkuLabelStock(card, input, f.deps);
    assert.equal(first.status, "pending"); assert.equal(first.retryable, true); assert.doesNotMatch(first.message, /secret/);
    assert.equal(f.available(), 7);
    const retry = await addSkuLabelStock(card, input, f.deps);
    assert.equal(retry.status, "complete"); assert.equal(retry.availableQuantity, 7); assert.equal(f.adjustments.size, 1);
    const keys = f.calls.filter(call => call.name === "QrStockReceive").map(call => call.variables.key);
    assert.equal(new Set(keys).size, 1); assert.deepEqual(f.journals.get(linkKey), f.initial);
  }
});

test("an uncertain stock receipt is never replayed after 23 hours", async () => {
  const f = fixture({ loseAdjustment: true });
  await addSkuLabelStock(card, input, f.deps); f.advance(23 * 60 * 60 * 1000);
  const retry = await addSkuLabelStock(card, input, f.deps);
  assert.equal(retry.status, "pending"); assert.equal(retry.retryable, false); assert.match(retry.message, /window expired/);
  assert.equal(f.calls.filter(call => call.name === "QrStockReceive").length, 1); assert.equal(f.available(), 7);
});

test("a damaged existing receipt cannot be mistaken for a new stock request", async () => {
  for (const value of ["null", "false", "0", "[]", "{}", '""']) {
    const f = fixture(); f.journals.set(`qr_stock_${digest(input.requestId).slice(0, 55)}`, { value, compareDigest: "damaged" });
    const result = await addSkuLabelStock(card, input, f.deps);
    assert.equal(result.status, "pending"); assert.equal(result.retryable, false); assert.equal(f.adjustments.size, 0); assert.equal(f.available(), 2);
  }
});

test("a reused request cannot change quantity, saved product, identity or location", async () => {
  for (const kind of ["quantity", "product", "identity", "location"] as const) {
    const f = fixture({ loseAdjustment: true }); await addSkuLabelStock(card, input, f.deps);
    if (kind === "location") f.deps.settings.locationId = "gid://shopify/Location/2";
    const result = await addSkuLabelStock({ ...card, ...(kind === "product" ? { id: 78 } : {}), ...(kind === "identity" ? { condition: "Lightly Played" } : {}) }, { ...input, ...(kind === "quantity" ? { quantity: 8 } : {}) }, f.deps);
    assert.equal(result.status, "pending"); assert.equal(result.retryable, false);
    assert.equal(f.calls.filter(call => call.name === "QrStockReceive").length, 1); assert.equal(f.available(), 7);
  }
});

test("stock requires a completed initial link, exact live variant identity, unique QR and ready POS location", async () => {
  for (const request of [input, setInput]) for (const change of ["initial", "condition", "barcode", "duplicate", "location", "publication", "source", "price"] as const) {
    const f = fixture({ duplicate: change === "duplicate" });
    if (change === "initial") { const journal = JSON.parse(f.journals.get(linkKey)!.value); delete journal.adjustmentId; f.journals.set(linkKey, { value: JSON.stringify(journal), compareDigest: "changed" }); }
    if (change === "condition") f.variant.selectedOptions[0].value = "Lightly Played";
    if (change === "barcode") f.variant.barcodes.nodes = [{ value: "other", type: null }];
    if (change === "location") f.variant.inventoryItem.inventoryLevel.location.id = "gid://shopify/Location/2";
    if (change === "publication") f.variant.pos = false;
    if (change === "source") f.variant.product.sourceId.value = "999";
    if (change === "price") f.variant.price = "0.00";
    const result = await addSkuLabelStock(card, request, f.deps);
    assert.equal(result.status, "pending"); assert.equal(f.adjustments.size, 0); assert.equal(f.available(), 2);
    assert.equal(f.calls.filter(call => ["QrStockSet", "QrStockReceive"].includes(call.name)).length, 0);
  }
});

test("an explicit Shopify rejection is durable and cannot later receive stock with the same request", async () => {
  const f = fixture({ reject: true });
  assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "rejected");
  f.options.reject = false;
  assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "rejected");
  assert.equal(f.available(), 2); assert.equal(f.calls.filter(call => call.name === "QrStockReceive").length, 1);
});

test("Shopify idempotency and replay errors never become a false no-stock rejection", async () => {
  for (const code of ["IDEMPOTENCY_CONCURRENT_REQUEST", "IDEMPOTENCY_KEY_PARAMETER_MISMATCH", "LOCATION_NOT_FOUND", "INVALID"]) {
    const f = fixture({ loseAdjustment: true });
    assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "pending"); assert.equal(f.available(), 7);
    f.options.reject = true; f.options.rejectionCode = code;
    const replay = await addSkuLabelStock(card, input, f.deps);
    assert.equal(replay.status, "pending"); assert.equal(f.available(), 7);
    f.options.reject = false;
    assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "complete"); assert.equal(f.available(), 7); assert.equal(f.adjustments.size, 1);
  }
  const first = fixture({ reject: true, rejectionCode: "IDEMPOTENCY_CONCURRENT_REQUEST" });
  assert.equal((await addSkuLabelStock(card, input, first.deps)).status, "pending");
});

test("completed receipts remain complete when later catalog changes prevent an availability refresh", async () => {
  const f = fixture(); await addSkuLabelStock(card, input, f.deps); f.variant.selectedOptions[0].value = "Lightly Played";
  const retry = await addSkuLabelStock(card, input, f.deps);
  assert.equal(retry.status, "complete"); assert.equal(retry.availableQuantity, undefined); assert.equal(f.adjustments.size, 1);
});

test("a failed preflight cannot claim terminal rejection while a concurrent request may receive stock", async () => {
  const f = fixture(); const original = f.deps.graphql;
  let first = true;
  const failed: SkuLabelShopifyDependencies = { ...f.deps, graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    if (query.includes("query QrStockConnection") && first) {
      first = false;
      assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "complete");
      return { shop: { myshopifyDomain: f.deps.settings.shop }, location: { id: location, isActive: false }, currentAppInstallation: { accessScopes: [] } } as T;
    }
    return original<T>(query, variables);
  } };
  const result = await addSkuLabelStock(card, input, failed);
  assert.equal(result.status, "pending"); assert.equal(result.retryable, true); assert.equal(f.available(), 7);
  assert.equal((await addSkuLabelStock(card, input, f.deps)).status, "complete");
});
