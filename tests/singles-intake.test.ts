import assert from "node:assert/strict";
import test from "node:test";
import { previewSingles, receiveSingles, SinglesError, type PlannedSingle, type ReceiptRow, type SingleProduct, type SinglesAdapter, type SinglesContext, type SinglesReceiveInput, type Snapshot } from "../lib/singles/intake.ts";
import { ShopifySinglesAdapter, type SinglesGraphQL } from "../lib/singles/shopify.ts";
import type { Catalog, SinglesIntakeRow } from "../lib/singles/types.ts";

const catalog: Catalog = { fetchedAt: "2026-09-16", sourceUpdatedAt: "2026-09-16", warnings: [], cards: [
  { key: "101:Normal", productId: 101, groupId: 7, name: "Test Card", setName: "Origins", setCode: "OGN", number: "001", rarity: "Rare", finish: "Normal", language: "English", imageUrl: "", productUrl: "", marketCents: 500 },
  { key: "101:Foil", productId: 101, groupId: 7, name: "Test Card", setName: "Origins", setCode: "OGN", number: "001", rarity: "Rare", finish: "Foil", language: "English", imageUrl: "", productUrl: "", marketCents: 800 },
] };
const row: SinglesIntakeRow = { cardKey: "101:Normal", condition: "Near Mint", quantity: 3, costCents: 100, priceCents: 500 };
const request = (suffix = "first", rows = [row], publish = false): SinglesReceiveInput => ({ requestId: `receipt-test-${suffix.padEnd(6, "0")}`, rows, publish });
const copy = <T>(value: T): T => structuredClone(value);

class FakeAdapter implements SinglesAdapter {
  records = new Map<string, { value: unknown; digest: string }>();
  context: SinglesContext = { shopId: "shop", shop: "test", locationId: "location", locationName: "Test", currencyCode: "USD", receivingNamespace: "app--1--receiving", publicationIds: ["online", "pos"] };
  products = new Map<string, SingleProduct>();
  adjustments = new Map<string, string>();
  stock = new Map<string, number>();
  clock = Date.UTC(2026, 8, 16);
  writes = 0;
  adjustCalls = 0;
  metadataCalls = 0;
  publishCalls = 0;
  canPublish = true;
  loseAdjustmentResponse = false;
  loseCreationResponse = false;
  loseCompleteResponse = false;
  failUnlock = false;
  failPublish = false;
  pauseResolve: (() => Promise<void>) | null = null;
  pausePreflight: (() => Promise<void>) | null = null;
  failResolveFor = "";
  rejectBeforeStock = false;
  rejectAdjustment = false;
  async preflight(publish: boolean) { if (this.pausePreflight) await this.pausePreflight(); if (publish && !this.canPublish) throw new SinglesError("CONNECTION_BLOCKED", "Publication permission missing."); return copy(this.context); }
  async now() { return this.clock; }
  async read<T>(key: string): Promise<Snapshot<T>> { const item = this.records.get(key); return item ? { value: copy(item.value) as T, digest: item.digest } : { value: null, digest: null }; }
  async cas<T>(key: string, snapshot: Snapshot<T>, value: T) {
    if ((this.records.get(key)?.digest ?? null) !== snapshot.digest) return false;
    const object = value as { status?: string; requestId?: string; owner?: string | null };
    if (key === "intake_journal_v1" && object.owner === null && this.failUnlock) throw new Error("lost unlock");
    this.records.set(key, { value: copy(value), digest: `${++this.writes}` });
    if (object.status === "complete" && this.loseCompleteResponse) { this.loseCompleteResponse = false; throw new Error("lost complete response"); }
    return true;
  }
  async resolve(planned: PlannedSingle, _context: SinglesContext, previous?: SingleProduct) {
    if (this.pauseResolve) await this.pauseResolve();
    if (planned.cardKey === this.failResolveFor) throw new SinglesError("PRODUCT_IDENTITY_CONFLICT", "Needs identity review.", false, true);
    if (this.rejectBeforeStock) throw new SinglesError("PRICE_REQUIRED", "Active cards require a sale price.");
    let product = this.products.get(planned.catalogId);
    if (!product) { product = { productId: `p-${this.products.size}`, variantId: `v-${this.products.size}`, inventoryItemId: `i-${this.products.size}`, sku: planned.sku }; this.products.set(planned.catalogId, product); }
    if (this.loseCreationResponse) { this.loseCreationResponse = false; throw new SinglesError("SHOPIFY_UNAVAILABLE", "Creation response was lost.", true, true); }
    if (previous) assert.deepEqual(previous, product);
    return copy(product);
  }
  async metadata() { this.metadataCalls++; }
  async activate() {}
  async adjust(planned: ReceiptRow, _context: SinglesContext, requestId: string, index: number) {
    this.adjustCalls++;
    if (this.rejectAdjustment) throw new SinglesError("ADJUSTMENT_REJECTED", "Inventory item cannot be adjusted.");
    const key = `${requestId}:${index}`;
    if (!this.adjustments.has(key)) {
      this.adjustments.set(key, `adjustment-${key}`);
      this.stock.set(planned.sku, (this.stock.get(planned.sku) ?? 0) + planned.quantity);
    }
    if (this.loseAdjustmentResponse) { this.loseAdjustmentResponse = false; throw new SinglesError("SHOPIFY_UNAVAILABLE", "Lost response.", true, true); }
    return this.adjustments.get(key)!;
  }
  async publish() { this.publishCalls++; if (this.failPublish) throw new SinglesError("SHOPIFY_UNAVAILABLE", "Publication interrupted.", true, true); }
}

