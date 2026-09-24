import assert from "node:assert/strict";
import test from "node:test";
import { buildMonthlySinglesReport, classifyMonthlySingle, monthlySinglesMonth, monthlySinglesMoneyCents, MonthlySinglesError,
  type MonthlySinglesLine, type MonthlySinglesOrder, type MonthlySinglesProduct } from "../lib/reports/monthly-singles.ts";
import { fetchMonthlySinglesReport } from "../lib/reports/monthly-singles-service.ts";
import type { SinglesGraphQL } from "../lib/singles/shopify.ts";

const now = new Date("2026-09-23T18:00:00.000Z");
const product: MonthlySinglesProduct = { id: "gid://shopify/Product/1", productType: "Riftbound single", tags: ["Riftbound", "Singles"], game: { value: "Riftbound" } };
function line(id: number, changes: Partial<MonthlySinglesLine> = {}): MonthlySinglesLine {
  return { id: `gid://shopify/LineItem/${id}`, title: "Blitzcrank", variantTitle: "Near Mint / Normal", sku: "DEFY-RFB-1", currentQuantity: 2, isGiftCard: false,
    priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: "7.35", currencyCode: "USD" } },
    variant: { id: "gid://shopify/ProductVariant/1" }, product, ...changes };
}
function order(id: number, lines = [line(id)], changes: Partial<MonthlySinglesOrder> = {}): MonthlySinglesOrder {
  return { id: `gid://shopify/Order/${id}`, createdAt: "2026-09-12T18:00:00.000Z", updatedAt: "2026-09-20T18:00:00.000Z", sourceName: "pos", test: false,
    cancelledAt: null, displayFinancialStatus: "PAID", lines, ...changes };
}
function build(orders: MonthlySinglesOrder[], month = "2026-09") {
  return buildMonthlySinglesReport({ period: monthlySinglesMonth(month, now), orders, shopTimeZone: "America/Los_Angeles", currencyCode: "USD", generatedAt: now.toISOString() });
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof MonthlySinglesError && error.code === code;
}
const page = <T>(nodes: T[], endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });
function node(value: MonthlySinglesOrder, cursor: string | null = null) {
  const { lines, ...rest } = value;
  return { ...rest, lineItems: page(lines, cursor) };
}
const metadata = (scopes = ["read_orders", "read_products"], currencyCode = "USD") => ({
  shop: { currencyCode, ianaTimezone: "America/Los_Angeles" }, currentAppInstallation: { accessScopes: scopes.map(handle => ({ handle })) },
});
function mock(read: (query: string, variables?: Record<string, unknown>) => unknown): SinglesGraphQL {
  return async <T>(query: string, variables?: Record<string, unknown>) => read(query, variables) as T;
}

test("month boundaries use LA midnight, including DST changes on November 1 and leap years", () => {
  const future = new Date("2027-01-01T12:00:00Z");
  assert.deepEqual(monthlySinglesMonth("2026-03", future), { month: "2026-03", startAt: "2026-03-01T08:00:00.000Z", endAt: "2026-04-01T07:00:00.000Z", monthToDate: false });
  assert.deepEqual(monthlySinglesMonth("2026-11", future), { month: "2026-11", startAt: "2026-11-01T07:00:00.000Z", endAt: "2026-12-01T08:00:00.000Z", monthToDate: false });
  assert.equal((Date.parse(monthlySinglesMonth("2024-02", now).endAt) - Date.parse(monthlySinglesMonth("2024-02", now).startAt)) / 86_400_000, 29);
  assert.equal(monthlySinglesMonth(undefined, new Date("2026-10-01T06:59:59Z")).month, "2026-09");
  assert.equal(monthlySinglesMonth(undefined, new Date("2026-10-01T07:00:00Z")).month, "2026-10");
  for (const invalid of ["2026-9", "2026-00", "2026-13", "2026-09-01", " 2026-09", "", 202609, [], {}]) assert.throws(() => monthlySinglesMonth(invalid, now), errorCode("INVALID_MONTH"));
  assert.throws(() => monthlySinglesMonth("2026-10", now), errorCode("FUTURE_MONTH"));
});

