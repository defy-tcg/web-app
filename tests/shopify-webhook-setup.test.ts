import assert from "node:assert/strict";
import test from "node:test";
import { setupShopifyWebhooks, WEBHOOK_TOPICS, webhookCallback } from "../scripts/setup-shopify-webhooks.ts";
import type { SinglesGraphQL } from "../lib/singles/shopify.ts";

const origin = "https://defy-store-os.vercel.app";
const callback = `${origin}/api/shopify/webhooks`;
const shop = "defy-receiving-test.myshopify.com";
const payloadFields: Record<string, string[]> = {
  PRODUCTS_CREATE: ["id", "updated_at"], PRODUCTS_UPDATE: ["id", "updated_at"], PRODUCTS_DELETE: ["id"],
  INVENTORY_LEVELS_UPDATE: ["inventory_item_id", "location_id", "updated_at", "available"],
  INVENTORY_LEVELS_CONNECT: ["inventory_item_id", "location_id", "updated_at", "available"],
  INVENTORY_LEVELS_DISCONNECT: ["inventory_item_id", "location_id"],
  ORDERS_CREATE: ["id", "updated_at"], ORDERS_UPDATED: ["id", "updated_at"], ORDERS_PAID: ["id", "updated_at"],
  ORDERS_CANCELLED: ["id", "updated_at"], ORDERS_DELETE: ["id"],
};
const subscription = (topic: string, uri = callback) => ({ id: `sub-${topic}`, topic, uri, format: "JSON", filter: null as string | null, includeFields: payloadFields[topic] as string[] | null });
function fixture(initial = [subscription(WEBHOOK_TOPICS[0])], pageSize = 1) {
  const records = structuredClone(initial);
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const state = { scopes: ["write_products", "write_inventory", "read_locations", "read_orders"], incomplete: false };
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ query, variables });
    if (query.includes("query DefySyncWebhookSetup")) return { shop: { myshopifyDomain: shop }, currentAppInstallation: { accessScopes: state.scopes.map(handle => ({ handle })) } } as T;
    if (query.includes("query DefySyncSubscriptions")) {
      const start = Number(variables.after || 0), end = start + pageSize;
      return { webhookSubscriptions: { nodes: structuredClone(records.slice(start, end)), pageInfo: { hasNextPage: state.incomplete || end < records.length, endCursor: state.incomplete ? null : String(end) } } } as T;
    }
    if (query.includes("mutation DefySyncRepairWebhook")) {
      const item = records.find(item => item.id === variables.id);
      assert.ok(item);
      Object.assign(item, variables.webhookSubscription);
      return { webhookSubscriptionUpdate: { webhookSubscription: structuredClone(item), userErrors: [] } } as T;
    }
    assert.match(query, /mutation DefySyncCreateWebhook/);
    const created = { ...subscription(String(variables.topic)), ...variables.webhookSubscription as object };
    records.push(created);
    return { webhookSubscriptionCreate: { webhookSubscription: created, userErrors: [] } } as T;
  };
  return { records, calls, state, graphql };
}

test("callback is derived only from the exact configured HTTPS origin", () => {
  assert.equal(webhookCallback(origin), callback);
  assert.equal(webhookCallback(`${origin}/`), callback);
  for (const value of [undefined, "", "http://localhost:3000", `${origin}/path`, `${origin}?next=elsewhere`, `${origin}#section`, "https://user:secret@example.com", " HTTPS://EXAMPLE.COM "]) assert.throws(() => webhookCallback(value));
});

test("default setup paginates, reports missing pairs and never mutates unrelated subscriptions", async () => {
  const f = fixture([subscription(WEBHOOK_TOPICS[0]), subscription(WEBHOOK_TOPICS[1], "https://other.example/hook")]);
  const original = structuredClone(f.records);
  const result = await setupShopifyWebhooks(f.graphql, { shop, origin });
  assert.equal(result.mode, "dry-run"); assert.deepEqual(result.existing, [WEBHOOK_TOPICS[0]]);
  assert.equal(result.missing.length, WEBHOOK_TOPICS.length - 1);
  assert.equal(f.calls.filter(call => call.query.includes("query DefySyncSubscriptions")).length, 2);
  assert.ok(f.calls.every(call => !call.query.includes("mutation")));
  assert.deepEqual(f.records, original);
});