test("singles validation separates finish and condition and rejects duplicates / malformed money", () => {
  const planned = previewSingles([row, { ...row, cardKey: "101:Foil" }, { ...row, condition: "Lightly Played" }], catalog);
  assert.equal(new Set(planned.rows.map(item => item.sku)).size, 3);
  assert.equal(new Set(planned.rows.map(item => item.catalogId)).size, 3);
  assert.equal(planned.totalQuantity, 9);
  assert.throws(() => previewSingles([row, row], catalog), { code: "DUPLICATE_IDENTITY" });
  for (const changed of [{ quantity: -1 }, { quantity: 1.5 }, { costCents: NaN }, { priceCents: -1 }, { cardKey: "missing" }, { condition: "__proto__" }]) assert.throws(() => previewSingles([{ ...row, ...changed }], catalog));
});

test("a retry after Shopify accepted the delta adds stock exactly once", async () => {
  const adapter = new FakeAdapter();
  adapter.loseAdjustmentResponse = true;
  const first = await receiveSingles(request(), catalog, adapter);
  assert.equal(first.status, "pending");
  assert.equal(first.rows[0].received, false);
  assert.equal(first.error?.uncertain, true);
  const second = await receiveSingles(request(), catalog, adapter);
  assert.equal(second.status, "complete");
  assert.equal(adapter.stock.get(second.rows[0].sku), 3);
  assert.equal(adapter.products.size, 1);
  const calls = adapter.adjustCalls;
  assert.equal((await receiveSingles(request(), catalog, adapter)).status, "complete");
  assert.equal(adapter.adjustCalls, calls);
});

test("product creation that loses its response resolves the same identity on retry", async () => {
  const adapter = new FakeAdapter(); adapter.loseCreationResponse = true;
  const first = await receiveSingles(request(), catalog, adapter);
  assert.equal(first.status, "pending"); assert.equal(adapter.products.size, 1); assert.equal(adapter.adjustCalls, 0);
  const second = await receiveSingles(request(), catalog, adapter);
  assert.equal(second.status, "complete"); assert.equal(adapter.products.size, 1); assert.equal(adapter.adjustCalls, 1);
});

test("uncertain adjustments older than 23 hours are blocked without a second stock write", async () => {
  const adapter = new FakeAdapter(); adapter.loseAdjustmentResponse = true;
  await receiveSingles(request(), catalog, adapter);
  adapter.clock += 23 * 60 * 60 * 1000;
  const retry = await receiveSingles(request(), catalog, adapter);
  assert.equal(retry.error?.code, "RETRY_WINDOW_EXPIRED");
  assert.equal(retry.error?.retryable, false);
  assert.equal(adapter.adjustCalls, 1);
});

