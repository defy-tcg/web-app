import assert from "node:assert/strict";
import test from "node:test";
import { setupShopifyWebhooks, WEBHOOK_TOPICS, webhookCallback } from "../scripts/setup-shopify-webhooks.ts";
import type { SinglesGraphQL } from "../lib/singles/shopify.ts";

const origin = "https://defy-store-os.vercel.app";
const callback = `${origin}/api/shopify/webhooks`;
const shop = "defy-receiving-test.myshopify.com";
const subscription = (topic: string, uri = callback) => ({ id: `sub-${topic}`, topic, uri, format: "JSON", filter: null as string | null, includeFields: topic.startsWith("INVENTORY_LEVELS_") ? ["inventory_item_id", "location_id"] : ["id"] });
function fixture(initial = [subscription(WEBHOOK_TOPICS[0])], pageSize = 1) {
  const records = structuredClone(initial);
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const state = { scopes: ["write_products", "write_inventory", "read_locations", "read_orders"], incomplete: false };
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ query, variables });
    if (query.includes("query DefySyncWebhookSetup")) return { shop: { myshopifyDomain: shop }, currentAppInstallation: { accessScopes: state.scopes.map(handle => ({ handle })) } } as T;
    if (query.includes("query DefySyncSubscriptions")) {
      const start = Number(variables.after || 0), end = start + pageSize;
      return { webhookSubscriptions: { nodes: records.slice(start, end), pageInfo: { hasNextPage: state.incomplete || end < records.length, endCursor: state.incomplete ? null : String(end) } } } as T;
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

test("explicit apply only creates missing exact topic/URI pairs with minimal payloads and is replay-safe", async () => {
  const foreign = subscription(WEBHOOK_TOPICS[1], "https://other.example/hook"); foreign.id = "foreign";
  const f = fixture([subscription(WEBHOOK_TOPICS[0]), foreign], 100);
  const result = await setupShopifyWebhooks(f.graphql, { shop, origin, apply: true });
  assert.equal(result.created.length, WEBHOOK_TOPICS.length - 1);
  assert.deepEqual(f.records.find(item => item.id === "foreign"), foreign);
  const writes = f.calls.filter(call => call.query.includes("mutation"));
  for (const call of writes) {
    const input = call.variables.webhookSubscription as { uri: string; includeFields: string[] };
    assert.equal(input.uri, callback);
    assert.deepEqual(input.includeFields, String(call.variables.topic).startsWith("INVENTORY_LEVELS_") ? ["inventory_item_id", "location_id"] : ["id"]);
    assert.doesNotMatch(call.query, /webhookSubscription(?:Delete|Update)/);
  }
  assert.equal((await setupShopifyWebhooks(f.graphql, { shop, origin, apply: true })).created.length, 0);
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, writes.length);
});

test("missing read_orders fails before listing or creating subscriptions", async () => {
  const f = fixture(); f.state.scopes = f.state.scopes.filter(scope => scope !== "read_orders");
  await assert.rejects(setupShopifyWebhooks(f.graphql, { shop, origin, apply: true }), /needs read_orders/);
  assert.equal(f.calls.length, 1);
});

test("incomplete pagination and conflicting existing subscriptions block writes", async () => {
  const incomplete = fixture(); incomplete.state.incomplete = true;
  await assert.rejects(setupShopifyWebhooks(incomplete.graphql, { shop, origin, apply: true }), /pagination/);
  const filtered = subscription(WEBHOOK_TOPICS[0]); filtered.filter = "status:open";
  const f = fixture([filtered]);
  await assert.rejects(setupShopifyWebhooks(f.graphql, { shop, origin, apply: true }), /incompatible/);
  const duplicate = fixture([subscription(WEBHOOK_TOPICS[0]), { ...subscription(WEBHOOK_TOPICS[0]), id: "second" }]);
  await assert.rejects(setupShopifyWebhooks(duplicate.graphql, { shop, origin, apply: true }), /Multiple/);
  assert.ok([...incomplete.calls, ...f.calls, ...duplicate.calls].every(call => !call.query.includes("mutation")));
});
