import assert from "node:assert/strict";
import test from "node:test";
import { inventoryStockEvent } from "../lib/shopify/stock-events.ts";
import { PUBLIC_RESTOCK_LOCATION, PUBLIC_RESTOCK_SHOP, publicRestocksResponse } from "../lib/shopify/public-restocks.ts";
import type { Delivery } from "../lib/shopify/sync-core.ts";

const time = "2026-10-08T12:00:00.000Z";
const delivery: Delivery = { id: "webhook:test-event", topic: "inventory_levels/update", resourceId: "gid://shopify/InventoryItem/1", locationId: PUBLIC_RESTOCK_LOCATION, triggeredAt: time };
const config = { enabled: true, shop: PUBLIC_RESTOCK_SHOP, locationId: PUBLIC_RESTOCK_LOCATION };
const request = (query = "") => new Request(`https://defy-store-os.vercel.app/api/public/restocks${query}`);

test("signed inventory event parsing accepts actual integer counts and retains submillisecond delivery ordering", () => {
  for (const available of [-2_147_483_648, -1, 0, 7, 2_147_483_647]) {
    const triggeredAt = "2026-10-08T12:00:00.000123Z";
    assert.deepEqual(inventoryStockEvent(delivery, { available, updated_at: "2026-10-08T05:00:00-07:00", customer: "private" }, PUBLIC_RESTOCK_LOCATION, triggeredAt),
      { available, eventAt: time, triggeredAt });
  }
  for (const available of ["7", null, NaN, Infinity, 1.5, 2_147_483_648]) {
    assert.throws(() => inventoryStockEvent(delivery, { available, updated_at: time }, PUBLIC_RESTOCK_LOCATION), /integer available/);
  }
  for (const updated_at of [null, "2026-10-08", "invalid", "2026-02-30T12:00:00Z", "2026-10-08T24:00:00Z"]) {
    assert.throws(() => inventoryStockEvent(delivery, { available: 7, updated_at }, PUBLIC_RESTOCK_LOCATION), /update timestamp/);
  }
  assert.throws(() => inventoryStockEvent(delivery, { available: 7, updated_at: time }, PUBLIC_RESTOCK_LOCATION, "2026-10-09T12:00:00Z"), /delivery timestamp/);
});

test("inventory event tracking ignores other locations, noninventory events and old reduced payloads", () => {
  assert.equal(inventoryStockEvent(delivery, { available: 7 }, PUBLIC_RESTOCK_LOCATION), null);
  assert.equal(inventoryStockEvent(delivery, { updated_at: time }, PUBLIC_RESTOCK_LOCATION), null);
  assert.equal(inventoryStockEvent({ ...delivery, locationId: "gid://shopify/Location/99" }, { available: "invalid" }, PUBLIC_RESTOCK_LOCATION), null);
  for (const topic of ["products/update", "inventory_levels/connect", "inventory_levels/disconnect", "orders/updated"]) {
    assert.equal(inventoryStockEvent({ ...delivery, topic }, { available: 7, updated_at: time }, PUBLIC_RESTOCK_LOCATION), null);
  }
});

test("public restocks expose only product identity and date at the fixed approved location", async () => {
  const response = await publicRestocksResponse(request(), config, async () => [{ productId: "gid://shopify/Product/1", lastRestockedAt: time,
    sku: "PRIVATE-SKU", cost: 100, supplier: "private supplier", notes: "private notes", available: 7 }]);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=0, s-maxage=30");
  assert.deepEqual(await response.json(), { locationId: PUBLIC_RESTOCK_LOCATION, restocks: [{ productId: "gid://shopify/Product/1", lastRestockedAt: time }] });
});

test("public restocks reject alternate configuration, user filters and incomplete projections", async () => {
  let reads = 0;
  const read = async () => { reads++; return []; };
  for (const altered of [{ ...config, enabled: false }, { ...config, shop: "defy-receiving-test.myshopify.com" }, { ...config, locationId: "gid://shopify/Location/99" }]) {
    assert.equal((await publicRestocksResponse(request(), altered, read)).status, 503);
  }
  assert.equal((await publicRestocksResponse(request("?shop=other"), config, read)).status, 400);
  assert.equal(reads, 0);
  for (const rows of [[{ productId: "invalid", lastRestockedAt: time }], [{ productId: "gid://shopify/Product/1", lastRestockedAt: "invalid" }],
    [{ productId: "gid://shopify/Product/1", lastRestockedAt: time }, { productId: "gid://shopify/Product/1", lastRestockedAt: time }],
    Array.from({ length: 1001 }, (_, index) => ({ productId: `gid://shopify/Product/${index + 1}`, lastRestockedAt: time }))]) {
    assert.equal((await publicRestocksResponse(request(), config, async () => rows)).status, 503);
  }
  assert.equal((await publicRestocksResponse(request(), config, async () => { throw new Error("database connection includes secret"); })).status, 503);
});