test("explicit apply creates missing exact pairs with change fields and valid delete/disconnect payloads", async () => {
  const foreign = subscription(WEBHOOK_TOPICS[1], "https://other.example/hook"); foreign.id = "foreign";
  const f = fixture([subscription(WEBHOOK_TOPICS[0]), foreign], 100);
  const result = await setupShopifyWebhooks(f.graphql, { shop, origin, apply: true });
  assert.equal(result.created.length, WEBHOOK_TOPICS.length - 1);
  assert.deepEqual(f.records.find(item => item.id === "foreign"), foreign);
  const writes = f.calls.filter(call => call.query.includes("mutation"));
  for (const call of writes) {
    const input = call.variables.webhookSubscription as { uri: string; includeFields: string[] };
    assert.equal(input.uri, callback);
    assert.deepEqual(input.includeFields, payloadFields[String(call.variables.topic)]);
    assert.doesNotMatch(call.query, /webhookSubscription(?:Delete|Update)/);
  }
  assert.equal((await setupShopifyWebhooks(f.graphql, { shop, origin, apply: true })).created.length, 0);
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, writes.length);
});

test("dry-run reports legacy payload repairs without changing subscriptions", async () => {
  const inventory = { ...subscription("INVENTORY_LEVELS_UPDATE"), includeFields: ["inventory_item_id", "location_id"] };
  const product = { ...subscription("PRODUCTS_UPDATE"), includeFields: ["id", "title", "variants.id"] };
  const f = fixture([inventory, product]);
  const original = structuredClone(f.records);
  const result = await setupShopifyWebhooks(f.graphql, { shop, origin });
  assert.deepEqual(result.repairs, [
    { id: product.id, topic: product.topic, includeFields: ["id", "title", "variants.id", "updated_at"], addedFields: ["updated_at"] },
    { id: inventory.id, topic: inventory.topic, includeFields: ["inventory_item_id", "location_id", "updated_at", "available"], addedFields: ["updated_at", "available"] },
  ]);
  assert.deepEqual(result.repaired, []);
  assert.deepEqual(f.records, original);
  assert.ok(f.calls.every(call => !call.query.includes("mutation")));
});

test("apply repairs exact subscriptions in place, preserves broader fields and unrelated settings, and is replay-safe", async () => {
  const initial = WEBHOOK_TOPICS.map(topic => subscription(topic));
  const inventory = initial.find(item => item.topic === "INVENTORY_LEVELS_UPDATE")!;
  inventory.includeFields = ["inventory_item_id", "location_id", "admin_graphql_api_id", "available"];
  inventory.filter = "";
  const product = initial.find(item => item.topic === "PRODUCTS_UPDATE")!;
  product.includeFields = ["id", "title", "variants.id"];
  const foreign = { ...subscription("INVENTORY_LEVELS_UPDATE", "https://other.example/hook"), id: "foreign", format: "XML", filter: "available:>0", includeFields: ["location_id"] };
  const oldOrder = { ...subscription("ORDERS_UPDATED"), includeFields: ["id"] };
  initial[initial.findIndex(item => item.topic === "ORDERS_UPDATED")] = oldOrder;
  const f = fixture([...initial, foreign], 100);
  const result = await setupShopifyWebhooks(f.graphql, { shop, origin, ordersEnabled: false, apply: true });
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.repaired, ["PRODUCTS_UPDATE", "INVENTORY_LEVELS_UPDATE"]);
  assert.deepEqual(f.records.find(item => item.id === inventory.id), { ...inventory, includeFields: [...inventory.includeFields, "updated_at"] });
  assert.deepEqual(f.records.find(item => item.id === product.id), { ...product, includeFields: [...product.includeFields, "updated_at"] });
  assert.deepEqual(f.records.find(item => item.id === foreign.id), foreign);
  assert.deepEqual(f.records.find(item => item.id === oldOrder.id), oldOrder);
  const writes = f.calls.filter(call => call.query.includes("mutation"));
  assert.equal(writes.length, 2);
  for (const call of writes) {
    assert.match(call.query, /webhookSubscriptionUpdate/);
    assert.deepEqual(Object.keys(call.variables.webhookSubscription as object), ["includeFields"]);
  }
  const again = await setupShopifyWebhooks(f.graphql, { shop, origin, ordersEnabled: false, apply: true });
  assert.deepEqual(again.repairs, []); assert.deepEqual(again.repaired, []); assert.deepEqual(again.created, []);
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, writes.length);
});

