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
