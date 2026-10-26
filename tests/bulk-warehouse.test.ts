import assert from "node:assert/strict";
import test from "node:test";
import { BULK_BODY_LIMIT, BULK_COMMAND_LIMIT, BULK_EVENT_LIMIT, BulkError, digest, orderSaleQuery, parseCommand, parseCopy, parseNativeOrderSale, parseOrder, parseSync, readBulkBody,
  type CopyData, type SyncInput } from "../lib/bulk-warehouse/model.ts";
import { nativeOrderSaleHandler, nativeSyncHandler, webBulkHandler } from "../lib/bulk-warehouse/http.ts";
import { inventoryQuery, translateBulkError } from "../lib/bulk-warehouse/store.ts";

import { groupBulkCopies } from "../lib/bulk-warehouse/grouping.ts";

const warehouseId = "11111111-1111-4111-a111-111111111111";
const requestId = "22222222-2222-4222-a222-222222222222";
const origin = "https://defy-store-os.example.test";
const nativeURL = `${origin}/api/native-warehouse/sync`;
const webURL = `${origin}/api/bulk-warehouse`;
const copy = (changes: Partial<CopyData> = {}): CopyData => ({ fingerprint: "a".repeat(64), masterId: "exact-printing-1", serial: "RFB-1", name: "Test card",
  setName: "Origins", cardNumber: "001", rarity: "Common", sku: "RFB-TEST", condition: "Near Mint", finish: "Nonfoil", language: "EN",
  status: "available", available: true, location: "Box A / row 1", tcgplayerUrl: "https://www.tcgplayer.com/product/12345",
  imageUrl: "https://example.test/card.jpg", costCents: null, listPriceCents: 50, ...changes });
const sync = (changes: Partial<SyncInput> = {}): SyncInput => ({ protocol: 1, warehouseId, workspace: "riftbound", name: "Test Mac", after: 0,
  events: [{ sequence: 1, entityId: "copy-1", kind: "copy", data: copy() }], receipts: [], ...changes });
const removal = () => ({ requestId, warehouseId, kind: "remove", copies: [{ copyId: "copy-1", expectedFingerprint: "a".repeat(64) }], note: "Test removal", sale: null });
const sale = () => ({ ...removal(), kind: "sale", sale: { unitPriceCents: 50, unitCostCents: null, soldAt: "2026-01-01T12:00:00.000Z", channel: "In-store", paymentMethod: "Card", taxCents: 5, discountCents: 1 } });
const nativeSale = () => ({ requestId, warehouseId, orderId: "native-order", expectedFingerprint: "a".repeat(64), copyIds: ["copy-2", "copy-1"], note: "Actual receipt",
  sale: { subtotalCents: 1001, discountCents: 1, taxCents: 9, totalCostCents: null, soldAt: "2026-01-01T12:00:00.000Z", channel: "In-store", paymentMethod: "Card" } });
const isStatus = (status: number) => (error: unknown) => error instanceof BulkError && error.status === status;
function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function nativeHarness(approved = true) {
  const calls: unknown[][] = [];
  const handle = nativeSyncHandler({
    authorize: async request => {
      calls.push(["authorize"]);
      return approved && request.headers.get("Authorization") === "Bearer approved-native" ? { account: { id: "verified-owner" } } : null;
    },
    sync: async (owner, input) => { calls.push(["sync", owner, input]); return { ackSequence: input.events.at(-1)?.sequence ?? input.after }; },
  });
  return { handle, calls };
}
function webHarness(approved = true) {
  const calls: unknown[][] = [];
  const handle = webBulkHandler({
    authorize: async () => { calls.push(["authorize"]); return approved ? { user: { id: "verified-actor" } } : null; },
    inventory: async filters => { calls.push(["inventory", filters]); return { copies: [] }; },
    queue: async (actor, command) => { calls.push(["queue", actor, command]); return { id: command.requestId, status: "pending" }; },
  });
  return { handle, calls };
}

test("bulk protocol preserves exact printing identity and unknown costs without coercing free stock", () => {
  const parsed = parseSync(sync());
  assert.deepEqual(parsed, sync());
  assert.equal(parsed.events[0].kind, "copy");
  if (parsed.events[0].kind === "copy") assert.equal(parsed.events[0].data.costCents, null);
  assert.equal(parseCopy(copy({ costCents: 0 })).costCents, 0);
  assert.equal(parseCopy(copy({ sku: "s".repeat(250) })).sku.length, 250);
  assert.throws(() => parseCopy(copy({ sku: "s".repeat(251) })), isStatus(400));
  assert.equal(parseCopy(copy({ sku: "🃏".repeat(250) })).sku, "🃏".repeat(250));
  assert.throws(() => parseCopy(copy({ sku: "🃏".repeat(251) })), isStatus(400));
  assert.notEqual(digest(copy()), digest(copy({ finish: "Foil" })));
});

