import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { decodeCursor, encodeCursor, hasSyncOrigin, INVENTORY_RECONCILE_PATTERNS, parseDelivery, processDelivery, readBoundedBody, shouldApplyProjection, syncOrdersEnabled, syncTopics, verifyWebhookHmac, type Delivery, type Projection, type SyncBatch, type SyncStore } from "../lib/shopify/sync-core.ts";
import { fetchDeliverySnapshot, fetchReconcilePage } from "../lib/shopify/snapshots.ts";
import { configBlockers, type ReadGraphQL } from "../lib/shopify/read-client.ts";

const shop = "defy-receiving-test.myshopify.com";
const location = "gid://shopify/Location/1";
const older = "2026-09-18T00:00:00.000Z";
const newer = "2026-09-18T00:01:00.000Z";
const delivery: Delivery = { id: "inventory_levels/update:event-one", topic: "inventory_levels/update", resourceId: "gid://shopify/InventoryItem/1", locationId: location, triggeredAt: newer };
function inventoryItem(available: number, version = newer) {
  return { id: delivery.resourceId, tracked: true,
    variant: { id: "gid://shopify/ProductVariant/1", title: "Near Mint / Foil", sku: "DEFY-1", barcode: "DEFY-QR-1", price: "3.50", updatedAt: older,
      product: { id: "gid://shopify/Product/1", title: "Defy", handle: "defy", status: "ACTIVE", updatedAt: older } },
    inventoryLevel: { updatedAt: version, quantities: [{ name: "available", quantity: available }, { name: "on_hand", quantity: available + 2 }, { name: "committed", quantity: 2 }] } };
}
function stock(quantity: number, version = newer, observedAt = newer): Projection {
  return { kind: "inventory", id: "item@location", parentId: "variant", sourceUpdatedAt: version, observedAt, data: { available: quantity }, deleted: false };
}
class MemoryStore implements SyncStore {
  deliveries = new Set<string>();
  rows = new Map<string, Projection>();
  legacyQuantity = 17;
  failNext = false;
  async hasDelivery(_shop: string, id: string) { return this.deliveries.has(id); }
  async apply(_shop: string, event: Delivery, batch: SyncBatch) {
    if (this.deliveries.has(event.id)) return false;
    if (this.failNext) { this.failNext = false; throw new Error("Database write failed"); }
    for (const row of batch.projections) if (shouldApplyProjection(this.rows.get(row.id), row)) this.rows.set(row.id, row);
    this.deliveries.add(event.id);
    return true;
  }
}
test("Shopify signature validates exact raw bytes and rejects tampering, malformed signatures, and wrong secrets", () => {
  const raw = Buffer.from('{"id":123,"title":"Blitzcrank, Impassive"}');
  const signature = createHmac("sha256", "test-secret").update(raw).digest("base64");
  assert.equal(verifyWebhookHmac(raw, signature, "test-secret"), true);
  assert.equal(verifyWebhookHmac(Buffer.from(raw.toString().replace("123", "124")), signature, "test-secret"), false);
  assert.equal(verifyWebhookHmac(Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2)), signature, "test-secret"), false);
  for (const invalid of [null, "", "abc", `${signature}extra`]) assert.equal(verifyWebhookHmac(raw, invalid, "test-secret"), false);
  assert.equal(verifyWebhookHmac(raw, signature, "wrong"), false);
});
test("streamed webhook body limits work without Content-Length", async () => {
  const request = new Request("https://example.com", { method: "POST", body: "x".repeat(20) });
  await assert.rejects(readBoundedBody(request, 10), /too large/);
});
test("webhook envelope requires expected shop, safe IDs, timestamp and event ID; strips customer fields", () => {
  const headers = new Headers({ "x-shopify-shop-domain": shop, "x-shopify-topic": "orders/updated", "x-shopify-event-id": "event-12345678", "x-shopify-triggered-at": newer });
  const result = parseDelivery(headers, { id: 456, customer: { email: "private@example.com" }, note: "private" }, shop);
  assert.deepEqual(result, { id: "orders/updated:event-12345678:gid://shopify/Order/456", topic: "orders/updated", resourceId: "gid://shopify/Order/456", triggeredAt: newer });
  assert.throws(() => parseDelivery(headers, { id: 456 }, "untrusted.myshopify.com"), /Unexpected/);
  assert.throws(() => parseDelivery(headers, { id: Number.MAX_SAFE_INTEGER + 1 }, shop), /valid Order/);
  headers.delete("x-shopify-event-id");
  assert.throws(() => parseDelivery(headers, { id: 456 }, shop), /event ID/);
});
test("duplicates and different order events do not double-decrement inventory or touch legacy quantities", async () => {
  const store = new MemoryStore();
  let reads = 0;
  const fetchSnapshot = async () => { reads++; return { projections: [stock(5)], replaceChildren: [] }; };
  await processDelivery(shop, delivery, store, fetchSnapshot);
  assert.deepEqual(await processDelivery(shop, delivery, store, fetchSnapshot), { duplicate: true });
  await processDelivery(shop, { ...delivery, id: "paid-event", topic: "orders/paid" }, store, fetchSnapshot);
  assert.equal(reads, 2);
  assert.equal(store.rows.get("item@location")?.data.available, 5);
  assert.equal(store.legacyQuantity, 17);
});
test("older source versions and equal-version earlier observations cannot overwrite new snapshots; tombstones win ties", () => {
  const current = stock(3, newer, newer);
  assert.equal(shouldApplyProjection(current, stock(10, older, "2026-09-18T01:00:00Z")), false);
  assert.equal(shouldApplyProjection(current, stock(10, newer, older)), false);
  const tombstone = { ...current, deleted: true };
  assert.equal(shouldApplyProjection(current, tombstone), true);
  assert.equal(shouldApplyProjection(tombstone, stock(10, newer, "2026-09-18T01:00:00Z")), false);
});
test("remote fetch and DB failures leave delivery retryable", async () => {
  const store = new MemoryStore();
  await assert.rejects(processDelivery(shop, delivery, store, async () => { throw new Error("throttled"); }), /throttled/);
  assert.equal(await store.hasDelivery(shop, delivery.id), false);
  store.failNext = true;
  const fetchSnapshot = async () => ({ projections: [stock(4)], replaceChildren: [] });
  await assert.rejects(processDelivery(shop, delivery, store, fetchSnapshot), /Database/);
  assert.equal(await store.hasDelivery(shop, delivery.id), false);
  await processDelivery(shop, delivery, store, fetchSnapshot);
  assert.equal(store.rows.get("item@location")?.data.available, 4);
});
test("inventory webhook reads current upstream quantity and version instead of trusting event quantity", async () => {
  const graphql: ReadGraphQL = async <T>(query: string) => {
    assert.match(query, /^query /);
    assert.doesNotMatch(query, /mutation/);
    return { inventoryItem: inventoryItem(7) } as T;
  };
  const batch = await fetchDeliverySnapshot(graphql, { ...delivery, triggeredAt: older }, location);
  const level = batch.projections.find(row => row.kind === "inventory")!;
  assert.equal(level.sourceUpdatedAt, newer);
  assert.equal(level.data.available, 7);
  assert.equal(level.data.onHand, 9);
  assert.deepEqual(await fetchDeliverySnapshot(graphql, { ...delivery, locationId: "gid://shopify/Location/99" }, location), { projections: [], replaceChildren: [] });
});
test("inventory-only updates and connections hydrate their exact product and variant without a prior catalog import", async () => {
  for (const topic of ["inventory_levels/update", "inventory_levels/connect"]) {
    const item = inventoryItem(0);
    let reads = 0;
    const graphql: ReadGraphQL = async <T>(query: string, variables?: Record<string, unknown>) => {
      reads++;
      assert.deepEqual(variables, { id: item.id, locationId: location });
      assert.match(query, /id tracked variant \{ id title sku barcode price updatedAt product/);
      return { inventoryItem: item } as T;
    };
    const store = new MemoryStore();
    let batch: SyncBatch | undefined;
    await processDelivery(shop, { ...delivery, topic }, store, async () => batch = await fetchDeliverySnapshot(graphql, { ...delivery, topic }, location, false));
    assert.equal(reads, 1);
    assert.equal(store.rows.get(item.variant.product.id)?.data.title, "Defy");
    const variant = store.rows.get(item.variant.id)!;
    assert.equal(variant.parentId, item.variant.product.id);
    assert.equal(variant.data.sku, "DEFY-1");
    assert.equal(variant.data.barcode, "DEFY-QR-1");
    assert.equal(variant.data.inventoryItemId, item.id);
    assert.equal(variant.data.tracked, true);
    const level = store.rows.get(`${item.id}@${location}`)!;
    assert.equal(level.parentId, item.variant.id);
    assert.equal(level.data.available, 0);
    assert.equal(level.data.committed, 2);
    assert.equal(level.deleted, false);
    assert.deepEqual(batch?.replaceChildren, []);
    assert.equal(store.legacyQuantity, 17);
  }
});
test("repeated inventory snapshots preserve absolute zero and negative quantities and reject stale stock", async () => {
  const store = new MemoryStore();
  for (const [id, available, version] of [["first", 7, older], ["zero", 0, newer], ["stale", 12, older], ["negative", -1, "2026-09-18T00:02:00.000Z"]] as const) {
    const graphql: ReadGraphQL = async <T>() => ({ inventoryItem: inventoryItem(available, version) }) as T;
    await processDelivery(shop, { ...delivery, id }, store, () => fetchDeliverySnapshot(graphql, delivery, location));
    assert.equal(store.rows.get(`${delivery.resourceId}@${location}`)?.data.available, id === "stale" ? 0 : available);
  }
  assert.equal(store.legacyQuantity, 17);
});
test("unreadable inventory parents and mismatched item identities leave updates retryable", async () => {
  for (const item of [{ ...inventoryItem(7), variant: null }, { ...inventoryItem(7), id: "gid://shopify/InventoryItem/99" }]) {
    const graphql: ReadGraphQL = async <T>() => ({ inventoryItem: item }) as T;
    const store = new MemoryStore();
    await assert.rejects(processDelivery(shop, delivery, store, () => fetchDeliverySnapshot(graphql, delivery, location)), /not readable|identity/);
    assert.equal(await store.hasDelivery(shop, delivery.id), false);
    assert.equal(store.rows.size, 0);
  }
});
test("non-delete unavailable objects retry; confirmed deletion produces a tombstone", async () => {
  const graphql: ReadGraphQL = async <T>() => ({ product: null }) as T;
  const event = { ...delivery, resourceId: "gid://shopify/Product/1", topic: "products/update" };
  await assert.rejects(fetchDeliverySnapshot(graphql, event, location), /not readable/);
  const batch = await fetchDeliverySnapshot(graphql, { ...event, topic: "products/delete" }, location);
  assert.equal(batch.projections[0].deleted, true);
  assert.equal(batch.projections[0].sourceUpdatedAt, newer);
});
test("reconciliation continuation is bounded and never replaces all product children with a partial page", async () => {
  const graphql: ReadGraphQL = async <T>(query: string) => {
    assert.match(query, /productVariants\(first: 25/);
    return { productVariants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "page2" } } } as T;
  };
  const page = await fetchReconcilePage(graphql, decodeCursor(null), location);
  assert.deepEqual(decodeCursor(page.nextCursor), { phase: "inventory", after: "page2" });
  assert.deepEqual(page.batch.replaceChildren, []);
  assert.equal(page.done, false);
  assert.deepEqual(decodeCursor(encodeCursor({ phase: "orders", after: null })), { phase: "orders", after: null });
  assert.throws(() => decodeCursor("bad cursor"), /Invalid sync cursor/);
});
test("orders projection retains financial state and totals, discards customer fields, and reads stock without applying sale deltas", async () => {
  const variant = { id: "gid://shopify/ProductVariant/1", title: "Near Mint / Foil / English", sku: "card-1", price: "3.50", updatedAt: newer,
    product: { id: "gid://shopify/Product/1", title: "Defy", handle: "defy", status: "ACTIVE", updatedAt: newer },
    inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true, inventoryLevel: { updatedAt: newer, quantities: [{ name: "available", quantity: 6 }] } } };
  const order = { id: "gid://shopify/Order/1", name: "#1001", createdAt: older, updatedAt: newer, cancelledAt: null, displayFinancialStatus: "PARTIALLY_REFUNDED", displayFulfillmentStatus: "FULFILLED",
    customer: { email: "private@example.com" }, currentTotalPriceSet: { shopMoney: { amount: "7.00", currencyCode: "USD" } },
    lineItems: { nodes: [{ id: "gid://shopify/LineItem/1", title: "Defy", sku: "card-1", quantity: 3, currentQuantity: 2, variant: { id: variant.id }, originalUnitPriceSet: { shopMoney: { amount: "3.50", currencyCode: "USD" } } }], pageInfo: { hasNextPage: false, endCursor: null } } };
  const graphql: ReadGraphQL = async <T>(query: string, variables?: Record<string, unknown>) => {
    if (query.includes("DefyOrderInventory")) {
      assert.deepEqual(variables?.ids, [variant.id]);
      return { nodes: [variant] } as T;
    }
    assert.doesNotMatch(query, /inventoryLevel/);
    return { order } as T;
  };
  const batch = await fetchDeliverySnapshot(graphql, { ...delivery, topic: "orders/updated", resourceId: order.id }, location);
  assert.equal(batch.projections.find(row => row.kind === "orders")?.data.financialStatus, "PARTIALLY_REFUNDED");
  assert.equal(batch.projections.find(row => row.kind === "orders")?.data.itemCount, 2);
  assert.equal(batch.projections.find(row => row.kind === "inventory")?.data.available, 6);
  assert.doesNotMatch(JSON.stringify(batch), /private@example|customer/);
  order.lineItems.pageInfo.hasNextPage = true;
  await assert.rejects(fetchDeliverySnapshot(graphql, { ...delivery, topic: "orders/updated", resourceId: order.id }, location), /no partial order/);
});
test("sync configuration restricts domains and requires explicit webhook secret and receiving location", () => {
  const settings = { enabled: false, ordersEnabled: true, shop, clientId: "id", clientSecret: "secret", webhookSecret: "secret", locationId: location };
  assert.deepEqual(configBlockers(settings), []);
  assert.equal(configBlockers({ ...settings, shop: "attacker.example" }).length, 1);
  assert.equal(configBlockers({ ...settings, webhookSecret: "", locationId: "1" }).length, 2);
});
test("manual sync requires configured production origin and a custom header", () => {
  const request = new Request("https://defy-store-os.vercel.app/api/shopify/sync", { method: "POST", headers: { origin: "https://defy-store-os.vercel.app", "x-defy-sync": "1" } });
  assert.equal(hasSyncOrigin(request, "https://defy-store-os.vercel.app", true), true);
  assert.equal(hasSyncOrigin(request, undefined, true), false);
  assert.equal(hasSyncOrigin(request, undefined, false), true);
  request.headers.set("origin", "https://attacker.example");
  assert.equal(hasSyncOrigin(request, "https://defy-store-os.vercel.app", true), false);
  request.headers.set("origin", "https://defy-store-os.vercel.app");
  request.headers.delete("x-defy-sync");
  assert.equal(hasSyncOrigin(request, "https://defy-store-os.vercel.app", true), false);
});
test("webhook delivery IDs take precedence and shared event IDs preserve distinct inventory resources", () => {
  const headers = new Headers({ "x-shopify-shop-domain": shop, "x-shopify-topic": "inventory_levels/update", "x-shopify-event-id": "shared-event", "x-shopify-triggered-at": newer });
  const first = parseDelivery(headers, { inventory_item_id: 1, location_id: 1 }, shop);
  const second = parseDelivery(headers, { inventory_item_id: 2, location_id: 1 }, shop);
  assert.notEqual(first?.id, second?.id);
  headers.set("x-shopify-webhook-id", "delivery-123456");
  assert.equal(parseDelivery(headers, { inventory_item_id: 1, location_id: 1 }, shop)?.id, "webhook:delivery-123456");
});
test("temporarily missing inventory retries unless the event is a disconnect", async () => {
  const graphql: ReadGraphQL = async <T>() => ({ inventoryItem: { ...inventoryItem(7), inventoryLevel: null } }) as T;
  await assert.rejects(fetchDeliverySnapshot(graphql, delivery, location), /not readable/);
  const batch = await fetchDeliverySnapshot(graphql, { ...delivery, topic: "inventory_levels/disconnect" }, location);
  const level = batch.projections.find(row => row.kind === "inventory")!;
  assert.equal(level.deleted, true);
  assert.equal(level.sourceUpdatedAt, delivery.triggeredAt);
  assert.equal(level.parentId, inventoryItem(7).variant.id);
  assert.deepEqual(batch.replaceChildren, []);
});
test("disconnect snapshots retain event timestamps for missing items and preserve newer reconnections", async () => {
  const event = { ...delivery, topic: "inventory_levels/disconnect" };
  const missing: ReadGraphQL = async <T>() => ({ inventoryItem: null }) as T;
  const batch = await fetchDeliverySnapshot(missing, event, location);
  assert.equal(batch.projections.length, 1);
  assert.equal(batch.projections[0].deleted, true);
  assert.equal(batch.projections[0].sourceUpdatedAt, event.triggeredAt);
  assert.equal(batch.projections[0].parentId, null);
  const stale: ReadGraphQL = async <T>() => ({ inventoryItem: inventoryItem(7) }) as T;
  await assert.rejects(fetchDeliverySnapshot(stale, event, location), /pre-disconnect/);
  const reconnectedAt = "2026-09-18T00:02:00.000Z";
  const reconnected: ReadGraphQL = async <T>() => ({ inventoryItem: inventoryItem(3, reconnectedAt) }) as T;
  const current = await fetchDeliverySnapshot(reconnected, event, location);
  const level = current.projections.find(row => row.kind === "inventory")!;
  assert.equal(level.deleted, false);
  assert.equal(level.sourceUpdatedAt, reconnectedAt);
  assert.equal(level.data.available, 3);
});
test("reconciliation identity audits recover missed product and variant deletions without trusting partial scans", async () => {
  const graphql: ReadGraphQL = async <T>() => ({ nodes: [null] }) as T;
  const page = await fetchReconcilePage(graphql, { phase: "productsAudit", after: null }, location, async () => ({ ids: ["gid://shopify/Product/1"], hasNextPage: false, endCursor: "gid://shopify/Product/1" }));
  assert.equal(page.batch.projections[0].kind, "products");
  assert.equal(page.batch.projections[0].deleted, true);
  assert.deepEqual(decodeCursor(page.nextCursor), { phase: "variantsAudit", after: null });
  const failedRead: ReadGraphQL = async () => { throw new Error("ACCESS_DENIED"); };
  await assert.rejects(fetchReconcilePage(failedRead, { phase: "productsAudit", after: null }, location, async () => ({ ids: ["gid://shopify/Product/1"], hasNextPage: false, endCursor: null })), /ACCESS_DENIED/);
});
test("large orders are durably deferred while subsequent reconciliation pages can continue", async () => {
  const graphql: ReadGraphQL = async <T>() => ({ orders: { nodes: [{ id: "gid://shopify/Order/1", updatedAt: newer, lineItems: { pageInfo: { hasNextPage: true } } }], pageInfo: { hasNextPage: true, endCursor: "next-order" } } }) as T;
  const page = await fetchReconcilePage(graphql, { phase: "orders", after: null }, location);
  assert.equal(page.batch.projections.length, 0);
  assert.equal(page.batch.deferred?.[0].resourceId, "gid://shopify/Order/1");
  assert.deepEqual(decodeCursor(page.nextCursor), { phase: "orders", after: "next-order" });
});

