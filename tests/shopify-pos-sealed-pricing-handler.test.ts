import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ScrydexError } from "../lib/scrydex.ts";
import { SealedPricingError } from "../lib/shopify/pos-sealed-pricing.ts";
import { handlePosSealedPricingRequest, type SealedPricingDependencies } from "../lib/shopify/pos-sealed-pricing-handler.ts";

const now = 1_800_000_000;
const authConfig = { shop: "defy-receiving-test.myshopify.com", clientId: "test-app", clientSecret: "test-secret" };
const unsigned = [{ alg: "HS256" }, { iss: `https://${authConfig.shop}/admin`, dest: `https://${authConfig.shop}`,
  aud: authConfig.clientId, sub: "123", exp: now + 60, nbf: now }].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
const token = `${unsigned}.${createHmac("sha256", authConfig.clientSecret).update(unsigned).digest("base64url")}`;
const product = { id: "me1-s1", game: "pokemon" as const, name: "Mega Evolution Booster Pack", setName: "Mega Evolution",
  language: "English" as const, unit: "Booster pack", imageUrl: null, marketCents: 713 };
const quote = { code: "012345678905", product, currency: "USD" as const, fetchedAt: "2026-09-24T01:00:00.000Z", mappingSource: "saved" as const };
const scan = { action: "scan", code: quote.code };
const link = { action: "link", code: quote.code, id: product.id, expectedId: null };
function request(body: unknown = scan, headers: Record<string, string> = {}) {
  return new Request("https://defy.example/api/shopify/pos/sealed-pricing", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function harness(overrides: Partial<SealedPricingDependencies> = {}) {
  const calls: unknown[] = [];
  return { calls, handle: (incoming: Request) => handlePosSealedPricingRequest(incoming, {
    authConfig, nowSeconds: now,
    scan: async code => { calls.push(code); return { status: "quoted", quote: { ...quote, product: { ...product, secret: "private" } } }; },
    link: async value => { calls.push(value); return { status: "quoted", quote }; }, ...overrides,
  }) };
}

test("sealed price actions authenticate and emit only safe quote fields with no caching", async () => {
  const { handle, calls } = harness();
  const response = await handle(request({ ...scan, code: ` ${quote.code} ` }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "quoted", quote });
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal((await handle(request(link))).status, 200);
  assert.deepEqual(calls, [quote.code, { code: quote.code, id: product.id, expectedId: null }]);
  assert.equal((await handle(request({ ...link, expectedId: "old-s1" }))).status, 200);
});

test("unknown manufacturer code remains an explicit unmapped result", async () => {
  const { handle } = harness({ scan: async code => ({ status: "unmapped", code, suggestedQuery: "Mega Evolution" }) });
  assert.deepEqual(await (await handle(request())).json(), { status: "unmapped", code: quote.code, suggestedQuery: "Mega Evolution" });
});

test("unauthenticated scans and mapping writes never reach Shopify or Scrydex", async () => {
  const { handle, calls } = harness();
  for (const authorization of ["", "Bearer undefined", `Bearer ${token}x`, "Basic 123"]) {
    for (const input of [scan, link]) assert.equal((await handle(request(input, { authorization, cookie: "neon-auth-session=example" }))).status, 401);
  }
  assert.equal(calls.length, 0);
});

test("sealed price CORS is limited to Shopify and has a constrained preflight", async () => {
  const { handle, calls } = harness();
  for (const origin of ["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]) {
    const response = await handle(request(scan, { origin }));
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.status, 200);
  }
  for (const origin of ["null", "https://attacker.example", "https://cdn.shopify.com.attacker.example"]) {
    assert.equal((await handle(request(link, { origin }))).status, 403);
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

test("mapping input rejects supplied prices, missing comparison IDs, malformed JSON and oversized bodies", async () => {
  const { handle, calls } = harness();
  for (const input of [null, [], {}, { action: "scan", code: "" }, { ...scan, code: 123 }, { ...scan, code: "a".repeat(129) },
    { ...scan, code: "a\nb" }, { ...scan, marketCents: 1 }, { ...scan, game: "other" }, { ...link, id: "../secret" },
    { action: "link", code: quote.code, id: product.id }, { ...link, expectedId: 123 }, { ...link, action: "delete" },
    { ...link, expectedId: "../secret" }, { ...link, marketCents: 1 }]) {
    assert.equal((await handle(request(input))).status, 400);
  }
  assert.equal((await handle(request(scan, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handle(request(scan, { "content-encoding": "gzip" }))).status, 415);
  for (const length of [undefined, "1", "3000"]) {
    assert.equal((await handle(request({ ...scan, code: "字".repeat(1000) }, length ? { "content-length": length } : {}))).status, 413);
  }
  assert.equal((await handle(new Request("https://defy.example", { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json",
  }, body: "{" }))).status, 400);
  assert.equal(calls.length, 0);
});

test("upstream failures never leak credentials or return a previous price", async () => {
  for (const [error, status] of [[new ScrydexError("upstream_error", "SECRET"), 503],
    [new ScrydexError("not_found", "SECRET"), 404], [new ScrydexError("price_unavailable", "SECRET"), 422],
    [new Error("SECRET"), 503]] as const) {
    const { handle } = harness({ scan: async () => { throw error; }, link: async () => { throw error; } });
    for (const input of [scan, link]) {
      const response = await handle(request(input));
      assert.equal(response.status, status);
      const text = await response.text();
      assert.doesNotMatch(text, /SECRET|marketCents/);
    }
  }
});

test("POS exception is exact and production composition uses fresh sealed quotes", async () => {
  const proxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /api\/shopify\/pos\/sealed-pricing\$/);
  const route = await readFile(new URL("../app/api/shopify/pos/sealed-pricing/route.ts", import.meta.url), "utf8");
  assert.match(route, /getSealedCatalogProduct\(\{ game: "pokemon", id \}, \{ fresh: true \}\)/);
  assert.match(route, /handlePosSealedPricingRequest/);
  assert.doesNotMatch(route, /refreshPosPrice/);
});

test("unavailable saved prices expose only the identity needed to correct the match", async () => {
  const error = Object.assign(new SealedPricingError("PRICE_UNAVAILABLE", "Scrydex has no current price.", 422), {
    match: { id: product.id, source: "saved" as const, secret: "PRIVATE" },
  });
  const { handle } = harness({ scan: async () => { throw error; } });
  const response = await handle(request());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { code: "PRICE_UNAVAILABLE", error: "Scrydex has no current price.", match: { id: product.id, source: "saved" } });
});