test("full payload subscriptions remain untouched during apply", async () => {
  const initial = WEBHOOK_TOPICS.map(topic => subscription(topic));
  initial[0].includeFields = null;
  initial[1].includeFields = [];
  const f = fixture(initial, 100);
  const result = await setupShopifyWebhooks(f.graphql, { shop, origin, apply: true });
  assert.deepEqual(result.repairs, []); assert.equal(result.warnings.length, 2);
  assert.deepEqual(f.records, initial);
  assert.ok(f.calls.every(call => !call.query.includes("mutation")));
});

test("repair re-reads existing payload fields before writing", async () => {
  const f = fixture(WEBHOOK_TOPICS.map(topic => subscription(topic)), 100);
  const inventory = f.records.find(item => item.topic === "INVENTORY_LEVELS_UPDATE")!;
  inventory.includeFields = ["inventory_item_id", "location_id"];
  let lists = 0;
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    if (query.includes("query DefySyncSubscriptions") && ++lists === 2) inventory.includeFields!.push("admin_graphql_api_id");
    return f.graphql<T>(query, variables);
  };
  await setupShopifyWebhooks(graphql, { shop, origin, apply: true });
  assert.deepEqual(inventory.includeFields, ["inventory_item_id", "location_id", "admin_graphql_api_id", "updated_at", "available"]);
});

test("repair stops after Shopify errors or an unconfirmed response and does not create duplicates", async () => {
  for (const response of [
    { webhookSubscription: null, userErrors: [{ message: "Cannot update subscription" }] },
    { webhookSubscription: subscription("INVENTORY_LEVELS_UPDATE", "https://changed.example/hook"), userErrors: [] },
  ]) {
    const f = fixture([{ ...subscription("INVENTORY_LEVELS_UPDATE"), includeFields: ["inventory_item_id", "location_id"] }]);
    let writes = 0;
    const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      if (query.includes("mutation DefySyncRepairWebhook")) { writes++; return { webhookSubscriptionUpdate: response } as T; }
      return f.graphql<T>(query, variables);
    };
    // Earlier topics are already configured, so the failing repair is the first write.
    f.records.push(...WEBHOOK_TOPICS.filter(topic => topic !== "INVENTORY_LEVELS_UPDATE").map(topic => subscription(topic)));
    await assert.rejects(setupShopifyWebhooks(graphql, { shop, origin, apply: true }), /payload repair/);
    assert.equal(writes, 1);
    assert.ok(f.calls.every(call => !call.query.includes("mutation")));
  }
});

test("apply rejects a repair that was acknowledged but not retained by Shopify", async () => {
  const f = fixture(WEBHOOK_TOPICS.map(topic => subscription(topic)), 100);
  f.records.find(item => item.topic === "INVENTORY_LEVELS_UPDATE")!.includeFields = ["inventory_item_id", "location_id"];
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    if (query.includes("mutation DefySyncRepairWebhook")) return { webhookSubscriptionUpdate: { webhookSubscription: subscription("INVENTORY_LEVELS_UPDATE"), userErrors: [] } } as T;
    return f.graphql<T>(query, variables);
  };
  await assert.rejects(setupShopifyWebhooks(graphql, { shop, origin, apply: true }), /Setup is incomplete for INVENTORY_LEVELS_UPDATE/);
});

