import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createShopifyGraphQL } from "../lib/singles/shopify.ts";
import { SinglesError } from "../lib/singles/intake.ts";

const secret = "private-test-credential";
const readQuery = "query TransportRead($key: String!) { shop { id } }";
const writeQuery = "mutation TransportWrite($key: String!) { update { id } }";
type Reply = object | Error | Response;
let serial = 0;
function fixture(t: TestContext, replies: Reply[]) {
  const names = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_LOCATION_ID"] as const;
  const previous = names.map(name => process.env[name]);
  Object.assign(process.env, { SHOPIFY_SHOP_DOMAIN: "defy-receiving-test.myshopify.com", SHOPIFY_CLIENT_ID: `transport-test-${++serial}`,
    SHOPIFY_CLIENT_SECRET: secret, SHOPIFY_LOCATION_ID: "gid://shopify/Location/1" });
  t.after(() => names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; }));
  const requests: { body: string; url: string }[] = [];
  const waits: number[] = [];
  const logs: unknown[][] = [];
  const actualTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, milliseconds: number) => {
    waits.push(milliseconds);
    return actualTimeout(callback, 0);
  });
  t.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/oauth/access_token")) return Response.json({ access_token: secret, expires_in: 3600 });
    requests.push({ body: String(init?.body), url: String(url) });
    const reply = replies.shift();
    assert.ok(reply, "Unexpected additional Shopify request");
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return Response.json(reply, { headers: { date: "Sat, 26 Sep 2026 20:00:00 GMT" } });
  });
  return { requests, waits, logs };
}
const throttled = (cost?: object) => ({ data: null, errors: [{ message: secret, extensions: { code: "THROTTLED" } }],
  ...(cost ? { extensions: { cost } } : {}) });
const success = { data: { shop: { id: "gid://shopify/Shop/1" } } };

test("Shopify query throttling waits for the reported cost and replays the identical request", async t => {
  const f = fixture(t, [throttled({ requestedQueryCost: 125, actualQueryCost: null,
    throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 25, restoreRate: 50 } }), success]);
  const client = await createShopifyGraphQL({ apiVersion: "2026-10" });
  assert.deepEqual(await client.graphql(readQuery, { key: secret }), success.data);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0], f.requests[1]);
  assert.ok(f.requests[0].url.includes("/2026-10/"));
  assert.deepEqual(f.waits, [2100]);
  assert.deepEqual(f.logs[0], ["[shopify-graphql] Request not confirmed", { operation: "TransportRead", code: "THROTTLED", attempt: 1,
    retry: true, requestedQueryCost: 125, maximumAvailable: 1000, currentlyAvailable: 25, restoreRate: 50, waitMs: 2100 }]);
  assert.ok(!JSON.stringify(f.logs).includes(secret), "Never log credentials, request variables, or upstream error messages");
  assert.ok(Number.isFinite(client.clock()));
});

test("an explicitly rejected mutation can recover without changing its original variables", async t => {
  const f = fixture(t, [throttled(), success]);
  const client = await createShopifyGraphQL();
  await client.graphql(writeQuery, { key: "original-stock-receipt" });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].body, f.requests[1].body);
  assert.deepEqual(f.waits, [1000]);
});

test("persistent explicit throttling stops after three retries and remains a confirmed rejection", async t => {
  const f = fixture(t, Array.from({ length: 4 }, () => throttled()));
  const client = await createShopifyGraphQL();
  await assert.rejects(client.graphql(writeQuery), error => error instanceof SinglesError && error.code === "THROTTLED" && error.retryable && !error.uncertain);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.waits, [1000, 2000, 4000]);
});

test("impossible query cost and waits outside the budget fail without replaying", async t => {
  for (const cost of [
    { requestedQueryCost: 1001, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 1000, restoreRate: 50 } },
    { requestedQueryCost: 900, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 } },
  ]) await t.test(JSON.stringify(cost), async child => {
    const f = fixture(child, [throttled(cost)]);
    const client = await createShopifyGraphQL();
    await assert.rejects(client.graphql(readQuery), { code: "THROTTLED" });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.waits, []);
  });
});

test("all requests in one Shopify client share a bounded throttle wait budget", async t => {
  const throttle = () => throttled({ requestedQueryCost: 700, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 100 } });
  const f = fixture(t, [throttle(), success, throttle(), success, throttle()]);
  const client = await createShopifyGraphQL();
  await client.graphql(readQuery);
  await client.graphql(readQuery);
  await assert.rejects(client.graphql(readQuery), { code: "THROTTLED" });
  assert.deepEqual(f.waits, [7100, 7100]);
  assert.equal(f.requests.length, 5);
});

test("uncertain mutation results and mixed errors are never automatically replayed", async t => {
  const cases: { label: string; reply: Reply; code: string }[] = [
    { label: "network response loss", reply: new Error(secret), code: "SHOPIFY_UNAVAILABLE" },
    { label: "HTTP failure", reply: new Response(secret, { status: 503 }), code: "SHOPIFY_UNAVAILABLE" },
    { label: "unreadable JSON", reply: new Response(secret), code: "SHOPIFY_UNAVAILABLE" },
    { label: "missing data", reply: {}, code: "SHOPIFY_UNAVAILABLE" },
    { label: "partial mutation data", reply: { ...throttled(), data: { update: { id: "already-applied" } } }, code: "THROTTLED" },
    { label: "execution cost despite no data", reply: throttled({ requestedQueryCost: 10, actualQueryCost: 10 }), code: "THROTTLED" },
    { label: "mixed errors", reply: { errors: [{ extensions: { code: "THROTTLED" }, message: secret },
      { extensions: { code: "INTERNAL_SERVER_ERROR" }, message: secret }] }, code: "THROTTLED" },
    { label: "internal error", reply: { errors: [{ extensions: { code: "INTERNAL_SERVER_ERROR" }, message: secret }] }, code: "INTERNAL_SERVER_ERROR" },
  ];
  for (const entry of cases) await t.test(entry.label, async child => {
    const f = fixture(child, [entry.reply]);
    const client = await createShopifyGraphQL();
    await assert.rejects(client.graphql(writeQuery, { key: secret }), error => error instanceof SinglesError && error.code === entry.code && error.uncertain);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.waits, []);
    assert.equal(f.logs.length, 1);
    assert.ok(!JSON.stringify(f.logs).includes(secret));
  });
});

test("Shopify diagnostics include only safe error codes and finite cost values", async t => {
  const f = fixture(t, [{ errors: [{ message: secret, extensions: { code: secret } }], extensions: { cost: {
    requestedQueryCost: secret, actualQueryCost: -1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: secret, restoreRate: 50 },
  } } }]);
  const client = await createShopifyGraphQL();
  await assert.rejects(client.graphql(readQuery, { key: secret }));
  assert.deepEqual(f.logs[0], ["[shopify-graphql] Request not confirmed", { operation: "TransportRead", code: "GRAPHQL_ERROR", attempt: 1,
    retry: false, maximumAvailable: 1000, restoreRate: 50 }]);
  assert.ok(!JSON.stringify(f.logs).includes(secret));
});
