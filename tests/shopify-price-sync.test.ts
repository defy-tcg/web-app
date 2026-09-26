import assert from "node:assert/strict";
import test from "node:test";
import { cronAuthorized, pricingIdentity, updateVariantPrice, type LegacyPricingProduct, type PricingVariant } from "../lib/shopify/price-sync-core.ts";
import { runPricePage, type PriceJournal, type PriceSyncState } from "../lib/shopify/price-sync-runner.ts";
import type { Catalog } from "../lib/singles/types.ts";
import type { SinglesGraphQL } from "../lib/singles/shopify.ts";
import type { ScrydexPrice } from "../lib/scrydex.ts";

const catalog: Catalog = { fetchedAt: "2026-09-18", sourceUpdatedAt: "2026-09-18", warnings: [], cards: [
  { key: "101:Normal", productId: 101, groupId: 7, name: "Test Card", setName: "Origins", setCode: "OGN", number: "001", rarity: "Rare", finish: "Normal", language: "English", imageUrl: "", productUrl: "https://www.tcgplayer.com/product/101", marketCents: 99999 },
  { key: "101:Foil", productId: 101, groupId: 7, name: "Test Card", setName: "Origins", setCode: "OGN", number: "001", rarity: "Rare", finish: "Foil", language: "English", imageUrl: "", productUrl: "https://www.tcgplayer.com/product/101", marketCents: 99999 },
] };
const single = (): PricingVariant => ({ id: "gid://shopify/ProductVariant/1", sku: "DEFY-RFB-101-FOIL-EN-LP", barcode: "DEFY-RFB-101-FOIL-EN-LP", price: "25.00",
  barcodes: { nodes: [{ value: "DEFY-RFB-101-FOIL-EN-LP", type: null }], pageInfo: { hasNextPage: false } },
  selectedOptions: [{ name: "Condition", value: "Lightly Played" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }],
  product: { id: "gid://shopify/Product/1", title: "Test Card — Origins", status: "ACTIVE", productType: "Riftbound single", catalogId: { value: "single:riftbound:printing:101" }, storefrontCatalogId: { value: "101" }, game: { value: "Riftbound" }, cardName: { value: "Test Card" }, setName: { value: "Origins" }, cardNumber: { value: "001" } } });
const sealedProduct: LegacyPricingProduct = { id: 5, sku: "DEFY-PKM-000005", barcode: "123456789012", name: "Test Booster Box", game: "Pokemon", setName: "Test Set", cardNumber: "", productType: "Sealed", condition: "", finish: "", tcgplayerId: 205 };
const sealed = (): PricingVariant => ({ ...single(), sku: sealedProduct.sku, barcode: sealedProduct.barcode,
  barcodes: { nodes: [{ value: sealedProduct.barcode!, type: null }], pageInfo: { hasNextPage: false } },
  selectedOptions: [{ name: "Title", value: "Default Title" }], product: { ...single().product, productType: "Sealed", catalogId: null, storefrontCatalogId: null, game: null, cardName: null, setName: null, cardNumber: null } });
const quote: ScrydexPrice = { cents: 105, matchedName: "Test Card", groupName: "Origins", variation: "foil LP", scrydexId: "OGN-001", url: "https://api.scrydex.com/riftbound/v1/cards/OGN-001" };

function shopify(variant: PricingVariant, options: { duplicates?: boolean; changed?: boolean; rejected?: boolean; uncertain?: boolean } = {}) {
  const writes: Record<string, unknown>[] = [];
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    if (query.includes("PriceScanCodes")) return { productVariants: { nodes: [variant, ...(options.duplicates ? [{ ...variant, id: "gid://shopify/ProductVariant/99" }] : [])], pageInfo: { hasNextPage: false } } } as T;
    if (query.includes("PriceVariantCheck")) return { productVariant: options.changed ? { ...variant, sku: "CHANGED" } : variant } as T;
    assert.match(query, /mutation PosScrydexPrice/);
    writes.push(variables);
    const change = (variables.variants as { id: string; price: string }[])[0];
    return { productVariantsBulkUpdate: { productVariants: options.uncertain ? [] : [{ id: change.id, price: change.price }], userErrors: options.rejected ? [{ message: "Permission denied" }] : [] } } as T;
  };
  return { graphql, writes };
}

