import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ScrydexError } from "../lib/scrydex.ts";
import { handlePosPricingRequest, type PosPricingResult } from "../lib/shopify/pos-handler.ts";

const now = 1_800_000_000;
const authConfig = { shop: "defy-receiving-test.myshopify.com", clientId: "test-pos-app", clientSecret: "test-pos-secret" };
const body = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({
  iss: `https://${authConfig.shop}/admin`, dest: `https://${authConfig.shop}`, aud: authConfig.clientId,
  sub: "12345", exp: now + 60, nbf: now,
})).toString("base64url")}`;
const token = `${body}.${createHmac("sha256", authConfig.clientSecret).update(body).digest("base64url")}`;
const result: PosPricingResult = {
  variantId: 123, productId: "gid://shopify/Product/456", sku: "DEFY-RFB-652821-NORMAL-EN-NM",
  title: "Blitzcrank, Impassive", priceCents: 1100, currency: "USD", scrydexId: "ogn-061",
};
function request(payload: unknown = { code: result.sku }, extraHeaders: Record<string, string> = {}) {
  return new Request("https://defy.example/api/shopify/pos/pricing", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(payload) });
}
function harness(refresh?: (code: string) => Promise<PosPricingResult>) {
  const calls: string[] = [];
  const handle = (incoming: Request) => handlePosPricingRequest(incoming, {
    authConfig, nowSeconds: now, refresh: async (code) => { calls.push(code); return refresh ? refresh(code) : result; },
  });
  return { calls, handle };
}

test("POS scan passes only the exact scanned code after bearer authentication and returns the customer price", async () => {
  const { handle, calls } = harness(async () => ({ ...result, privateData: "do-not-expose" }));
  const response = await handle(request({ code: ` ${result.sku} ` }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [result.sku]);
  assert.deepEqual(await response.json(), result);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("POS scan never calls Shopify or Scrydex for missing, invalid, or cookie-only authentication", async () => {
  const { handle, calls } = harness();
  for (const authorization of ["", "Bearer undefined", "Bearer null", "Basic xyz", `${token}`, `Bearer ${token} another`, `Bearer ${token}x`]) {
    const response = await handle(request({ code: result.sku }, { authorization, cookie: "neon-auth-session=example" }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "unauthorized");
  }
  assert.deepEqual(calls, []);
});

test("POS scan accepts only Shopify extension origins or a native request without an origin", async () => {
  const { handle, calls } = harness();
  for (const origin of ["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]) {
    const response = await handle(request({ code: result.sku }, { origin }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("vary"), "Origin");
  }
  for (const origin of ["null", "https://attacker.example", "https://cdn.shopify.com.attacker.example", "http://cdn.shopify.com", "https://defy.example"]) {
    const response = await handle(request({ code: result.sku }, { origin }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(calls.length, 2);
});

test("POS CORS preflight requires no credentials, configuration, Shopify, or Scrydex requests", async () => {
  let calls = 0;
  const response = await handlePosPricingRequest(new Request("https://defy.example/api/shopify/pos/pricing", {
    method: "OPTIONS", headers: { origin: "https://cdn.shopify.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
  }), { authConfig: { shop: "", clientId: "", clientSecret: "" }, refresh: async () => { calls++; return result; } });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Authorization, Content-Type");
  assert.equal(calls, 0);
});

test("POS rejects unsupported methods and preflight headers without downstream requests", async () => {
  const { handle, calls } = harness();
  assert.equal((await handle(new Request("https://defy.example", { method: "GET" }))).status, 405);
  const preflights: Record<string, string>[] = [{ "access-control-request-method": "DELETE" }, { "access-control-request-headers": "authorization, cookie" }];
  for (const headers of preflights) {
    assert.equal((await handle(new Request("https://defy.example", { method: "OPTIONS", headers }))).status, 400);
  }
  assert.deepEqual(calls, []);
});

test("POS rejects client prices, identities, malformed JSON, and unsupported bodies before pricing", async () => {
  const { handle, calls } = harness();
  for (const payload of [null, [], {}, { code: "" }, { code: " " }, { code: 123 }, { code: "x".repeat(129) }, { code: "SKU\nOTHER" },
    { code: result.sku, priceCents: 1 }, { code: result.sku, variantId: 999 }, { code: result.sku, game: "pokemon" }]) {
    assert.equal((await handle(request(payload))).status, 400);
  }
  const malformed = new Request("https://defy.example", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" });
  assert.equal((await handle(malformed)).status, 400);
  assert.equal((await handle(request({ code: result.sku }, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handle(request({ code: result.sku }, { "content-encoding": "gzip" }))).status, 415);
  assert.deepEqual(calls, []);
});

test("POS enforces the 2 KB byte limit including streamed requests with an absent or false Content-Length", async () => {
  const { handle, calls } = harness();
  const lengthHeaders: Record<string, string>[] = [{}, { "content-length": "1" }, { "content-length": "2049" }];
  for (const headers of lengthHeaders) {
    const response = await handle(request({ code: "x".repeat(2049) }, headers));
    assert.equal(response.status, 413);
  }
  // The limit counts UTF-8 bytes rather than JavaScript string length.
  assert.equal((await handle(request({ code: "字".repeat(700) }))).status, 413);
  assert.deepEqual(calls, []);
});

test("POS errors return fixed actionable messages without leaking provider responses or secrets", async () => {
  for (const [failure, status, code] of [
    [new ScrydexError("upstream_error", "secret-provider-response"), 503, "upstream_error"],
    [new ScrydexError("ambiguous", "secret-provider-response"), 409, "ambiguous"],
    [Object.assign(new Error("secret-provider-response"), { name: "PosPricingError", code: "AMBIGUOUS_CODE", status: 409 }), 409, "AMBIGUOUS_CODE"],
    [Object.assign(new Error("secret-provider-response"), { name: "PosPricingError", code: "CURRENCY_UNSUPPORTED", status: 422 }), 422, "CURRENCY_UNSUPPORTED"],
    [new Error("secret-provider-response"), 503, "pricing_unavailable"],
  ] as const) {
    const { handle } = harness(async () => { throw failure; });
    const response = await handle(request());
    assert.equal(response.status, status);
    const responseBody = await response.json();
    assert.equal(responseBody.code, code);
    assert.doesNotMatch(JSON.stringify(responseBody), /secret-provider-response|test-pos-secret/);
  }
});