test("inventory-only mode is explicit and ignores order webhooks without weakening shop validation", () => {
  assert.equal(syncOrdersEnabled("false"), false);
  for (const value of ["", "true", "FALSE"]) assert.equal(syncOrdersEnabled(value), true);
  assert.equal(syncTopics().length, 11);
  assert.equal(syncTopics(false).length, 6);
  const headers = new Headers({ "x-shopify-shop-domain": shop, "x-shopify-topic": "orders/updated", "x-shopify-event-id": "event-12345678", "x-shopify-triggered-at": newer });
  assert.equal(parseDelivery(headers, { id: 456 }, shop, false), null);
  assert.throws(() => parseDelivery(headers, { id: 456 }, "other.myshopify.com", false), /Unexpected Shopify shop/);
  assert.equal(parseDelivery(headers, { id: 456 }, shop)?.topic, "orders/updated");
  headers.set("x-shopify-topic", "inventory_levels/update");
  assert.equal(parseDelivery(headers, { inventory_item_id: 1, location_id: 1 }, shop, false)?.topic, "inventory_levels/update");
});

test("inventory-only reconciliation completes after variant audits and refuses old order cursors before remote reads", async () => {
  let reads = 0;
  const graphql: ReadGraphQL = async <T>() => { reads++; return { nodes: [] } as T; };
  const audit = async () => ({ ids: [], hasNextPage: false, endCursor: null });
  const page = await fetchReconcilePage(graphql, { phase: "variantsAudit", after: null }, location, audit, false);
  assert.equal(page.done, true); assert.equal(page.nextCursor, null);
  const fullPage = await fetchReconcilePage(graphql, { phase: "variantsAudit", after: null }, location, audit);
  assert.deepEqual(decodeCursor(fullPage.nextCursor), { phase: "orders", after: null });
  for (const phase of ["orders", "ordersAudit"] as const) {
    await assert.rejects(fetchReconcilePage(graphql, { phase, after: "old-page" }, location, audit, false), /Order sync is disabled/);
  }
  await assert.rejects(fetchDeliverySnapshot(graphql, { ...delivery, topic: "orders/updated" }, location, false), /remains pending/);
  assert.equal(reads, 0);
});

