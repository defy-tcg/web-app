import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ScrydexError } from "../lib/scrydex.ts";
import { handlePosSealedCatalogRequest, type CatalogDependencies } from "../lib/shopify/pos-sealed-catalog-handler.ts";

const now = 1_800_000_000;
const authConfig = { shop: "defy-receiving-test.myshopify.com", clientId: "test-app", clientSecret: "test-secret" };
const unsigned = [ { alg: "HS256" }, { iss: `https://${authConfig.shop}/admin`, dest: `https://${authConfig.shop}`,
  aud: authConfig.clientId, sub: "123", exp: now + 60, nbf: now } ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
const token = `${unsigned}.${createHmac("sha256", authConfig.clientSecret).update(unsigned).digest("base64url")}`;
const product = { id: "sv4pt5-s3", game: "pokemon" as const, name: "Paldean Fates Collection", setName: "Paldean Fates",
  language: "English" as const, unit: "Collection box", imageUrl: null, marketCents: 5000 };
function request(body: unknown = { game: "pokemon", query: "Paldean Fates" }, headers: Record<string, string> = {}) {
  return new Request("https://defy.example/api/shopify/pos/sealed-catalog", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function harness(overrides: Partial<CatalogDependencies> = {}) {
  const calls: unknown[] = [];
  return { calls, handle: (incoming: Request) => handlePosSealedCatalogRequest(incoming, {
    authConfig, nowSeconds: now,
    search: async value => { calls.push(value); return { products: [{ ...product, secret: "private" }], hasMore: false }; },
    get: async value => { calls.push(value); return { ...product, secret: "private" }; }, ...overrides,
  }) };
}

test("sealed search and exact selection authenticate, trim search, and expose only catalog fields", async () => {
  const { handle, calls } = harness();
  const response = await handle(request({ game: "pokemon", query: " Paldean Fates " }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { products: [product], hasMore: false });
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(await (await handle(request({ game: "pokemon", id: product.id }))).json(), { product });
  assert.deepEqual(calls, [{ game: "pokemon", query: "Paldean Fates" }, { game: "pokemon", id: product.id }]);
});

test("authenticated Gundam searches and exact selections keep the requested game and safe public fields", async () => {
  const gundam = { ...product, id: "GD01-s1", game: "gundam" as const,
    name: "Newtype Rising Booster Pack", setName: "Newtype Rising", unit: "Booster pack" };
  const calls: unknown[] = [];
  const { handle } = harness({
    search: async input => { calls.push(input); return { products: [gundam], hasMore: false }; },
    get: async input => { calls.push(input); return { ...gundam, privateProviderField: "hidden" }; },
  });
  const search = await handle(request({ game: "gundam", query: " Newtype Rising " }));
  assert.equal(search.status, 200);
  assert.deepEqual(await search.json(), { products: [gundam], hasMore: false });
  const detail = await handle(request({ game: "gundam", id: gundam.id }));
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), { product: gundam });
  assert.deepEqual(calls, [{ game: "gundam", query: "Newtype Rising" }, { game: "gundam", id: "GD01-s1" }]);
});

test("sealed catalog rejects unauthenticated and cookie-only requests before consuming Scrydex credits", async () => {
  const { handle, calls } = harness();
  for (const authorization of ["", "Bearer undefined", `Bearer ${token}x`, "Basic 123"]) {
    assert.equal((await handle(request(undefined, { authorization, cookie: "neon-auth-session=example" }))).status, 401);
  }
  assert.equal(calls.length, 0);
});

test("sealed catalog only allows Shopify origins and constrained preflight without authentication", async () => {
  const { handle, calls } = harness();
  for (const origin of ["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]) {
    const response = await handle(request(undefined, { origin }));
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.status, 200);
  }
  for (const origin of ["null", "https://attacker.example", "https://cdn.shopify.com.attacker.example"]) {
    assert.equal((await handle(request(undefined, { origin }))).status, 403);
  }
  const options = await handle(new Request("https://defy.example", { method: "OPTIONS", headers: {
    origin: "https://cdn.shopify.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type",
  } }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-credentials"), null);
  assert.equal((await handle(new Request("https://defy.example", { method: "OPTIONS", headers: { "access-control-request-headers": "cookie" } }))).status, 400);
  assert.equal((await handle(new Request("https://defy.example"))).status, 405);
  assert.equal(calls.length, 2);
});

test("sealed catalog rejects client prices, unsafe identities, malformed and oversized input", async () => {
  const { handle, calls } = harness();
  for (const input of [null, [], {}, { game: "pokemon", query: "aa" }, { game: "pokemon", query: "a".repeat(101) },
    { game: "pokemon", query: "a\nb" }, { game: "pokemon", id: "../../secret" }, { game: "pokemon", id: "" },
    { game: "other", query: "Collection" }, { game: ["pokemon"], query: "Collection" }, { game: "pokemon", query: "Collection", id: "id" },
    { game: "pokemon", query: "Collection", marketCents: 1 }, { game: "pokemon", id: 123 }]) {
    assert.equal((await handle(request(input))).status, 400);
  }
  assert.equal((await handle(request(undefined, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handle(request(undefined, { "content-encoding": "gzip" }))).status, 415);
  for (const length of [undefined, "1", "3000"]) {
    assert.equal((await handle(request({ game: "pokemon", query: "字".repeat(1000) }, length ? { "content-length": length } : {}))).status, 413);
  }
  assert.equal((await handle(new Request("https://defy.example", { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: "{" }))).status, 400);
  assert.equal(calls.length, 0);
});

test("provider failures are sanitized and missing quotes do not prevent catalog selection", async () => {
  for (const [error, status] of [[new ScrydexError("upstream_error", "SECRET"), 503],
    [new ScrydexError("not_found", "SECRET"), 404], [new Error("SECRET"), 503]] as const) {
    const { handle } = harness({ search: async () => { throw error; } });
    const response = await handle(request());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /SECRET/);
  }
  const { handle } = harness({ get: async () => ({ ...product, marketCents: null }) });
  const response = await handle(request({ game: "pokemon", id: product.id }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product.marketCents, null);
});