test("Shopify singles preserve exact printing, condition and finish, using Scrydex market + 6.5%", async () => {
  const variant = single(); const client = shopify(variant);
  const result = await updateVariantPrice({ variant, legacy: [], catalog, ...client, now: "2026-09-18T12:00:00Z", resolve: async identity => {
    assert.equal(identity.tcgplayerId, 101); assert.equal(identity.condition, "Lightly Played"); assert.equal(identity.finish, "Foil"); return quote;
  } });
  assert.equal(result.priceCents, 112); assert.equal(result.marketCents, 105);
  const variants = client.writes[0].variants as Record<string, unknown>[];
  assert.deepEqual(Object.keys(variants[0]).sort(), ["id", "metafields", "price"]);
  assert.equal(variants.length, 1); assert.equal(variants[0].price, "1.12");
  assert.doesNotMatch(JSON.stringify(client.writes), /inventory|quantity|cost|sku|barcode|publication|options/i);
});

test("sealed products match registered codes and keep raw market pricing", async () => {
  const variant = sealed(); const client = shopify(variant);
  const result = await updateVariantPrice({ variant, legacy: [sealedProduct], catalog, ...client, now: "2026-09-18T12:00:00Z", resolve: async identity => {
    assert.equal(identity.productType, "Sealed"); assert.equal(identity.game, "Pokemon"); return { ...quote, cents: 12999 };
  } });
  assert.equal(result.priceCents, 12999);
});

test("scheduled Japanese Pokémon pricing verifies language and adds 1.5% to the raw USD market", async () => {
  const saved: LegacyPricingProduct = { id: 19, sku: "DEFY-3448510729", barcode: null,
    name: "Charmander - 168/165", game: "Pokémon (Japanese)", setName: "SV2a: Pokemon Card 151", cardNumber: "168/165",
    productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 566513 };
  const variant: PricingVariant = { ...single(), sku: saved.sku, barcode: saved.sku,
    barcodes: { nodes: [{ value: saved.sku, type: null }], pageInfo: { hasNextPage: false } },
    selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "Japanese" }],
    product: { ...single().product, productType: "Pokémon (Japanese) single", catalogId: { value: "single:tcgplayer:printing:566513" },
      storefrontCatalogId: { value: "566513" }, game: { value: saved.game }, cardName: { value: saved.name },
      setName: { value: saved.setName }, cardNumber: { value: saved.cardNumber }, language: { value: "Japanese" } } };
  const client = shopify(variant);
  const result = await updateVariantPrice({ variant, legacy: [saved], catalog, ...client, now: "2026-09-23T12:00:00Z", resolve: async identity => {
    assert.equal(identity.game, saved.game); assert.equal(identity.tcgplayerId, 566513);
    return { ...quote, cents: 2773, scrydexId: "sv2a_ja-168" };
  } });
  assert.equal(result.priceCents, 2815);
  assert.equal(result.marketCents, 2773);
  assert.equal((client.writes[0].variants as { price: string }[])[0].price, "28.15");
  assert.doesNotMatch(JSON.stringify(client.writes), /inventory|quantity|cost|sku|barcode|publication|options/i);
  for (const language of ["English", "Korean", ""]) {
    const changed = structuredClone(variant);
    changed.selectedOptions[2].value = language;
    assert.throws(() => pricingIdentity(changed, [saved], catalog));
  }
  const missing = structuredClone(variant); missing.selectedOptions.pop();
  assert.throws(() => pricingIdentity(missing, [saved], catalog));
  const conflict = structuredClone(variant); conflict.product.language = { value: "English" };
  assert.throws(() => pricingIdentity(conflict, [saved], catalog));
  assert.throws(() => pricingIdentity(variant, [{ ...saved, game: "Pokémon" }], catalog));
});

test("scheduled English Pokémon pricing rounds a 1.5% markup half-up and refreshes an old market-only price", async () => {
  const saved: LegacyPricingProduct = { id: 20, sku: "DEFY-3099353165", barcode: null,
    name: "Nidoking - 174/165", game: "Pokémon", setName: "SV: Scarlet & Violet 151", cardNumber: "174/165",
    productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 517029 };
  const variant: PricingVariant = { ...single(), sku: saved.sku, barcode: saved.sku, price: "11.00",
    barcodes: { nodes: [{ value: saved.sku, type: null }], pageInfo: { hasNextPage: false } },
    selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }],
    product: { ...single().product, productType: "Pokémon single", catalogId: { value: "single:tcgplayer:printing:517029" },
      storefrontCatalogId: { value: "517029" }, game: { value: saved.game }, cardName: { value: saved.name },
      setName: { value: saved.setName }, cardNumber: { value: saved.cardNumber }, language: { value: "English" } } };
  const client = shopify(variant);
  const result = await updateVariantPrice({ variant, legacy: [saved], catalog, ...client, now: "2026-09-24T12:00:00Z", resolve: async identity => {
    assert.equal(identity.game, saved.game); assert.equal(identity.tcgplayerId, 517029);
    return { ...quote, cents: 1100, scrydexId: "sv3pt5-174" };
  } });
  assert.equal(result.priceCents, 1117);
  assert.equal(result.marketCents, 1100);
  assert.equal((client.writes[0].variants as { price: string }[])[0].price, "11.17");
  assert.doesNotMatch(JSON.stringify(client.writes), /inventory|quantity|cost|sku|barcode|publication|options/i);
});