test("sync validates contiguous durable sequences, tombstones, workspace and bounded batches", () => {
  assert.deepEqual(parseSync(sync({ after: 9, events: [{ sequence: 10, kind: "delete", entityId: "copy-1", data: null }] })).events[0].data, null);
  for (const value of [
    { ...sync(), protocol: 2 }, { ...sync(), workspace: "unknown" }, { ...sync(), warehouseId: "../warehouse" },
    { ...sync(), ownerId: "injected-owner" }, { ...sync(), after: "0" },
    { ...sync(), events: Array.from({ length: BULK_EVENT_LIMIT + 1 }, () => sync().events[0]) },
    { ...sync(), receipts: Array.from({ length: BULK_COMMAND_LIMIT + 1 }, () => ({})) },
    { ...sync(), events: [{ sequence: 1, kind: "delete", entityId: "copy-1", data: copy() }] },
  ]) assert.throws(() => parseSync(value), isStatus(400));
  assert.throws(() => parseSync(sync({ after: 1 })), isStatus(409));
  assert.throws(() => parseSync(sync({ events: [{ ...sync().events[0], sequence: 2 }] })), isStatus(409));
});

test("sync receipts reject duplicate IDs and untrusted fields while preserving applied sequence", () => {
  const receipt = { commandId: requestId, status: "applied" as const, message: "Confirmed", appliedSequence: 2 };
  assert.deepEqual(parseSync(sync({ receipts: [receipt] })).receipts, [receipt]);
  for (const receipts of [[receipt, receipt], [{ ...receipt, status: "pending" }], [{ ...receipt, appliedSequence: -1 }], [{ ...receipt, ownerId: "injected" }]]) {
    assert.throws(() => parseSync({ ...sync(), receipts }), isStatus(400));
  }
});

test("native order metadata carries source creation time and an explicit linkage without invented money", () => {
  const data = { fingerprint: "b".repeat(64), reference: "Native order 10", status: "shipped", copyIds: ["copy-2", "copy-1"],
    createdAt: "2026-01-01T12:34:56.789Z", storeCommandId: requestId };
  assert.deepEqual(parseOrder(data), data);
  const events = parseSync(sync({ events: [
    { sequence: 1, kind: "order", entityId: "copy-1", data },
    { sequence: 2, kind: "order_delete", entityId: "copy-1", data: null },
  ] })).events;
  assert.equal(events[0].kind, "order");
  assert.equal(events[1].kind, "order_delete");
  for (const value of [
    { ...data, subtotalCents: 0 }, { ...data, soldAt: data.createdAt }, { ...data, costCents: 0 },
    { ...data, copyIds: ["copy-1", "copy-1"] }, { ...data, copyIds: [1] },
    { ...data, copyIds: Array.from({ length: 50_001 }, (_, index) => String(index)) },
    { ...data, createdAt: "2026-01-01" }, { ...data, createdAt: "not a date" },
    { ...data, storeCommandId: "human reference" }, { ...data, status: 1 },
  ]) assert.throws(() => parseOrder(value), isStatus(400));
  const largeOrder = { ...data, copyIds: Array.from({ length: 50_000 }, (_, index) => `DWM-${String(index).padStart(12, "0")}`) };
  assert.equal(parseOrder(largeOrder).copyIds.length, 50_000);
  assert.ok(Buffer.byteLength(JSON.stringify(largeOrder)) < 1_500_000);
  assert.throws(() => parseSync({ ...sync(), events: [{ sequence: 1, kind: "order_delete", entityId: "order-1", data }] }), isStatus(400));
});

test("copy identity, availability, links and money reject malformed or unsafe values", () => {
  for (const value of [
    { ...copy(), fingerprint: "bad" }, { ...copy(), available: "true" }, { ...copy(), name: "" },
    { ...copy(), name: "x".repeat(501) }, { ...copy(), serial: "bad\u0000id" }, { ...copy(), costCents: -1 },
    { ...copy(), listPriceCents: 1.5 }, { ...copy(), costCents: Number.MAX_SAFE_INTEGER },
    { ...copy(), imageUrl: "javascript:alert(1)" }, { ...copy(), tcgplayerUrl: "http://example.test" },
    { ...copy(), imageUrl: "https://user:password@example.test/card" }, { ...copy(), serverOwner: "injected" },
  ]) assert.throws(() => parseCopy(value), isStatus(400));
});