test("missing read_orders fails before listing or creating subscriptions", async () => {
  const f = fixture(); f.state.scopes = f.state.scopes.filter(scope => scope !== "read_orders");
  await assert.rejects(setupShopifyWebhooks(f.graphql, { shop, origin, apply: true }), /needs read_orders/);
  assert.equal(f.calls.length, 1);
});

test("inventory-only setup creates six topics without order scopes and leaves existing order subscriptions untouched", async () => {
  const oldOrder = subscription("ORDERS_UPDATED");
  const f = fixture([oldOrder], 100);
  f.state.scopes = f.state.scopes.filter(scope => scope !== "read_orders");
  const plan = await setupShopifyWebhooks(f.graphql, { shop, origin, ordersEnabled: false });
  assert.equal(plan.ordersEnabled, false); assert.equal(plan.missing.length, 6);
  assert.ok(plan.missing.every(topic => !topic.startsWith("ORDERS_")));
  assert.equal(f.calls.some(call => call.query.includes("mutation")), false);
  const applied = await setupShopifyWebhooks(f.graphql, { shop, origin, ordersEnabled: false, apply: true });
  assert.equal(applied.created.length, 6);
  assert.deepEqual(f.records.find(item => item.id === oldOrder.id), oldOrder);
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).some(call => String(call.variables.topic).startsWith("ORDERS_")), false);
  assert.deepEqual((await setupShopifyWebhooks(f.graphql, { shop, origin, ordersEnabled: false, apply: true })).created, []);
  await assert.rejects(setupShopifyWebhooks(f.graphql, { shop, origin, ordersEnabled: true }), /needs read_orders/);
});

test("incomplete pagination and conflicting existing subscriptions block writes", async () => {
  const incomplete = fixture(); incomplete.state.incomplete = true;
  await assert.rejects(setupShopifyWebhooks(incomplete.graphql, { shop, origin, apply: true }), /pagination/);
  const incompatible = [
    { ...subscription("PRODUCTS_UPDATE"), filter: "status:open", includeFields: ["id"] },
    { ...subscription("PRODUCTS_UPDATE"), format: "XML", includeFields: ["id"] },
    { ...subscription("PRODUCTS_UPDATE"), includeFields: ["updated_at"] },
    { ...subscription("INVENTORY_LEVELS_UPDATE"), includeFields: ["inventory_item_id", "available"] },
  ].map(item => fixture([item]));
  for (const f of incompatible) {
    await assert.rejects(setupShopifyWebhooks(f.graphql, { shop, origin, apply: true }), /incompatible/);
    assert.ok(f.calls.every(call => !call.query.includes("mutation")));
  }
  const duplicate = fixture([subscription(WEBHOOK_TOPICS[0]), { ...subscription(WEBHOOK_TOPICS[0]), id: "second" }]);
  await assert.rejects(setupShopifyWebhooks(duplicate.graphql, { shop, origin, apply: true }), /Multiple/);
  assert.ok([...incomplete.calls, ...duplicate.calls].every(call => !call.query.includes("mutation")));
});

test("repair stops if its subscription becomes filtered before the write", async () => {
  const f = fixture(WEBHOOK_TOPICS.map(topic => subscription(topic)), 100);
  const inventory = f.records.find(item => item.topic === "INVENTORY_LEVELS_UPDATE")!;
  inventory.includeFields = ["inventory_item_id", "location_id"];
  let lists = 0;
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    if (query.includes("query DefySyncSubscriptions") && ++lists === 2) inventory.filter = "available:>0";
    return f.graphql<T>(query, variables);
  };
  await assert.rejects(setupShopifyWebhooks(graphql, { shop, origin, apply: true }), /incompatible/);
  assert.ok(f.calls.every(call => !call.query.includes("mutation")));
});