test("a secondary custom QR matches Defy for scheduled pricing without changing any barcode", async () => {
  const variant = single(); variant.sku = "EXISTING-STORE-SKU"; variant.barcode = "012345678901";
  variant.barcodes = { nodes: [{ value: variant.barcode, type: "UPC" }, { value: "DEFY-9775456393", type: null }], pageInfo: { hasNextPage: false } };
  const legacy: LegacyPricingProduct = { id: 7, sku: "DEFY-9775456393", barcode: null, name: "Test Card", game: "Riftbound",
    setName: "Origins", cardNumber: "001", productType: "Single", condition: "Lightly Played", finish: "Foil", tcgplayerId: 101 };
  const client = shopify(variant);
  const result = await updateVariantPrice({ variant, legacy: [legacy], catalog, ...client, now: "2026-09-22T12:00:00Z", resolve: async identity => {
    assert.equal(identity.tcgplayerId, 101); assert.equal(identity.condition, "Lightly Played"); return quote;
  } });
  assert.equal(result.priceCents, 112);
  assert.doesNotMatch(JSON.stringify(client.writes), /inventory|quantity|cost|sku|barcode|publication|options/i);
  assert.deepEqual(variant.barcodes.nodes, [{ value: "012345678901", type: "UPC" }, { value: "DEFY-9775456393", type: null }]);
});

test("scheduled pricing rejects secondary-only duplicates and incomplete barcode lists", async () => {
  const variant = single(); variant.barcodes.nodes.push({ value: "DEFY-9775456393", type: null });
  const duplicate = { ...structuredClone(variant), id: "gid://shopify/ProductVariant/99", sku: "OTHER-SKU", barcode: "OTHER-PRIMARY",
    barcodes: { nodes: [{ value: "OTHER-PRIMARY", type: null }, { value: "DEFY-9775456393", type: null }], pageInfo: { hasNextPage: false } } };
  for (const truncated of [false, true]) {
    const client = shopify(variant);
    const graphql: SinglesGraphQL = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (query.includes("PriceScanCodes")) return { productVariants: { nodes: truncated
        ? [{ ...variant, barcodes: { ...variant.barcodes, pageInfo: { hasNextPage: true } } }] : [variant, duplicate], pageInfo: { hasNextPage: false } } } as T;
      return client.graphql<T>(query, variables);
    };
    await assert.rejects(updateVariantPrice({ variant, legacy: [], catalog, graphql, now: "2026-09-22T12:00:00Z", resolve: async () => quote }),
      { code: truncated ? "BARCODES_INCOMPLETE" : "DUPLICATE_CODE" });
    assert.equal(client.writes.length, 0);
  }
});

test("unmapped/ambiguous codes, conflicting catalog data, foreign language and sibling conditions never get prices", () => {
  assert.throws(() => pricingIdentity(sealed(), [], catalog), /Add this product/);
  assert.throws(() => pricingIdentity(sealed(), [sealedProduct, { ...sealedProduct, id: 6 }], catalog), /multiple/);
  for (const change of [
    (v: PricingVariant) => { v.product.storefrontCatalogId = { value: "999" }; },
    (v: PricingVariant) => { v.selectedOptions[0].value = "Near Mint"; },
    (v: PricingVariant) => { v.selectedOptions[1].value = "Nonfoil"; },
    (v: PricingVariant) => { v.selectedOptions[2].value = "Japanese"; },
    (v: PricingVariant) => { v.barcode = "DEFY-RFB-101-NORMAL-EN-NM"; },
    (v: PricingVariant) => { v.product.game = { value: "Pokemon" }; },
    (v: PricingVariant) => { v.product.status = "DRAFT"; },
  ]) { const variant = single(); change(variant); assert.throws(() => pricingIdentity(variant, [], catalog)); }
});

