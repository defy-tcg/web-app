import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../lib/singles/intake.ts";
import { getSkuLabelShopifyStatuses, type SkuLabelShopifyDependencies, type SkuLabelShopifyProduct, type SkuLabelShopifyStatus } from "../lib/sku-label-shopify.ts";

const checkedAt = "2027-01-15T08:00:00.000Z";
const locationId = "gid://shopify/Location/1";
const publicationId = "gid://shopify/Publication/2";
const journalKey = (sku: string) => `qr_${digest(sku).slice(0, 60)}`;
type Call = { operation: string; name: string; skus: string[]; failed: boolean };

function fixture(count: number, options: { blocked?: number[]; pending?: number[]; failLiveCall?: number; failJournalCall?: number; failConnection?: boolean } = {}) {
  const products: SkuLabelShopifyProduct[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1, sku: `DEFY-${1_000_000_000 + index}`, name: `Test card ${index}`, game: "Magic: The Gathering",
    setName: "Test set", cardNumber: String(index + 1), condition: "Near Mint", finish: "Foil", tcgplayerId: 650_000 + index,
    costCents: 100, listPriceCents: 200, quantity: 3, initialQuantity: 3,
  }));
  const savedStatuses = products.map((product, index): SkuLabelShopifyStatus => options.blocked?.includes(index)
    ? { sku: product.sku, status: "blocked", message: `Review the exact catalog mapping for card ${index}.` }
    : options.pending?.includes(index)
      ? { sku: product.sku, status: "pending", message: `Card ${index} is waiting for its original stock receipt.` }
      : { sku: product.sku, status: "ready", message: "Shopify POS ready.", priceCents: 9_999, availableQuantity: 99,
        transferredQuantity: 99, checkedAt: "2020-01-01T00:00:00.000Z" });
  const entries = products.map((product, index) => {
    const identity = JSON.stringify([`single:tcgplayer:printing:${product.tcgplayerId}`, "Near Mint", "foil", "English"]);
    const productId = `gid://shopify/Product/${index + 1}`;
    const variantId = `gid://shopify/ProductVariant/${index + 1}`;
    return {
      product,
      journal: { version: 1, identity, sku: product.sku, owner: null, expiresAt: 0, initialQuantity: product.initialQuantity,
        productId, variantId, shopifySku: product.sku, publicationId, adjustmentId: `gid://shopify/InventoryAdjustmentGroup/${index + 1}`,
        status: savedStatuses[index] },
      variant: { id: variantId, sku: product.sku, price: ((200 + index) / 100).toFixed(2), inventoryPolicy: "DENY",
        selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }],
        qrIdentity: { value: identity }, barcodes: { nodes: [{ value: product.sku }], pageInfo: { hasNextPage: false } }, pos: true,
        product: { id: productId, status: "ACTIVE", pos: true, catalogId: { value: `single:tcgplayer:printing:${product.tcgplayerId}` },
          sourceId: { value: String(product.tcgplayerId) }, manualOrigin: null,
          variants: { nodes: [{ id: variantId }], pageInfo: { hasNextPage: false } } },
        inventoryItem: { id: `gid://shopify/InventoryItem/${index + 1}`, tracked: true,
          inventoryLevel: { quantities: [{ name: "available", quantity: index + 1 }] } } },
    };
  });
  const byJournal = new Map(entries.map(entry => [journalKey(entry.product.sku), entry]));
  const byVariant = new Map(entries.map(entry => [entry.variant.id, entry]));
  const calls: Call[] = [];
  let journalCalls = 0, liveCalls = 0;
  const deps: SkuLabelShopifyDependencies = {
    settings: { shop: "defy-receiving-test.myshopify.com", locationId }, clock: () => Date.parse(checkedAt),
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const [, operation, name] = /\b(query|mutation)\s+(\w+)/.exec(query) ?? [];
      const call: Call = { operation, name, skus: [], failed: false };
      calls.push(call);
      assert.equal(operation, "query", "Reading readiness must never change Shopify");
      let result: unknown;
      switch (name) {
        case "QrLinkStatusConnection":
          if (options.failConnection) { call.failed = true; throw new Error("Private connection failure detail"); }
          result = { currentAppInstallation: { accessScopes: ["write_products", "write_inventory", "write_publications"].map(handle => ({ handle })) } };
          break;
        case "QrLinkStatuses": {
          const aliases = [...query.matchAll(/(\w+):\s*metafield\([^)]*key:\s*"([^"]+)"\)/g)];
          call.skus = aliases.map(([, , key]) => byJournal.get(key)!.product.sku);
          if (++journalCalls === options.failJournalCall) { call.failed = true; throw new Error("Private journal failure detail"); }
          result = { shop: Object.fromEntries(aliases.map(([, alias, key]) => [alias, { value: JSON.stringify(byJournal.get(key)!.journal) }])) };
          break;
        }
        case "QrLinkLiveStatuses": {
          const aliases = [...query.matchAll(/(\w+):\s*productVariant\(id:\s*\$(\w+)\)/g)];
          call.skus = aliases.map(([, , variable]) => byVariant.get(String(variables[variable]))!.product.sku);
          if (aliases.length > 5 || ++liveCalls === options.failLiveCall) {
            call.failed = true; throw new Error("Private Shopify query limit detail");
          }
          assert.equal(variables.location, locationId);
          result = Object.fromEntries(aliases.map(([, alias, variable]) => [alias, byVariant.get(String(variables[variable]))!.variant]));
          break;
        }
        default: throw new Error(`Unexpected status operation ${name}`);
      }
      return structuredClone(result) as T;
    },
  };
  return { products, savedStatuses, calls, deps };
}