test("current units and exact remaining line totals handle refunds, discounts, quantities, and channel grouping", () => {
  const result = build([
    order(1, [line(1)]),
    order(2, [line(2, { currentQuantity: 1, priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: "3.25", currencyCode: "USD" } } })], { sourceName: "web", displayFinancialStatus: "PARTIALLY_REFUNDED" }),
    order(3, [line(3), line(4)], { sourceName: null }),
  ]);
  assert.deepEqual(result.rows[0], { rank: 1, variantId: "gid://shopify/ProductVariant/1", productId: product.id, name: "Blitzcrank", variantTitle: "Near Mint / Normal",
    sku: "DEFY-RFB-1", game: "Riftbound", netUnits: 7, itemSalesCents: 2530, orderCount: 3, channels: { pos: 2, web: 1, other: 4 } });
  assert.equal(result.totals.eligibleOrders, 3);
  assert.equal(result.complete, true);
  assert.match(result.notes.join(" "), /money-only order refunds/);
  assert.match(result.notes.join(" "), /Later refunds or order edits/);
});

test("test, cancelled, unpaid and fully refunded orders are excluded; zero remaining units do not rank", () => {
  const result = build([
    order(1, [line(1)], { test: true }),
    order(2, [line(2)], { cancelledAt: "2026-09-13T00:00:00Z" }),
    ...["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "VOIDED", "REFUNDED", "EXPIRED", null].map((status, index) => order(index + 3, [line(index + 3)], { displayFinancialStatus: status })),
    order(10, [line(10, { currentQuantity: 0 })]),
  ]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.excluded.testOrders, 1);
  assert.equal(result.excluded.cancelledOrders, 1);
  assert.equal(result.excluded.unpaidOrders, 7);
  assert.equal(result.excluded.zeroQuantityLines, 1);
  assert.equal(result.totals.eligibleOrders, 1);
});

test("only explicit singles metadata classifies; titles never classify, deleted and conflicting metadata remain visible in counts", () => {
  assert.deepEqual(classifyMonthlySingle({ ...product, productType: "Pokémon single", tags: [], game: null }), { kind: "single", game: "Pokémon" });
  assert.deepEqual(classifyMonthlySingle({ ...product, productType: "", tags: ["Singles", "Magic"], game: null }), { kind: "single", game: "MTG" });
  const result = build([order(1, [
    line(1, { title: "Rare Pokémon single", product: { ...product, productType: "", tags: [], game: null } }),
    line(2, { product: { ...product, productType: "Riftbound sealed", tags: [] } }),
    line(3, { product: { ...product, productType: "Booster box", tags: ["Singles"] } }),
    line(4, { variant: null }), line(5, { product: null }), line(6, { isGiftCard: true }),
    line(7, { product: { ...product, productType: "Custom category", tags: ["singles"] } }),
  ])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].netUnits, 2);
  assert.deepEqual(result.excluded, { testOrders: 0, cancelledOrders: 0, unpaidOrders: 0, nonSingleLines: 2, unclassifiedLines: 2, deletedLines: 2, zeroQuantityLines: 0 });
});

test("variants stay separate, ranking uses units then item sales then stable ID, totals include beyond top 50", () => {
  const lines = Array.from({ length: 55 }, (_, index) => line(index + 1, {
    variant: { id: `gid://shopify/ProductVariant/${String(index + 1).padStart(3, "0")}` }, variantTitle: `${index} / Foil`,
    currentQuantity: index === 52 ? 3 : 2,
    priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: index === 53 ? "12.34" : "7.35", currencyCode: "USD" } },
  }));
  const result = build([order(1, lines.reverse())]);
  assert.equal(result.rows.length, 50);
  assert.deepEqual(result.rows.slice(0, 3).map(row => row.variantId), ["gid://shopify/ProductVariant/053", "gid://shopify/ProductVariant/054", "gid://shopify/ProductVariant/001"]);
  assert.equal(result.totals.distinctVariants, 55);
  assert.equal(result.totals.netUnits, 111);
  assert.equal(result.rows[49].rank, 50);
});

test("USD money parses without floating multiplication drift and rejects malformed, fractional cent, negative or unsafe values", () => {
  assert.equal(monthlySinglesMoneyCents("1.10", "USD"), 110);
  assert.equal(monthlySinglesMoneyCents("0.01", "USD"), 1);
  assert.equal(monthlySinglesMoneyCents("7", "USD"), 700);
  for (const value of ["NaN", "Infinity", "1e2", "-1.00", "1.001", "$2.00", " 1.00", 1, null, "90071992547409.92"]) assert.throws(() => monthlySinglesMoneyCents(value, "USD"), errorCode("INCOMPLETE_DATA"));
  assert.throws(() => monthlySinglesMoneyCents("1.00", "CAD"), errorCode("UNSUPPORTED_CURRENCY"));
  assert.throws(() => build([order(1, [line(1, { currentQuantity: -1 })])]), errorCode("INCOMPLETE_DATA"));
  assert.throws(() => build([order(1, [line(1), line(1)])]), errorCode("INCOMPLETE_DATA"));
  assert.throws(() => build([order(1), order(1)]), errorCode("INCOMPLETE_DATA"));
});