test("a saved request rejects changed payload and recovers against its frozen catalog card", async () => {
  const adapter = new FakeAdapter(); adapter.loseAdjustmentResponse = true;
  await receiveSingles(request(), catalog, adapter);
  await assert.rejects(receiveSingles(request("first", [{ ...row, quantity: 4 }]), catalog, adapter), { code: "REQUEST_CONFLICT" });
  const recovered = await receiveSingles(request(), { ...catalog, cards: [] }, adapter);
  assert.equal(recovered.status, "complete");
  assert.equal(adapter.stock.get(recovered.rows[0].sku), 3);
});

test("publication permission and positive-price checks save terminal rejection without product or stock writes", async () => {
  const adapter = new FakeAdapter(); adapter.canPublish = false;
  const missingScope = await receiveSingles(request("publish", [row], true), catalog, adapter);
  assert.equal(missingScope.status, "rejected"); assert.equal(missingScope.error?.code, "CONNECTION_BLOCKED");
  assert.equal(adapter.products.size, 0); assert.equal(adapter.adjustCalls, 0);
  const zeroPrice = await receiveSingles(request("zero", [{ ...row, priceCents: 0 }], true), catalog, adapter);
  assert.equal(zeroPrice.status, "rejected"); assert.equal(zeroPrice.error?.code, "PRICE_REQUIRED");
  assert.equal(adapter.products.size, 0); assert.equal(adapter.adjustCalls, 0);
  assert.equal((await receiveSingles(request("draft"), catalog, adapter)).status, "complete");
  assert.equal(adapter.publishCalls, 0);
});

test("a catalog card removed before reservation is durably rejected and its request can never receive later", async () => {
  const adapter = new FakeAdapter();
  const first = await receiveSingles(request(), { ...catalog, cards: [] }, adapter);
  assert.equal(first.status, "rejected"); assert.equal(first.requestId, request().requestId);
  assert.equal(first.error?.code, "UNKNOWN_CARD"); assert.equal(first.error?.uncertain, false);
  assert.equal(adapter.products.size, 0); assert.equal(adapter.adjustCalls, 0);
  assert.equal((await receiveSingles(request(), catalog, adapter)).status, "rejected");
  assert.equal(adapter.adjustCalls, 0);
  assert.equal((await receiveSingles(request("corrected"), catalog, adapter)).status, "complete");
});

test("a preflight rejection fences a concurrent worker before any product or stock mutations", async () => {
  const adapter = new FakeAdapter();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const began = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  adapter.pausePreflight = async () => { started(); await blocked; };
  const first = receiveSingles(request(), catalog, adapter);
  await began;
  assert.equal((await receiveSingles(request(), { ...catalog, cards: [] }, adapter)).status, "rejected");
  release();
  assert.equal((await first).status, "rejected");
  assert.equal(adapter.products.size, 0); assert.equal(adapter.adjustCalls, 0);
  adapter.pausePreflight = null;
  assert.equal((await receiveSingles(request("next"), catalog, adapter)).status, "complete");
});

test("scopes lost after stock uncertainty never turn an existing receipt into a safe rejection", async () => {
  const adapter = new FakeAdapter(); adapter.loseAdjustmentResponse = true;
  const input = request("publishing", [row], true);
  assert.equal((await receiveSingles(input, catalog, adapter)).status, "pending");
  adapter.canPublish = false;
  await assert.rejects(receiveSingles(input, catalog, adapter), { code: "CONNECTION_BLOCKED" });
  adapter.canPublish = true;
  assert.equal((await receiveSingles(input, catalog, adapter)).status, "complete");
  assert.equal([...adapter.stock.values()][0], 3);
});