test("command canonicalization makes reordered retry selections identical", () => {
  const input = { ...sale(), copies: [
    { copyId: "z", expectedFingerprint: "b".repeat(64) },
    { copyId: "a", expectedFingerprint: "a".repeat(64) },
  ] };
  const first = parseCommand(input);
  const reversed = parseCommand({ ...input, copies: [...input.copies].reverse() });
  assert.equal(digest(first), digest(reversed));
  assert.deepEqual(first.copies.map(item => item.copyId), ["a", "z"]);
  assert.equal(first.sale?.unitCostCents, null);
});

test("commands reject duplicate copies, unbounded selections, invalid prices, dates and hidden owner fields", () => {
  for (const value of [
    { ...removal(), kind: "replaceAll" }, { ...removal(), copies: [] },
    { ...removal(), copies: [removal().copies[0], removal().copies[0]] },
    { ...removal(), copies: Array.from({ length: 101 }, (_, index) => ({ copyId: String(index), expectedFingerprint: "a".repeat(64) })) },
    { ...removal(), actorId: "injected" }, { ...removal(), sale: sale().sale },
    { ...sale(), sale: { ...sale().sale, unitPriceCents: 0 } },
    { ...sale(), sale: { ...sale().sale, discountCents: 51 } },
    { ...sale(), sale: { ...sale().sale, unitCostCents: -1 } },
    { ...sale(), sale: { ...sale().sale, taxCents: Number.MAX_SAFE_INTEGER } },
    { ...sale(), sale: { ...sale().sale, soldAt: "invalid" } },
    { ...sale(), sale: { ...sale().sale, soldAt: "1999-12-31T00:00:00Z" } },
    { ...sale(), sale: { ...sale().sale, soldAt: new Date(Date.now() + 600_000).toISOString() } },
  ]) assert.throws(() => parseCommand(value), isStatus(400));
});

test("inventory filters are bounded, reject duplicate parameters and preserve literal search characters", () => {
  assert.deepEqual(inventoryQuery(new URL(`${webURL}?q=50%25_foil&workspace=mtg&status=available&page=2`)), {
    q: "50%_foil", workspace: "mtg", status: "available", page: 2, pageSize: 100,
  });
  for (const query of ["page=0", "page=-1", "page=1.5", "page=1000000", "workspace=all&workspace=mtg", "q=a&q=b", "status=sold", "owner=other", `q=${"x".repeat(201)}`]) {
    assert.throws(() => inventoryQuery(new URL(`${webURL}?${query}`)), isStatus(400));
  }
});