function assertReadOnly(f: ReturnType<typeof fixture>, result: SkuLabelShopifyStatus[]) {
  assert.deepEqual(result.map(status => status.sku), f.products.map(product => product.sku), "Keep every requested label in order");
  assert.ok(f.calls.every(call => call.operation === "query"), "Status reads cannot change cards, barcodes, journals, or stock");
  assert.ok(f.calls.every(call => ["QrLinkStatusConnection", "QrLinkStatuses", "QrLinkLiveStatuses"].includes(call.name)));
  assert.ok(result.every(status => !status.message.includes("Private")), "Do not expose upstream error details");
}

function assertReady(status: SkuLabelShopifyStatus, index: number) {
  assert.equal(status.status, "ready", `Card ${index} should retain verified readiness`);
  assert.equal(status.availableQuantity, index + 1);
  assert.equal(status.priceCents, 200 + index);
  assert.equal(status.transferredQuantity, 3);
  assert.equal(status.checkedAt, checkedAt);
}

function assertUnavailable(status: SkuLabelShopifyStatus) {
  assert.equal(status.status, "pending");
  for (const field of ["availableQuantity", "priceCents", "transferredQuantity", "checkedAt"] as const) {
    assert.equal(status[field], undefined, `An unverified card cannot display stale ${field}`);
  }
}

function assertSavedStatus(status: SkuLabelShopifyStatus, saved: SkuLabelShopifyStatus) {
  assert.deepEqual({ sku: status.sku, status: status.status, message: status.message }, saved);
}

test("large mixed saved-label libraries use bounded live queries and preserve every status", async () => {
  const f = fixture(43, { blocked: [2, 31], pending: [12, 21] });
  const result = await getSkuLabelShopifyStatuses(f.products, f.deps);
  assertReadOnly(f, result);
  for (const [index, status] of result.entries()) {
    if (f.savedStatuses[index].status === "ready") assertReady(status, index);
    else assertSavedStatus(status, f.savedStatuses[index]);
  }
  const live = f.calls.filter(call => call.name === "QrLinkLiveStatuses");
  assert.ok(live.length > 1);
  assert.ok(live.every(call => call.skus.length > 0 && call.skus.length <= 5 && !call.failed));
});

test("one failed live batch clears only its unverified cards and preserves other saved statuses", async () => {
  const f = fixture(28, { blocked: [0, 19], pending: [7, 22], failLiveCall: 2 });
  const result = await getSkuLabelShopifyStatuses(f.products, f.deps);
  assertReadOnly(f, result);
  const failed = f.calls.filter(call => call.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, "QrLinkLiveStatuses");
  const failedSkus = new Set(failed[0].skus);
  assert.ok(failedSkus.size > 0 && failedSkus.size <= 5);
  for (const [index, status] of result.entries()) {
    if (f.savedStatuses[index].status !== "ready") assertSavedStatus(status, f.savedStatuses[index]);
    else if (failedSkus.has(status.sku)) assertUnavailable(status);
    else assertReady(status, index);
  }
  const failedCall = f.calls.indexOf(failed[0]);
  assert.ok(f.calls.slice(0, failedCall).some(call => call.name === "QrLinkLiveStatuses" && !call.failed));
  assert.ok(f.calls.slice(failedCall + 1).some(call => call.name === "QrLinkLiveStatuses" && !call.failed));
});

test("a failed journal batch does not discard earlier statuses or stop later labels", async () => {
  const f = fixture(43, { blocked: [1], pending: [41], failJournalCall: 2 });
  const result = await getSkuLabelShopifyStatuses(f.products, f.deps);
  assertReadOnly(f, result);
  const failed = f.calls.filter(call => call.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, "QrLinkStatuses");
  assert.equal(failed[0].skus.length, 20);
  const failedSkus = new Set(failed[0].skus);
  for (const [index, status] of result.entries()) {
    if (failedSkus.has(status.sku)) assertUnavailable(status);
    else if (f.savedStatuses[index].status !== "ready") assertSavedStatus(status, f.savedStatuses[index]);
    else assertReady(status, index);
  }
  assert.ok(f.calls.slice(f.calls.indexOf(failed[0]) + 1).some(call => call.name === "QrLinkStatuses" && !call.failed));
  assert.ok(f.calls.filter(call => call.name === "QrLinkLiveStatuses").every(call => call.skus.every(sku => !failedSkus.has(sku))));
});

test("a connection failure leaves every requested label safely pending without further requests", async () => {
  const f = fixture(3, { failConnection: true });
  const result = await getSkuLabelShopifyStatuses(f.products, f.deps);
  assertReadOnly(f, result);
  result.forEach(assertUnavailable);
  assert.equal(f.calls.length, 1);
});
