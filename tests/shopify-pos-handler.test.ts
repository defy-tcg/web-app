import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { ScrydexError } from "../lib/scrydex.ts";
import { handlePosPricingRequest, type PosPricingFailureReport, type PosPricingResult } from "../lib/shopify/pos-handler.ts";

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
  const failures: PosPricingFailureReport[] = [];
  const handle = (incoming: Request) => handlePosPricingRequest(incoming, {
    authConfig, nowSeconds: now, reportFailure: (failure) => { failures.push(failure); },
    refresh: async (code) => { calls.push(code); return refresh ? refresh(code) : result; },
  });
  return { calls, failures, handle };
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

test("POS failure reports distinguish authentication, input, Shopify lookup, and Scrydex failures with matching request IDs", async () => {
  const cases = [
    { incoming: request({ code: "PRIVATE-SKU" }, { authorization: "Bearer PRIVATE-TOKEN" }), code: "unauthorized", stage: "auth", status: 401 },
    { incoming: request({ code: "PRIVATE-SKU", price: 999 }), code: "invalid_code", stage: "input", status: 400 },
    { incoming: request(), error: Object.assign(new Error("PRIVATE-SHOPIFY-RESPONSE"), { name: "PosPricingError", code: "NOT_FOUND", status: 404 }), code: "NOT_FOUND", stage: "lookup", status: 404 },
    { incoming: request(), error: new ScrydexError("not_found", "PRIVATE-SCRYDEX-RESPONSE"), code: "not_found", stage: "lookup", status: 404 },
  ] as const;
  const ids = new Set<string>();
  for (const scenario of cases) {
    const { handle, failures } = harness(async () => { if ("error" in scenario) throw scenario.error; return result; });
    const response = await handle(scenario.incoming);
    const responseBody = await response.json();
    assert.match(responseBody.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(response.status, scenario.status);
    assert.deepEqual(failures, [{ event: "shopify_pos_pricing_failed", requestId: responseBody.requestId,
      stage: scenario.stage, code: scenario.code, status: scenario.status }]);
    const logged = JSON.stringify(failures);
    for (const sensitive of ["PRIVATE", token, authConfig.clientSecret, result.sku, result.title, result.scrydexId]) {
      assert.equal(logged.includes(sensitive), false);
    }
    ids.add(responseBody.requestId);
  }
  assert.equal(ids.size, cases.length);
});

test("POS not-found errors distinguish an unlinked Shopify barcode from an unmatched Scrydex identity", async () => {
  const shopify = harness(async () => { throw Object.assign(new Error("provider details"), { name: "PosPricingError", code: "NOT_FOUND", status: 404 }); });
  const scrydex = harness(async () => { throw new ScrydexError("not_found", "provider details"); });
  const shopifyBody = await (await shopify.handle(request())).json();
  const scrydexBody = await (await scrydex.handle(request())).json();
  assert.equal(shopifyBody.error, "This barcode or SKU is not linked to a Shopify product. Add the exact code to its Shopify variant before scanning again.");
  assert.equal(scrydexBody.error, "Shopify found the product, but its name and set do not match a Scrydex sealed product or card.");
});

test("POS failure reports allow only known error codes and exclude request IDs supplied by the client", async () => {
  const { handle, failures } = harness(async () => {
    throw Object.assign(new Error("PRIVATE-EXCEPTION"), { name: "PosPricingError", code: "PRIVATE_SKU_AS_ERROR_CODE", status: 404 });
  });
  const response = await handle(request({ code: "PRIVATE-SKU" }, { "x-request-id": "PRIVATE-CLIENT-ID" }));
  const responseBody = await response.json();
  assert.equal(response.status, 503);
  assert.equal(responseBody.code, "pricing_unavailable");
  assert.equal(failures[0].code, "pricing_unavailable");
  assert.equal(failures[0].requestId, responseBody.requestId);
  assert.doesNotMatch(JSON.stringify({ responseBody, failures }), /PRIVATE/);
});

test("POS production failures emit one structured console warning without raw exceptions", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const response = await handlePosPricingRequest(request(), {
    authConfig, nowSeconds: now, refresh: async () => { throw new Error("PRIVATE-EXCEPTION"); },
  });
  const responseBody = await response.json();
  assert.equal(warning.mock.callCount(), 1);
  const args = warning.mock.calls[0].arguments;
  assert.equal(args.length, 1);
  assert.equal(typeof args[0], "string");
  assert.deepEqual(JSON.parse(args[0]), { event: "shopify_pos_pricing_failed", requestId: responseBody.requestId,
    stage: "lookup", code: "pricing_unavailable", status: 503 });
  assert.doesNotMatch(args[0], /PRIVATE/);
});

test("POS failed POST origin checks are classified without logging the origin or request", async () => {
  const { handle, failures, calls } = harness();
  const response = await handle(request({ code: "PRIVATE-SKU" }, { origin: "https://private.example" }));
  assert.equal(response.status, 403);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, "auth");
  assert.equal(failures[0].code, "origin_not_allowed");
  assert.equal(failures[0].requestId, (await response.json()).requestId);
  assert.doesNotMatch(JSON.stringify(failures), /private|PRIVATE/);
  assert.deepEqual(calls, []);
});

test("POS observability never changes failures and does not log successful scans or non-POST requests", async () => {
  const { handle, failures } = harness();
  assert.equal((await handle(request())).status, 200);
  assert.equal((await handle(new Request("https://defy.example", { method: "OPTIONS" }))).status, 204);
  assert.equal((await handle(new Request("https://defy.example", { method: "GET" }))).status, 405);
  assert.deepEqual(failures, []);
  const response = await handlePosPricingRequest(request(), {
    authConfig, nowSeconds: now, refresh: async () => { throw new ScrydexError("not_found", "PRIVATE-EXCEPTION"); },
    reportFailure: () => { throw new Error("Logging service failed"); },
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");
});