test("interrupted publication reports received stock and retries publishing without another adjustment", async () => {
  const adapter = new FakeAdapter(); adapter.failPublish = true;
  const input = request("publish", [row], true);
  const first = await receiveSingles(input, catalog, adapter);
  assert.equal(first.status, "pending"); assert.equal(first.rows[0].received, true); assert.equal(first.rows[0].published, false);
  adapter.clock += 25 * 60 * 60 * 1000; adapter.failPublish = false;
  const second = await receiveSingles(input, catalog, adapter);
  assert.equal(second.status, "complete"); assert.equal(second.rows[0].published, true);
  assert.equal(adapter.adjustCalls, 1);
});

test("partial batch records completed rows and does not repeat them on retry", async () => {
  const adapter = new FakeAdapter(); adapter.failResolveFor = "101:Foil";
  const input = request("batch", [row, { ...row, cardKey: "101:Foil" }]);
  const first = await receiveSingles(input, catalog, adapter);
  assert.equal(first.status, "pending"); assert.equal(first.completedRows, 1);
  adapter.failResolveFor = "";
  const second = await receiveSingles(input, catalog, adapter);
  assert.equal(second.status, "complete"); assert.equal(second.completedRows, 2); assert.equal(adapter.adjustCalls, 2);
});

test("concurrent execution of a request is fenced by its durable lease", async () => {
  const adapter = new FakeAdapter();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const began = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  adapter.pauseResolve = async () => { started(); await blocked; };
  const first = receiveSingles(request(), catalog, adapter);
  await began;
  await assert.rejects(receiveSingles(request(), catalog, adapter), { code: "RECEIPT_BUSY" });
  await assert.rejects(receiveSingles(request("other"), catalog, adapter), { code: "OTHER_RECEIPT_PENDING" });
  release(); assert.equal((await first).status, "complete"); assert.equal(adapter.adjustCalls, 1);
});

test("lost completion / unlock responses recover without leaving the next intake blocked", async () => {
  const adapter = new FakeAdapter(); adapter.loseCompleteResponse = true; adapter.failUnlock = true;
  assert.equal((await receiveSingles(request(), catalog, adapter)).status, "complete");
  adapter.failUnlock = false;
  assert.equal((await receiveSingles(request("next"), catalog, adapter)).status, "complete");
  assert.equal(adapter.adjustCalls, 2);
  assert.equal([...adapter.stock.values()][0], 6);
});

test("a completed retry repairs its own stale journal lock", async () => {
  const adapter = new FakeAdapter(); adapter.failUnlock = true;
  await receiveSingles(request(), catalog, adapter);
  adapter.failUnlock = false;
  await receiveSingles(request(), catalog, adapter);
  assert.equal((adapter.records.get("intake_journal_v1")?.value as { requestId: string }).requestId, "");
  assert.equal(adapter.adjustCalls, 1);
});

test("known pre-stock rejection is durable, releases the journal, and can never apply on retry", async () => {
  const adapter = new FakeAdapter(); adapter.rejectBeforeStock = true;
  const rejected = await receiveSingles(request(), catalog, adapter);
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.error?.uncertain, false);
  assert.match(rejected.error!.message, /No stock was received/);
  adapter.rejectBeforeStock = false;
  assert.equal((await receiveSingles(request(), catalog, adapter)).status, "rejected");
  assert.equal(adapter.adjustCalls, 0);
  assert.equal((await receiveSingles(request("edited"), catalog, adapter)).status, "complete");
  assert.equal(adapter.adjustCalls, 1);
});

test("explicit stock rejection is durable despite a started timestamp and releases other receipts", async () => {
  const adapter = new FakeAdapter(); adapter.rejectAdjustment = true;
  const first = await receiveSingles(request(), catalog, adapter);
  assert.equal(first.status, "rejected"); assert.equal(first.error?.code, "ADJUSTMENT_REJECTED");
  assert.equal(first.rows[0].received, false); assert.equal(adapter.adjustments.size, 0);
  adapter.rejectAdjustment = false;
  assert.equal((await receiveSingles(request(), catalog, adapter)).status, "rejected");
  assert.equal(adapter.adjustCalls, 1);
  assert.equal((await receiveSingles(request("corrected"), catalog, adapter)).status, "complete");
  assert.equal([...adapter.stock.values()][0], 3);
});