test("native sync uses verified account identity and does not accept browser cookie authorization", async () => {
  for (const headers of [{}, { Cookie: "approved=1" }, { Authorization: "Bearer legacy-scanner" }] as Record<string, string>[]) {
    const h = nativeHarness();
    assert.equal((await h.handle(post(nativeURL, sync(), headers))).status, 401);
    assert.equal(h.calls.some(call => call[0] === "sync"), false);
  }
  const h = nativeHarness();
  const response = await h.handle(post(nativeURL, sync(), { Authorization: "Bearer approved-native" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(h.calls[1][1], "verified-owner");
  assert.deepEqual(await response.json(), { ackSequence: 1 });
});

test("native sync blocks browser origins, query injection and unsupported methods before storage", async () => {
  for (const headers of [{ Origin: origin }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
    const h = nativeHarness();
    assert.equal((await h.handle(post(nativeURL, sync(), { Authorization: "Bearer approved-native", ...headers }))).status, 403);
    assert.equal(h.calls.length, 0);
  }
  const h = nativeHarness();
  assert.equal((await h.handle(post(`${nativeURL}?owner=other`, sync()))).status, 403);
  assert.equal((await h.handle(new Request(nativeURL))).status, 405);
  assert.equal(h.calls.length, 0);
});

test("approved native requests reject unknown fields before any sync mutation", async () => {
  const h = nativeHarness();
  const response = await h.handle(post(nativeURL, { ...sync(), ownerId: "injected" }, { Authorization: "Bearer approved-native" }));
  assert.equal(response.status, 400);
  assert.deepEqual(h.calls, [["authorize"]]);
});

test("web reads require authorization and web writes require exact same origin", async () => {
  const unauthorized = webHarness(false);
  assert.equal((await unauthorized.handle(new Request(webURL))).status, 401);
  assert.equal((await unauthorized.handle(post(webURL, removal(), { Origin: origin }))).status, 401);
  assert.equal(unauthorized.calls.some(call => call[0] !== "authorize"), false);
  for (const headers of [{}, { Origin: "https://evil.test" }, { Origin: "null" }, { Origin: origin, "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
    const h = webHarness();
    assert.equal((await h.handle(post(webURL, removal(), headers))).status, 403);
    assert.equal(h.calls.length, 0);
  }
  const h = webHarness();
  const response = await h.handle(post(webURL, removal(), { Origin: origin }));
  assert.equal(response.status, 200);
  assert.equal(h.calls[1][1], "verified-actor");
  assert.equal((await response.json()).status, "pending", "queueing must not claim that native stock has already changed");
});

test("web handler rejects native bearer crossover, extra action parameters and non-GET/POST methods", async () => {
  const h = webHarness();
  assert.equal((await h.handle(new Request(webURL, { headers: { Authorization: "Bearer approved-native" } }))).status, 401);
  assert.equal((await h.handle(post(`${webURL}?action=replaceAll`, removal(), { Origin: origin }))).status, 400);
  assert.equal((await h.handle(new Request(webURL, { method: "DELETE" }))).status, 405);
  assert.equal(h.calls.some(call => call[0] === "queue"), false);
  assert.equal((await h.handle(new Request(`${webURL}?workspace=mtg`))).status, 200);
});

test("body size limits enforce actual bytes despite missing or dishonest Content-Length", async () => {
  const large = { padding: "x".repeat(BULK_BODY_LIMIT) };
  for (const headers of [{}, { "Content-Length": "1" }, { "Content-Length": String(BULK_BODY_LIMIT + 1) }] as Record<string, string>[]) {
    await assert.rejects(() => readBulkBody(post(webURL, large, headers)), isStatus(413));
  }
  await assert.rejects(() => readBulkBody(post(webURL, {}, { "Content-Length": "-1" })), isStatus(413));
  await assert.rejects(() => readBulkBody(post(webURL, {}, { "Content-Type": "text/plain" })), isStatus(415));
  await assert.rejects(() => readBulkBody(new Request(webURL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })), isStatus(400));
  const bytes = { name: "é".repeat(BULK_BODY_LIMIT / 2 + 1) };
  await assert.rejects(() => readBulkBody(post(webURL, bytes)), isStatus(413));
});

test("storage failures are sanitized while expected conflicts remain actionable", async () => {
  const secret = "postgres://user:secret-password@host/database?token=private";
  const handle = webBulkHandler({ authorize: async () => ({ user: { id: "actor" } }), inventory: async () => { throw new Error(secret); }, queue: async () => { throw new Error(secret); } });
  for (const request of [new Request(webURL), post(webURL, removal(), { Origin: origin })]) {
    const response = await handle(request);
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /postgres|password|token|private/);
  }
  assert.equal(translateBulkError(new Error("bulk:queue_full")).status, 429);
  assert.equal(translateBulkError(new Error("bulk:replay_conflict")).status, 409);
  assert.doesNotMatch(translateBulkError(new Error(secret)).message, /postgres|password|token/);
});

test("native financial capture preserves aggregate amounts, canonical copy IDs and explicit unknown cost", () => {
  const first = parseNativeOrderSale(nativeSale());
  assert.deepEqual(first.copyIds, ["copy-1", "copy-2"]);
  assert.equal(first.sale.subtotalCents, 1001);
  assert.equal(first.sale.totalCostCents, null);
  assert.equal(digest(first), digest(parseNativeOrderSale({ ...nativeSale(), copyIds: ["copy-1", "copy-2"] })));
  const maximum = parseNativeOrderSale({ ...nativeSale(), sale: { ...nativeSale().sale, subtotalCents: 2_000_000_000, taxCents: 2_000_000_000, discountCents: 0 } });
  assert.equal(maximum.sale.subtotalCents + maximum.sale.taxCents, 4_000_000_000);
  for (const value of [
    { ...nativeSale(), copyIds: [] }, { ...nativeSale(), copyIds: ["same", "same"] },
    { ...nativeSale(), expectedFingerprint: "bad" }, { ...nativeSale(), actor: "other" },
    { ...nativeSale(), sale: { ...nativeSale().sale, unitPriceCents: 300 } },
    { ...nativeSale(), sale: { ...nativeSale().sale, subtotalCents: 2_000_000_001 } },
    { ...nativeSale(), sale: { ...nativeSale().sale, discountCents: 1002 } },
    { ...nativeSale(), sale: { ...nativeSale().sale, totalCostCents: -1 } },
    { ...nativeSale(), sale: { ...nativeSale().sale, taxCents: 0.5 } },
    { ...nativeSale(), sale: { ...nativeSale().sale, soldAt: "invalid" } },
  ]) assert.throws(() => parseNativeOrderSale(value), isStatus(400));
  assert.deepEqual(orderSaleQuery(new URL(`${webURL}/orders/sale?warehouseId=${warehouseId}&orderId=native-order`)), { warehouseId, orderId: "native-order" });
  assert.throws(() => orderSaleQuery(new URL(`${webURL}/orders/sale?warehouseId=${warehouseId}&orderId=a&orderId=b`)), isStatus(400));
});

test("financial-only endpoint authenticates same-origin requests and returns durable rejection outcomes", async () => {
  const calls: unknown[][] = [];
  let approved = false;
  const handle = nativeOrderSaleHandler({
    authorize: async () => approved ? { user: { id: "verified-actor" } } : null,
    read: async input => { calls.push(["read", input]); return { financialStatus: "unpriced" }; },
    record: async (actor, input) => { calls.push(["record", actor, input]); return { id: input.requestId, status: "rejected", message: "Order changed. Review again." }; },
  });
  const url = `${webURL}/orders/sale`;
  assert.equal((await handle(post(url, nativeSale(), { Origin: origin }))).status, 401);
  assert.equal(calls.length, 0);
  approved = true;
  assert.equal((await handle(post(url, nativeSale(), { Origin: "https://evil.test" }))).status, 403);
  assert.equal((await handle(post(url, nativeSale(), { Origin: origin, Authorization: "Bearer native" }))).status, 401);
  assert.equal((await handle(post(`${url}?action=edit`, nativeSale(), { Origin: origin }))).status, 400);
  assert.equal((await handle(new Request(url, { method: "DELETE" }))).status, 405);
  assert.equal(calls.length, 0);
  const rejected = await handle(post(url, nativeSale(), { Origin: origin }));
  assert.equal(rejected.status, 200);
  assert.deepEqual(await rejected.json(), { id: requestId, status: "rejected", message: "Order changed. Review again." });
  assert.equal(calls[0][1], "verified-actor");
  assert.equal((await handle(new Request(`${url}?warehouseId=${warehouseId}&orderId=native-order`))).status, 200);
  assert.equal(calls[1][0], "read");
});

test("financial capture distinguishes body/actor conflicts from durable rejection and sanitizes failures", async () => {
  const url = `${webURL}/orders/sale`;
  for (const [error, status] of [[new BulkError(409, "Request ID was already used."), 409], [new Error("postgres://user:secret@host"), 503]] as const) {
    const handle = nativeOrderSaleHandler({ authorize: async () => ({ user: { id: "actor" } }), read: async () => ({}), record: async () => { throw error; } });
    const response = await handle(post(url, nativeSale(), { Origin: origin }));
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /postgres|secret/);
  }
});


test("printing groups retain exact copies and exclude pending/unavailable from available counts", () => {
  const rows = [
    { warehouseId, copyId: "1", sequence: 1, data: copy(), pending: false },
    { warehouseId, copyId: "2", sequence: 2, data: copy({ serial: "2", condition: "Played", location: "Box B", costCents: 20 }), pending: true },
    { warehouseId, copyId: "3", sequence: 3, data: copy({ available: false, status: "quarantined" }), pending: false },
  ];
  const groups = groupBulkCopies(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].available, 1);
  assert.deepEqual(groups[0].copies, rows);
  assert.equal(groups[0].copies[1], rows[1]);
  assert.deepEqual(groupBulkCopies([]), []);
});

test("printing groups never combine different sets, finishes, languages, variants or warehouses", () => {
  const base = { warehouseId, copyId: "1", sequence: 1, data: copy(), pending: false };
  for (const field of ["masterId", "name", "setName", "cardNumber", "rarity", "finish", "language"] as const) {
    assert.equal(groupBulkCopies([base, { ...base, copyId: "2", data: copy({ [field]: "Different" }) }]).length, 2, field);
  }
  assert.equal(groupBulkCopies([base, { ...base, warehouseId: requestId }]).length, 2);
  assert.equal(groupBulkCopies([{ ...base, data: copy({ masterId: "" }) }, { ...base, copyId: "2", data: copy({ masterId: "" }) }]).length, 2);
});
