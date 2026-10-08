import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { ShopifySyncRepository } from "../lib/shopify/repository.ts";
import type { ReadGraphQL } from "../lib/shopify/read-client.ts";
import { fetchDeliverySnapshot } from "../lib/shopify/snapshots.ts";
import { encodeCursor, type Delivery, type Projection, type SyncBatch } from "../lib/shopify/sync-core.ts";

// Explicit opt-in only; root supplies the URL of an isolated development Neon branch.
const enabled = process.env.SHOPIFY_SYNC_INTEGRATION === "1" && Boolean(process.env.SHOPIFY_SYNC_TEST_DATABASE_URL);
test("real Postgres signed stock events preserve arrivals through sales, repeated deliveries and later snapshots", { skip: !enabled }, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.SHOPIFY_SYNC_TEST_DATABASE_URL;
  const sql = neon(process.env.SHOPIFY_SYNC_TEST_DATABASE_URL!);
  const store = new ShopifySyncRepository();
  const shop = `restock-events-${randomUUID()}.invalid`, locationId = "gid://shopify/Location/1";
  const itemId = "gid://shopify/InventoryItem/1", variantId = "gid://shopify/ProductVariant/1", productId = "gid://shopify/Product/1";
  const baseline = "2026-10-08T12:00:00.000Z", arrival = "2026-10-08T12:01:00.000Z", sale = "2026-10-08T12:02:00.000Z";
  const event = (id: string, triggeredAt: string): Delivery => ({ id, topic: "inventory_levels/update", resourceId: itemId, locationId, triggeredAt });
  const enqueueCount = (id: string, available: number, eventAt: string, triggeredAt = eventAt) => store.enqueue(shop, event(id, triggeredAt), { available, eventAt, triggeredAt });
  const row = async () => (await sql.query("SELECT data FROM shopify_inventory WHERE shop=$1 AND id=$2", [shop, `${itemId}@${locationId}`]))[0].data;
  try {
    // The first snapshot is a baseline, never an invented receipt.
    await enqueueCount("bootstrap", 2, baseline);
    const lease = await store.acquire(shop, "bootstrap", false);
    assert.ok(lease);
    const projection = (kind: Projection["kind"], id: string, parentId: string | null, data: Record<string, unknown>, time = baseline): Projection =>
      ({ kind, id, parentId, data, sourceUpdatedAt: time, observedAt: time, deleted: false });
    assert.equal(await store.apply(shop, event("bootstrap", baseline), { projections: [
      projection("products", productId, null, { status: "ACTIVE", title: "Private title" }),
      projection("variants", variantId, productId, { tracked: true, sku: "PRIVATE-SKU", cost: 99 }),
      projection("inventory", `${itemId}@${locationId}`, variantId, { locationId, available: 2, onHand: 2, committed: 0 }),
    ], replaceChildren: [] }, lease.leaseToken), true);
    assert.equal((await row()).stockAddedAt, undefined);
    await enqueueCount("arrival", 5, arrival);
    await enqueueCount("sale", 2, sale); // Both events arrive before snapshot hydration.
    assert.equal((await row()).stockAddedAt, arrival);
    assert.equal((await row()).stockEventAvailable, 2);
    await enqueueCount("arrival", 999, "2026-10-08T12:03:00.000Z"); // Duplicate delivery cannot change metadata.
    await enqueueCount("late-event", 999, baseline);
    assert.equal((await row()).stockAddedAt, arrival);
    const saleLease = await store.acquire(shop, "sale", false);
    assert.ok(saleLease);
    await store.apply(shop, event("sale", sale), { projections: [projection("inventory", `${itemId}@${locationId}`, variantId,
      { locationId, available: 2, onHand: 2, committed: 0 }, sale)], replaceChildren: [] }, saleLease.leaseToken);
    assert.equal((await row()).available, 2);
    assert.equal((await row()).stockAddedAt, arrival);
    assert.equal((await row()).stockBaseline.available, 2);
    assert.equal((await row()).stockEvents.length, 2);
    // Distinct events sharing updated_at are ordered by Shopify's delivery time.
    await enqueueCount("same-second-increase", 4, sale, "2026-10-08T12:02:00.000123Z");
    await enqueueCount("same-second-sale", 1, sale, "2026-10-08T12:02:00.000456Z");
    assert.equal((await row()).stockAddedAt, sale);
    assert.equal((await row()).stockEventAvailable, 1);
    const publicRows = await store.publicRestocks(shop, locationId);
    assert.deepEqual(publicRows, [{ productId, lastRestockedAt: sale }]);
    assert.doesNotMatch(JSON.stringify(publicRows), /PRIVATE|sku|cost|available/);
    // Late receipts are replayed in source order, even after a sale's snapshot.
    const reorderedId = "gid://shopify/InventoryItem/2";
    const declinedId = "gid://shopify/InventoryItem/3";
    for (const [id, available] of [[reorderedId, 2], [declinedId, 10]] as const) {
      await sql.query(`INSERT INTO shopify_inventory(shop,id,parent_id,source_updated_at,observed_at,data)
        VALUES($1,$2,$3,$4,$4,$5::jsonb)`, [shop, `${id}@${locationId}`, variantId, baseline,
        JSON.stringify({ locationId, available, onHand: available, committed: 0 })]);
    }
    const record = (item: string, id: string, available: number, eventAt: string) =>
      store.enqueue(shop, { ...event(id, eventAt), resourceId: item }, { available, eventAt, triggeredAt: eventAt });
    await record(reorderedId, "sale-delivered-first", 2, sale);
    let reordered = (await sql.query("SELECT data FROM shopify_inventory WHERE shop=$1 AND id=$2", [shop, `${reorderedId}@${locationId}`]))[0].data;
    assert.equal(reordered.stockAddedAt, undefined);
    await record(reorderedId, "late-receipt", 5, arrival);
    reordered = (await sql.query("SELECT data FROM shopify_inventory WHERE shop=$1 AND id=$2", [shop, `${reorderedId}@${locationId}`]))[0].data;
    assert.equal(reordered.stockAddedAt, arrival);
    assert.equal(reordered.stockEventAvailable, 2);
    assert.deepEqual(reordered.stockEvents.map((entry: { available: number }) => entry.available), [5, 2]);
    await record(declinedId, "newer-sale-first", 4, sale);
    await record(declinedId, "older-sale-late", 6, arrival);
    const declined = (await sql.query("SELECT data FROM shopify_inventory WHERE shop=$1 AND id=$2", [shop, `${declinedId}@${locationId}`]))[0].data;
    assert.equal(declined.stockAddedAt, undefined);
    assert.equal(declined.stockEventAvailable, 4);
    assert.deepEqual(declined.stockEvents.map((entry: { available: number }) => entry.available), [6, 4]);
  } finally {
    for (const table of ["shopify_webhook_inbox", "shopify_inventory", "shopify_variants", "shopify_products"]) await sql.query(`DELETE FROM ${table} WHERE shop=$1`, [shop]);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
test("real Postgres count journal checkpoints preserve retained timestamp ties and prior arrivals", { skip: !enabled }, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.SHOPIFY_SYNC_TEST_DATABASE_URL;
  const sql = neon(process.env.SHOPIFY_SYNC_TEST_DATABASE_URL!);
  const store = new ShopifySyncRepository();
  const shop = `restock-checkpoint-${randomUUID()}.invalid`, locationId = "gid://shopify/Location/1";
  const itemId = "gid://shopify/InventoryItem/1", id = `${itemId}@${locationId}`;
  const baseline = "2026-10-08T12:00:00.000Z", arrival = "2026-10-08T12:01:00.000Z";
  const stockEvents = Array.from({ length: 1000 }, (_, index) => ({
    id: `event-${String(index + 1).padStart(4, "0")}`, available: index === 0 ? 5 : 4, eventAt: arrival, triggeredAt: arrival,
  }));
  const row = async () => (await sql.query("SELECT data FROM shopify_inventory WHERE shop=$1 AND id=$2", [shop, id]))[0].data;
  const record = (deliveryId: string, available: number) => store.enqueue(shop,
    { id: deliveryId, topic: "inventory_levels/update", resourceId: itemId, locationId, triggeredAt: arrival },
    { available, eventAt: arrival, triggeredAt: arrival });
  try {
    await sql.query(`INSERT INTO shopify_inventory(shop,id,parent_id,source_updated_at,observed_at,data)
      VALUES($1,$2,$3,$4,$4,$5::jsonb)`, [shop, id, "variant1", baseline, JSON.stringify({ locationId, available: 2,
      stockBaseline: { available: 2, eventAt: baseline, triggeredAt: baseline }, stockEvents })]);
    await record("event-1001", 3);
    let data = await row();
    assert.equal(data.stockEvents.length, 1000);
    assert.equal(data.stockBaseline.id, "event-0001");
    assert.equal(data.stockBaseline.available, 5);
    assert.equal(data.stockBaseline.stockAddedAt, arrival);
    assert.equal(data.stockEvents[0].id, "event-0002");
    assert.equal(data.stockAddedAt, arrival);
    await record("event-1002", 2);
    data = await row();
    assert.equal(data.stockEvents.length, 1000);
    assert.equal(data.stockBaseline.id, "event-0002");
    assert.equal(data.stockEvents[0].id, "event-0003");
    assert.equal(data.stockEventAvailable, 2);
    assert.equal(data.stockAddedAt, arrival);
    await record("event-0000", 999); // The folded prefix is outside the retained replay window.
    assert.deepEqual(await row(), data);
  } finally {
    for (const table of ["shopify_webhook_inbox", "shopify_inventory"]) await sql.query(`DELETE FROM ${table} WHERE shop=$1`, [shop]);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
test("real Postgres inventory webhooks make previously unknown stock visible and update its absolute balance", { skip: !enabled }, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.SHOPIFY_SYNC_TEST_DATABASE_URL;
  const sql = neon(process.env.SHOPIFY_SYNC_TEST_DATABASE_URL!);
  const store = new ShopifySyncRepository();
  const shop = `inventory-webhook-${randomUUID()}.invalid`;
  const locationId = "gid://shopify/Location/1";
  const itemId = "gid://shopify/InventoryItem/1";
  const variantId = "gid://shopify/ProductVariant/1";
  const productId = "gid://shopify/Product/1";
  const older = "2026-09-18T00:00:00.000Z";
  const newer = "2026-09-18T00:01:00.000Z";
  try {
    assert.equal((await store.dashboard(shop, locationId, false)).inventory.length, 0);
    for (const [id, available, updatedAt] of [["first", 6, older], ["zero", 0, newer], ["late", 9, older]] as const) {
      const delivery: Delivery = { id, topic: "inventory_levels/update", resourceId: itemId, locationId, triggeredAt: updatedAt };
      const graphql: ReadGraphQL = async <T>() => ({ inventoryItem: { id: itemId, tracked: true,
        variant: { id: variantId, title: "Default Title", sku: "DEFY-1", barcode: "DEFY-QR-1", price: "3.50", updatedAt: older,
          product: { id: productId, title: "New Shopify item", handle: "new-item", status: "ACTIVE", updatedAt: older } },
        inventoryLevel: { updatedAt, quantities: [{ name: "available", quantity: available }, { name: "on_hand", quantity: available }, { name: "committed", quantity: 0 }] } } }) as T;
      await store.enqueue(shop, delivery);
      const lease = await store.acquire(shop, id, false);
      assert.ok(lease);
      const batch = await fetchDeliverySnapshot(graphql, delivery, locationId, false);
      assert.equal(await store.apply(shop, delivery, batch, lease.leaseToken), true);
      const dashboard = await store.dashboard(shop, locationId, false);
      assert.equal(dashboard.inventory.length, 1);
      assert.equal(dashboard.inventory[0].productId, productId);
      assert.equal(dashboard.inventory[0].variantId, variantId);
      assert.equal(dashboard.inventory[0].sku, "DEFY-1");
      assert.equal(dashboard.inventory[0].barcode, "DEFY-QR-1");
      assert.equal(dashboard.inventory[0].available, id === "late" ? 0 : available);
    }
  } finally {
    for (const table of ["shopify_webhook_inbox", "shopify_inventory", "shopify_variants", "shopify_products"]) await sql.query(`DELETE FROM ${table} WHERE shop=$1`, [shop]);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
test("real Postgres sync inbox, concurrent leases, atomic rollback, version ordering, and absolute quantities", { skip: !enabled }, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.SHOPIFY_SYNC_TEST_DATABASE_URL;
  const sql = neon(process.env.SHOPIFY_SYNC_TEST_DATABASE_URL!);
  const store = new ShopifySyncRepository();
  const shop = `integration-${randomUUID()}.invalid`;
  const time = "2026-09-18T00:00:00.000Z";
  const newer = "2026-09-18T00:01:00.000Z";
  const event = (id: string): Delivery => ({ id, topic: "inventory_levels/update", resourceId: "inventory1", triggeredAt: time });
  const projection = (available: number, sourceUpdatedAt = time, deleted = false): Projection => ({ kind: "inventory", id: "inventory1@location1", parentId: "variant1", sourceUpdatedAt, observedAt: sourceUpdatedAt, deleted, data: { available, onHand: available, committed: 0, locationId: "location1" } });
  const batch = (row: Projection): SyncBatch => ({ projections: [row], replaceChildren: [] });
  const apply = async (id: string, row: Projection) => {
    const delivery = event(id);
    await store.enqueue(shop, delivery);
    const lease = await store.acquire(shop, id);
    assert.ok(lease);
    assert.equal(await store.apply(shop, delivery, batch(row), lease.leaseToken), true);
  };
  try {
    await Promise.all([store.enqueue(shop, event("duplicate")), store.enqueue(shop, event("duplicate"))]);
    assert.equal((await sql.query("SELECT count(*)::int AS n FROM shopify_webhook_inbox WHERE shop=$1 AND id='duplicate'", [shop]))[0].n, 1);
    const leases = await Promise.all([store.acquire(shop, "duplicate"), store.acquire(shop, "duplicate")]);
    assert.equal(leases.filter(Boolean).length, 1);
    const lease = leases.find(Boolean)!;
    assert.equal(await store.apply(shop, event("duplicate"), batch(projection(7)), lease.leaseToken), true);
    assert.equal(await store.apply(shop, event("duplicate"), batch(projection(999)), lease.leaseToken), false);
    await apply("newer", projection(3, newer));
    await apply("stale", projection(20));
    let row = (await sql.query("SELECT * FROM shopify_inventory WHERE shop=$1", [shop]))[0];
    assert.equal(row.data.available, 3);
    await apply("delete", projection(0, newer, true));
    await apply("stale-resurrect", { ...projection(5, newer), observedAt: "2026-09-18T00:10:00.000Z" });
    row = (await sql.query("SELECT * FROM shopify_inventory WHERE shop=$1", [shop]))[0];
    assert.equal(row.deleted, true);
    await store.enqueue(shop, event("rollback"));
    const rollbackLease = await store.acquire(shop, "rollback");
    assert.ok(rollbackLease);
    await assert.rejects(store.apply(shop, event("rollback"), batch({ ...projection(5), sourceUpdatedAt: "invalid timestamp" }), rollbackLease.leaseToken));
    assert.equal(await store.hasDelivery(shop, "rollback"), false);
    assert.equal((await sql.query("SELECT status FROM shopify_webhook_inbox WHERE shop=$1 AND id='rollback'", [shop]))[0].status, "processing");
    await store.fail(shop, rollbackLease, "Injected retryable test failure");
    assert.equal((await sql.query("SELECT status FROM shopify_webhook_inbox WHERE shop=$1 AND id='rollback'", [shop]))[0].status, "failed");
    await apply("order-paid", { kind: "orders", id: "order1", parentId: null, sourceUpdatedAt: newer, observedAt: newer, deleted: false, data: { name: "#TEST", financialStatus: "PAID", total: "12.00", currencyCode: "USD", itemCount: 2 } });
    await apply("order-stale", { kind: "orders", id: "order1", parentId: null, sourceUpdatedAt: time, observedAt: time, deleted: false, data: { financialStatus: "PENDING" } });
    assert.equal((await sql.query("SELECT data FROM shopify_orders WHERE shop=$1", [shop]))[0].data.financialStatus, "PAID");
    await store.enqueue(shop, event("defer-parent"));
    const deferLease = await store.acquire(shop, "defer-parent");
    assert.ok(deferLease);
    assert.equal(await store.apply(shop, event("defer-parent"), { projections: [], replaceChildren: [], deferred: [event("deferred-child")] }, deferLease.leaseToken), true);
    assert.equal((await sql.query("SELECT status FROM shopify_webhook_inbox WHERE shop=$1 AND id='deferred-child'", [shop]))[0].status, "pending");
    await apply("variant", { kind: "variants", id: "variant2", parentId: "product1", sourceUpdatedAt: time, observedAt: time, deleted: false, data: {} });
    await store.enqueue(shop, event("removed-variant"));
    const removalLease = await store.acquire(shop, "removed-variant");
    assert.ok(removalLease);
    assert.equal(await store.apply(shop, event("removed-variant"), { projections: [], replaceChildren: [{ kind: "variants", parentId: "product1", ids: [], sourceUpdatedAt: newer, observedAt: newer }] }, removalLease.leaseToken), true);
    assert.equal((await sql.query("SELECT deleted FROM shopify_variants WHERE shop=$1 AND id='variant2'", [shop]))[0].deleted, true);
    // Only this isolated fixture shop is removed; no legacy table is ever referenced for mutation.
  } finally {
    for (const table of ["shopify_webhook_inbox", "shopify_order_lines", "shopify_orders", "shopify_inventory", "shopify_variants", "shopify_products"]) await sql.query(`DELETE FROM ${table} WHERE shop=$1`, [shop]);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});

test("real Postgres inventory-only workers skip order jobs while retaining their data for full sync", { skip: !enabled }, async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.SHOPIFY_SYNC_TEST_DATABASE_URL;
  const sql = neon(process.env.SHOPIFY_SYNC_TEST_DATABASE_URL!);
  const store = new ShopifySyncRepository();
  const shop = `inventory-mode-${randomUUID()}.invalid`;
  const time = "2026-09-18T00:00:00.000Z";
  const delivery = (id: string, topic: string, resourceId: string): Delivery => ({ id, topic, resourceId, triggeredAt: time });
  const saved = (kind: Projection["kind"], id: string, parentId: string | null, data: Record<string, unknown>): Projection =>
    ({ kind, id, parentId, data, sourceUpdatedAt: time, observedAt: time, deleted: false });
  try {
    await store.enqueue(shop, delivery("old-order", "orders/updated", "order1"));
    await store.enqueue(shop, delivery("old-order-page", "reconcile", encodeCursor({ phase: "ordersAudit", after: "old-cursor" })));
    const inventoryPage = delivery("inventory-page", "reconcile", encodeCursor({ phase: "inventory", after: null }));
    await store.enqueue(shop, inventoryPage);
    const lease = await store.acquire(shop, undefined, false);
    assert.equal(lease?.id, "inventory-page");
    assert.equal(await store.apply(shop, inventoryPage, { projections: [
      saved("products", "product1", null, { title: "Bundle", status: "ACTIVE" }),
      saved("variants", "variant1", "product1", { title: "Default", sku: "DEFY-1", barcode: "0196214150478", price: "36.38", tracked: true }),
      saved("inventory", "item1@location1", "variant1", { locationId: "location1", available: 3, onHand: 5, committed: 2 }),
      // Previously imported order data must survive an inventory-only interval.
      saved("orders", "order1", null, { name: "#TEST", createdAt: time, financialStatus: "PAID", total: "36.38", currencyCode: "USD", itemCount: 1 }),
    ], replaceChildren: [] }, lease!.leaseToken), true);
    assert.equal(await store.acquire(shop, undefined, false), null);
    assert.equal(await store.acquire(shop, "old-order", false), null);
    assert.equal(await store.acquire(shop, "old-order-page", false), null);
    assert.equal((await sql.query("SELECT status FROM shopify_webhook_inbox WHERE shop=$1 AND id='old-order-page'", [shop]))[0].status, "pending");
    let inventory = await store.dashboard(shop, "location1", false);
    assert.deepEqual(inventory.orders, []); assert.equal(inventory.summary.orders, null);
    assert.equal(inventory.summary.pending, 0); assert.equal(inventory.summary.failed, 0);
    assert.equal(inventory.inventory[0].barcode, "0196214150478"); assert.equal(inventory.inventory[0].tracked, true);
    assert.equal(inventory.inventory[0].status, "ACTIVE");
    assert.equal(inventory.inventory[0].available, 3); assert.equal(inventory.inventory[0].onHand, 5);
    const orderLease = await store.acquire(shop, "old-order");
    assert.ok(orderLease); await store.fail(shop, orderLease, "Order permission required");
    inventory = await store.dashboard(shop, "location1", false);
    assert.deepEqual(inventory.recentErrors, []); assert.equal(inventory.summary.failed, 0);
    const full = await store.dashboard(shop, "location1");
    assert.equal(full.orders.length, 1); assert.equal(full.summary.orders, 1);
    assert.equal(full.summary.failed, 1); assert.equal(full.summary.pending, 1);
    assert.equal(full.recentErrors[0].error, "Order permission required");
    assert.equal((await store.acquire(shop, "old-order-page"))?.id, "old-order-page");
  } finally {
    for (const table of ["shopify_webhook_inbox", "shopify_order_lines", "shopify_orders", "shopify_inventory", "shopify_variants", "shopify_products"]) await sql.query(`DELETE FROM ${table} WHERE shop=$1`, [shop]);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