test("duplicate Shopify codes and concurrent identity changes prevent mutations", async () => {
  for (const options of [{ duplicates: true }, { changed: true }]) {
    const variant = single(); const client = shopify(variant, options);
    await assert.rejects(updateVariantPrice({ variant, legacy: [], catalog, ...client, now: "2026-09-18T12:00:00Z", resolve: async () => quote }));
    assert.equal(client.writes.length, 0);
  }
});

test("missing or invalid provider prices preserve Shopify price; rejected/unconfirmed writes are failures", async () => {
  for (const cents of [0, -1, NaN, 1.2, 100_000_001]) {
    const variant = single(); const client = shopify(variant);
    await assert.rejects(updateVariantPrice({ variant, legacy: [], catalog, ...client, now: "2026-09-18T12:00:00Z", resolve: async () => ({ ...quote, cents }) }));
    assert.equal(client.writes.length, 0);
  }
  for (const options of [{ rejected: true }, { uncertain: true }]) {
    const variant = single(); const client = shopify(variant, options);
    await assert.rejects(updateVariantPrice({ variant, legacy: [], catalog, ...client, now: "2026-09-18T12:00:00Z", resolve: async () => quote }), { code: "UPDATE_UNCONFIRMED" });
  }
});

function journal() {
  let value: PriceSyncState | null = null; let revision = 0;
  const store: PriceJournal = {
    read: async () => ({ value: structuredClone(value), digest: revision ? String(revision) : null }),
    cas: async (snapshot, next) => { if (snapshot.digest !== (revision ? String(revision) : null)) return false; value = structuredClone(next); revision++; return true; },
  };
  return store;
}
const firstPage = { checked: 1, results: [], issues: [{ sku: "UNKNOWN", title: "Unmapped", message: "Map first" }], nextCursor: "page-2" };
const lastPage = { checked: 0, results: [], issues: [], nextCursor: null };

test("pricing journal persists pagination, resumes failures and deduplicates completed automatic runs", async () => {
  const store = journal(); const now = () => Date.parse("2026-09-18T12:00:00Z");
  const first = await runPricePage({ journal: store, now, page: async after => { assert.equal(after, null); return firstPage; } });
  assert.equal(first.after, "page-2"); assert.equal(first.skipped, 1);
  await assert.rejects(runPricePage({ journal: store, now, runId: first.runId, page: async () => { throw new Error("upstream down"); } }));
  assert.equal((await store.read()).value?.after, "page-2");
  assert.equal((await store.read()).value?.lease, null);
  const complete = await runPricePage({ journal: store, now, runId: first.runId, page: async after => { assert.equal(after, "page-2"); return lastPage; } });
  assert.ok(complete.finishedAt); assert.equal(complete.checked, 1);
  const duplicate = await runPricePage({ journal: store, now, automatic: true, page: async () => { assert.fail("Do not reprice a completed daily run"); } });
  assert.equal(duplicate.runId, first.runId);
  await assert.rejects(runPricePage({ journal: store, now, runId: "different", page: async () => lastPage }), { code: "RUN_CHANGED" });
});

test("a concurrent manual/cron refresh cannot acquire the same lease", async () => {
  const store = journal(); const now = () => Date.now();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let begun!: () => void;
  const began = new Promise<void>(resolve => { begun = resolve; });
  const running = runPricePage({ journal: store, now, page: async () => { begun(); await wait; return lastPage; } });
  await began;
  await assert.rejects(runPricePage({ journal: store, now, page: async () => lastPage }), { code: "SYNC_BUSY" });
  release(); await running;
});

test("broken pagination cannot advance the pricing checkpoint", async () => {
  const store = journal(); const now = () => Date.now();
  const first = await runPricePage({ journal: store, now, page: async () => firstPage });
  await assert.rejects(runPricePage({ journal: store, now, runId: first.runId, page: async () => firstPage }), { code: "PAGINATION_INVALID" });
  assert.equal((await store.read()).value?.after, "page-2");
});

test("cron requires the configured secret and rejects absent/incorrect credentials", () => {
  const request = (authorization?: string) => new Request("https://defy.example/api/shopify/pricing/cron", { headers: authorization ? { authorization } : {} });
  assert.equal(cronAuthorized(request("Bearer test-only-secret"), "test-only-secret"), true);
  for (const value of [undefined, "test-only-secret", "Bearer incorrect-secret"]) assert.equal(cronAuthorized(request(value), "test-only-secret"), false);
  assert.equal(cronAuthorized(request("Bearer "), ""), false);
});