test("inventory cursor filters accept canonical inventory pages and exclude pending order pages", () => {
  for (const phase of ["inventory", "productsAudit", "variantsAudit", "orders", "ordersAudit"] as const) {
    for (const after of [null, "next-page", "unicode-次のページ"]) {
      const encoded = encodeCursor({ phase, after });
      assert.equal(encodeCursor({ after, phase }), encoded);
      assert.equal(INVENTORY_RECONCILE_PATTERNS.some(pattern => encoded.startsWith(pattern.slice(0, -1))), !phase.startsWith("orders"));
    }
  }
});

test("inventory snapshots preserve Shopify barcode and tracking without writing a legacy balance", async () => {
  const graphql: ReadGraphQL = async <T>(query: string) => {
    assert.match(query, /sku barcode price/);
    return { productVariants: { nodes: [{ id: "variant1", title: "Default Title", sku: "DEFY-1", barcode: "0196214150478", price: "36.38", updatedAt: newer,
      product: { id: "product1", title: "Bundle", handle: "bundle", status: "ACTIVE", updatedAt: newer },
      inventoryItem: { id: "item1", tracked: true, inventoryLevel: { updatedAt: newer, quantities: [{ name: "available", quantity: 3 }, { name: "on_hand", quantity: 5 }, { name: "committed", quantity: 2 }] } },
    }], pageInfo: { hasNextPage: false, endCursor: null } } } as T;
  };
  const page = await fetchReconcilePage(graphql, { phase: "inventory", after: null }, location, undefined, false);
  const variant = page.batch.projections.find(row => row.kind === "variants")!;
  assert.equal(variant.data.barcode, "0196214150478"); assert.equal(variant.data.tracked, true);
  const level = page.batch.projections.find(row => row.kind === "inventory")!;
  assert.equal(level.data.available, 3); assert.equal(level.data.onHand, 5); assert.equal(level.data.committed, 2);
  assert.deepEqual(decodeCursor(page.nextCursor), { phase: "productsAudit", after: null });
});