test("old receipt cannot follow a changed Shopify location", async () => {
  const adapter = new FakeAdapter(); adapter.loseAdjustmentResponse = true;
  await receiveSingles(request(), catalog, adapter);
  adapter.context.locationId = "another-location";
  await assert.rejects(receiveSingles(request(), catalog, adapter), { code: "CONNECTION_CHANGED" });
  assert.equal(adapter.adjustCalls, 1);
});

test("damaged durable receipt fingerprint is refused before any new stock changes", async () => {
  const adapter = new FakeAdapter(); adapter.loseAdjustmentResponse = true;
  await receiveSingles(request(), catalog, adapter);
  const saved = [...adapter.records.entries()].find(([key]) => key.startsWith("r_"))!;
  const value = saved[1].value as { rows: SinglesIntakeRow[] };
  value.rows[0].quantity = 99;
  await assert.rejects(receiveSingles(request(), catalog, adapter), { code: "RECEIPT_INVALID" });
  assert.equal(adapter.adjustCalls, 1);
});

test("Shopify adapter uses additive native-idempotent inventory and never passes an absolute quantity", async () => {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const graphql: SinglesGraphQL = async <T>(query: string, variables = {}): Promise<T> => {
    calls.push({ query, variables });
    return { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "a" }, userErrors: [] } } as T;
  };
  const adapter = new ShopifySinglesAdapter(graphql, { shop: "test", locationId: "loc" }, () => Date.now());
  const planned: ReceiptRow = { ...previewSingles([row], catalog).rows[0], product: { productId: "p", variantId: "v", inventoryItemId: "i", sku: "sku" } };
  await adapter.adjust(planned, new FakeAdapter().context, "test-request", 0);
  assert.match(calls[0].query, /inventoryAdjustQuantities[\s\S]*@idempotent/);
  assert.deepEqual((calls[0].variables.input as { changes: unknown[] }).changes, [{ inventoryItemId: "i", locationId: "location", delta: 3, changeFromQuantity: null }]);
  assert.doesNotMatch(calls[0].query, /inventorySetQuantities/);
});

test("Shopify adapter distinguishes explicit stock rejection from ambiguous adjustment responses", async () => {
  let group: { id: string } | null = null;
  const graphql: SinglesGraphQL = async <T>(): Promise<T> => ({ inventoryAdjustQuantities: { inventoryAdjustmentGroup: group, userErrors: [{ message: "Item is not active at location." }] } }) as T;
  const adapter = new ShopifySinglesAdapter(graphql, { shop: "test", locationId: "loc" }, () => Date.now());
  const planned: ReceiptRow = { ...previewSingles([row], catalog).rows[0], product: { productId: "p", variantId: "v", inventoryItemId: "i", sku: "sku" } };
  await assert.rejects(adapter.adjust(planned, new FakeAdapter().context, "request", 0), { code: "ADJUSTMENT_REJECTED", uncertain: false });
  group = { id: "unexpected-adjustment" };
  await assert.rejects(adapter.adjust(planned, new FakeAdapter().context, "request", 0), { code: "ADJUSTMENT_UNCERTAIN", uncertain: true });
});

test("Shopify adapter rejects zero-price restock of an active product and does not re-draft existing stock", async () => {
  const planned = previewSingles([row], catalog).rows[0];
  const queries: string[] = [];
  const graphql: SinglesGraphQL = async <T>(query: string): Promise<T> => {
    queries.push(query);
    return { productByIdentifier: { id: "p", status: "ACTIVE", catalogId: { value: planned.catalogId }, variants: { nodes: [{ id: "v", sku: planned.sku, inventoryPolicy: "DENY", inventoryItem: { id: "i", tracked: true } }], pageInfo: { hasNextPage: false } } } } as T;
  };
  const adapter = new ShopifySinglesAdapter(graphql, { shop: "test", locationId: "loc" }, () => Date.now());
  await assert.rejects(adapter.resolve({ ...planned, priceCents: 0 }, new FakeAdapter().context), { code: "PRICE_REQUIRED" });
  assert.equal((await adapter.resolve(planned, new FakeAdapter().context)).productId, "p");
  assert.ok(queries.every(query => !query.includes("mutation")));
});