test("month is a half-open interval in LA, not UTC", () => {
  assert.equal(build([order(1, [line(1)], { createdAt: "2026-09-01T07:00:00.000Z" })]).totals.netUnits, 2);
  assert.equal(build([order(1, [line(1)], { createdAt: "2026-10-01T06:59:59.999Z" })]).totals.netUnits, 2);
  for (const date of ["2026-09-01T06:59:59.999Z", "2026-10-01T07:00:00.000Z", "invalid"]) {
    assert.throws(() => build([order(1, [line(1)], { createdAt: date })]), errorCode("INCOMPLETE_DATA"));
  }
});

test("read_orders is checked before order acquisition even when historical access is present", async () => {
  let calls = 0;
  await assert.rejects(fetchMonthlySinglesReport(mock(query => { calls++; assert.match(query, /DefyMonthlySinglesAccess/); return metadata(["read_all_orders", "write_products"]); }), "2026-09", { now }), errorCode("ORDER_ACCESS_REQUIRED"));
  assert.equal(calls, 1);
});

test("months crossing the 60-day window require read_all_orders rather than reporting a partial month", async () => {
  let calls = 0;
  await assert.rejects(fetchMonthlySinglesReport(mock(() => { calls++; return metadata(); }), "2026-07", { now }), errorCode("HISTORICAL_ACCESS_REQUIRED"));
  assert.equal(calls, 1);
  const result = await fetchMonthlySinglesReport(mock(query => query.includes("Access") ? metadata(["read_orders", "read_all_orders"]) : { orders: page([]) }), "2026-07", { now });
  assert.equal(result.complete, true);
  assert.equal(result.totals.scannedOrders, 0);
  await assert.rejects(fetchMonthlySinglesReport(mock(() => { throw new Error("must not fetch"); }), "2026-10", { now }), errorCode("FUTURE_MONTH"));
});

test("orders and nested lines paginate completely through only queries without personal customer fields", async () => {
  const calls: string[] = [];
  const first = order(1, [line(1)]);
  const result = await fetchMonthlySinglesReport(mock((query, variables) => {
    calls.push(query);
    assert.match(query, /^query /);
    assert.doesNotMatch(query, /\b(mutation|customer|email|phone|billingAddress|shippingAddress)\b/);
    if (query.includes("Access")) return metadata();
    if (query.includes("Lines")) {
      assert.deepEqual(variables, { id: first.id, after: "line-next" });
      return { order: { id: first.id, updatedAt: first.updatedAt, lineItems: page([line(2)]) } };
    }
    assert.equal(variables?.query, "created_at:>='2026-09-01T07:00:00.000Z' created_at:<'2026-10-01T07:00:00.000Z'");
    if (variables?.after === null) return { orders: page([node(first, "line-next")], "order-next") };
    assert.equal(variables?.after, "order-next");
    return { orders: page([node(order(2, [line(3)], { sourceName: "web" }))]) };
  }), "2026-09", { now });
  assert.equal(calls.length, 4);
  assert.equal(result.totals.scannedOrders, 2);
  assert.equal(result.rows[0].netUnits, 6);
  assert.equal(result.rows[0].orderCount, 2);
});

test("pagination rejects repeated, missing cursors, duplicate orders, and an order changed during line reads", async () => {
  const first = order(1);
  await assert.rejects(fetchMonthlySinglesReport(mock(query => query.includes("Access") ? metadata() : { orders: { nodes: [node(first)], pageInfo: { hasNextPage: true, endCursor: null } } }), "2026-09", { now }), errorCode("INCOMPLETE_DATA"));
  await assert.rejects(fetchMonthlySinglesReport(mock(query => query.includes("Access") ? metadata() : { orders: page([node(first)], "repeated") }), "2026-09", { now }), errorCode("INCOMPLETE_DATA"));
  await assert.rejects(fetchMonthlySinglesReport(mock(query => query.includes("Access") ? metadata() : { orders: page([node(first), node(first)]) }), "2026-09", { now }), errorCode("INCOMPLETE_DATA"));
  await assert.rejects(fetchMonthlySinglesReport(mock(query => query.includes("Access") ? metadata() : query.includes("Lines")
    ? { order: { id: first.id, updatedAt: "2026-09-21T00:00:00Z", lineItems: page([line(2)]) } }
    : { orders: page([node(first, "more")]) }), "2026-09", { now }), errorCode("INCOMPLETE_DATA"));
});

test("page or duration limits fail explicitly even after valid rows have been read", async () => {
  let calls = 0;
  const graphql = mock(query => { calls++; return query.includes("Access") ? metadata() : { orders: page([node(order(calls))], `next-${calls}`) }; });
  await assert.rejects(fetchMonthlySinglesReport(graphql, "2026-09", { now, maxPages: 2 }), errorCode("REPORT_LIMIT"));
  assert.equal(calls, 2);
  let time = 0;
  await assert.rejects(fetchMonthlySinglesReport(mock(query => query.includes("Access") ? metadata() : { orders: page([]) }), "2026-09", { now, maxDurationMs: 50, clock: () => time += 20 }), errorCode("REPORT_LIMIT"));
});

test("connection errors are sanitized and USD currency is enforced before order reads", async () => {
  await assert.rejects(fetchMonthlySinglesReport(mock(() => { throw Object.assign(new Error("private upstream details"), { code: "ACCESS_DENIED" }); }), "2026-09", { now }), errorCode("ORDER_ACCESS_REQUIRED"));
  await assert.rejects(fetchMonthlySinglesReport(mock(() => { throw new Error("customer@example.com secret-token"); }), "2026-09", { now }), error => {
    assert.ok(error instanceof MonthlySinglesError);
    assert.equal(error.code, "SHOPIFY_UNAVAILABLE");
    assert.doesNotMatch(error.message, /customer@|secret-token/);
    return true;
  });
  let calls = 0;
  await assert.rejects(fetchMonthlySinglesReport(mock(() => { calls++; return metadata(["read_orders"], "CAD"); }), "2026-09", { now }), errorCode("UNSUPPORTED_CURRENCY"));
  assert.equal(calls, 1);
});

test("explicit read throttles retry the identical page without duplicate orders or lines", async () => {
  const delays: number[] = [];
  const requests: { query: string; variables?: Record<string, unknown> }[] = [];
  let throttled = false;
  const result = await fetchMonthlySinglesReport(mock((query, variables) => {
    if (query.includes("Access")) return metadata();
    requests.push({ query, variables });
    if (variables?.after === null) return { orders: page([node(order(1, [line(1)]))], "next") };
    if (!throttled) { throttled = true; throw Object.assign(new Error("rate limit"), { code: "THROTTLED" }); }
    return { orders: page([node(order(2, [line(2)]))]) };
  }), "2026-09", { now, wait: async milliseconds => { delays.push(milliseconds); } });
  assert.deepEqual(delays, [1000]);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(result.totals.scannedOrders, 2);
  assert.equal(result.totals.netUnits, 4);
});

test("exhausted throttles fail closed after three retries and other errors do not retry", async () => {
  const delays: number[] = [];
  let attempts = 0;
  await assert.rejects(fetchMonthlySinglesReport(mock(query => {
    if (query.includes("Access")) return metadata();
    attempts++;
    throw Object.assign(new Error("rate limit"), { code: "THROTTLED" });
  }), "2026-09", { now, wait: async milliseconds => { delays.push(milliseconds); } }), errorCode("SHOPIFY_UNAVAILABLE"));
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
  for (const code of ["INTERNAL_SERVER_ERROR", "ACCESS_DENIED", "NETWORK_ERROR"]) {
    let retries = 0;
    await assert.rejects(fetchMonthlySinglesReport(mock(() => { throw Object.assign(new Error("unavailable"), { code }); }), "2026-09", {
      now, wait: async () => { retries++; },
    }));
    assert.equal(retries, 0);
  }
});

test("throttle attempts and waits cannot exceed the existing page or time budget", async () => {
  let waits = 0;
  const graphql = mock(query => {
    if (query.includes("Access")) return metadata();
    throw Object.assign(new Error("rate limit"), { code: "THROTTLED" });
  });
  await assert.rejects(fetchMonthlySinglesReport(graphql, "2026-09", { now, maxPages: 2, wait: async () => { waits++; } }), errorCode("REPORT_LIMIT"));
  await assert.rejects(fetchMonthlySinglesReport(graphql, "2026-09", { now, maxDurationMs: 1000, clock: () => 0, wait: async () => { waits++; } }), errorCode("REPORT_LIMIT"));
  assert.equal(waits, 0);
  let time = 0;
  await assert.rejects(fetchMonthlySinglesReport(graphql, "2026-09", { now, maxDurationMs: 1500, clock: () => time,
    wait: async () => { waits++; time = 1500; },
  }), errorCode("REPORT_LIMIT"));
  assert.equal(waits, 1);
});
