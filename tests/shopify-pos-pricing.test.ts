import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { refreshPosPrice } from "../lib/shopify/pos-pricing.ts";
import type { SinglesGraphQL } from "../lib/singles/shopify.ts";
import type { Catalog } from "../lib/singles/types.ts";
import type { ScrydexProduct } from "../lib/scrydex.ts";

const field = (value: string) => ({ value });
const catalog: Catalog = { fetchedAt: "2026-09-18", sourceUpdatedAt: "2026-09-18", warnings: [], cards: [{
  key: "652819:Normal", productId: 652819, groupId: 1, name: "Charm", setName: "Origins", setCode: "OGN", number: "043/298",
  rarity: "Common", finish: "Normal", language: "English", imageUrl: "", productUrl: "", marketCents: 50,
}] };
function variant() {
  return {
    id: "gid://shopify/ProductVariant/123", sku: "DEFY-RFB-652819-NORMAL-EN-NM", barcode: "0123456789" as string | null, price: "1.00",
    selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Nonfoil" }, { name: "Language", value: "English" }],
    product: {
      id: "gid://shopify/Product/456", title: "Charm — Origins", status: "ACTIVE", productType: "Riftbound single",
      cardName: field("Charm"), game: field("Riftbound"), set: field("Origins"), number: field("043/298"),
      condition: null as ReturnType<typeof field> | null, finish: null as ReturnType<typeof field> | null, language: null as ReturnType<typeof field> | null,
      catalogId: field("652819") as ReturnType<typeof field> | null, receivingId: field("single:riftbound:printing:652819") as ReturnType<typeof field> | null,
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/123" }], pageInfo: { hasNextPage: false } },
    },
  };
}
type Variant = ReturnType<typeof variant>;
function fixture(initial = [variant()]) {
  const state = { variants: initial, currency: "USD", truncated: false, quoted: [] as ScrydexProduct[], current: undefined as Variant | null | undefined,
    quoteFailure: false, marketCents: 1000, updateFailure: false, returnedId: "gid://shopify/ProductVariant/123", returnedPrice: "", mutations: [] as Record<string, unknown>[], queries: [] as { query: string; variables: Record<string, unknown> }[] };
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    state.queries.push({ query, variables });
    if (query.includes("query DefyPosScan")) return structuredClone({ shop: { currencyCode: state.currency }, productVariants: { nodes: state.variants, pageInfo: { hasNextPage: state.truncated } } }) as T;
    if (query.includes("query DefyPosVerify")) return structuredClone({ shop: { currencyCode: state.currency }, productVariant: state.current === undefined ? state.variants[0] : state.current }) as T;
    if (query.includes("mutation DefyPosPrice")) {
      state.mutations.push(variables);
      const price = (variables.variants as { price: string }[])[0].price;
      return { productVariantsBulkUpdate: { productVariants: [{ id: state.returnedId, price: state.returnedPrice || price }], userErrors: state.updateFailure ? [{ message: "not permitted" }] : [] } } as T;
    }
    throw new Error("Unexpected Shopify operation");
  };
  const dependencies = { graphql, readCatalog: async () => catalog, resolvePrice: async (product: ScrydexProduct) => {
    state.quoted.push(product);
    if (state.quoteFailure) throw new Error("Provider unavailable");
    return { cents: state.marketCents, matchedName: product.name, groupName: product.setName, variation: product.finish, scrydexId: "ogn-043", url: "https://scrydex.com" };
  } };
  return { state, dependencies };
}

test("POS scan updates only the exact Riftbound single price with 10%, never cost or stock", async () => {
  const f = fixture();
  const result = await refreshPosPrice("0123456789", f.dependencies);
  assert.deepEqual(result, { variantId: 123, productId: "gid://shopify/Product/456", sku: "DEFY-RFB-652819-NORMAL-EN-NM", title: "Charm — Origins", priceCents: 1100, currency: "USD", scrydexId: "ogn-043" });
  assert.deepEqual(f.state.mutations, [{ productId: "gid://shopify/Product/456", variants: [{ id: "gid://shopify/ProductVariant/123", price: "11.00" }] }]);
  assert.equal(f.state.quoted[0].finish, "Nonfoil");
  assert.equal(f.state.queries.filter(call => call.query.includes("query DefyPosVerify")).length, 1);
});

test("a complete other-game Shopify identity receives market price without markup or a Riftbound catalog lookup", async () => {
  const item = variant(); item.sku = "PKM-PIKACHU-NM";
  Object.assign(item.product, { cardName: field("Pikachu"), game: field("Pokémon"), productType: "Pokémon single", set: field("Base Set"), number: field("58/102"), catalogId: null, receivingId: null });
  const f = fixture([item]); f.dependencies.readCatalog = async () => { throw new Error("must not load Riftbound catalog"); };
  const result = await refreshPosPrice(item.sku, f.dependencies);
  assert.equal(result.priceCents, 1000); assert.equal(f.state.quoted[0].game, "Pokémon");
  assert.equal((f.state.mutations[0].variants as { price: string }[])[0].price, "10.00");
});

test("Riftbound sealed merchandise receives no markup", async () => {
  const item = variant(); item.sku = "DEFY-RFB-T635368";
  Object.assign(item.product, { cardName: field("Origins Booster Display"), productType: "Riftbound sealed", number: null, catalogId: null, receivingId: null });
  item.selectedOptions = [{ name: "Condition", value: "Unopened" }, { name: "Language", value: "English" }];
  const f = fixture([item]); const result = await refreshPosPrice(item.sku, f.dependencies);
  assert.equal(result.priceCents, 1000); assert.equal(f.state.quoted[0].productType, "Sealed");
});

test("canonical SKU works without a barcode and recovers absent card metadata only from the exact catalog printing", async () => {
  const item = variant(); item.barcode = null;
  Object.assign(item.product, { cardName: null, game: null, set: null, number: null, catalogId: null });
  const f = fixture([item]); await refreshPosPrice(item.sku, f.dependencies);
  assert.equal(f.state.quoted[0].name, "Charm"); assert.equal(f.state.quoted[0].tcgplayerId, 652819);
});

test("legacy hashed SKU needs its unique complete identity and single-variant product", async () => {
  const item = variant(); item.sku = `DEFY-RFB-S652819-${createHash("sha256").update("Normal").digest("hex").slice(0, 12).toUpperCase()}-EN-NM`;
  item.selectedOptions = [{ name: "Title", value: "Default Title" }];
  item.product.receivingId = field("single:riftbound:652819:Normal:English:NM");
  const f = fixture([item]); await refreshPosPrice(item.sku, f.dependencies);
  assert.equal(f.state.quoted[0].condition, "Near Mint");
  item.product.receivingId = null;
  const missing = fixture([item]); await assert.rejects(refreshPosPrice(item.sku, missing.dependencies), { code: "IDENTITY_CONFLICT" });
  assert.equal(missing.state.mutations.length, 0);
});

test("SKU/barcode matches must be exact, unique, complete, and active", async () => {
  const exact = variant();
  for (const [items, code] of [
    [[{ ...exact, sku: `${exact.sku}-OTHER`, barcode: "other" }], "NOT_FOUND"],
    [[exact, { ...exact, id: "gid://shopify/ProductVariant/124" }], "AMBIGUOUS_CODE"],
    [[{ ...exact, product: { ...exact.product, status: "DRAFT" } }], "PRODUCT_UNAVAILABLE"],
  ] as [Variant[], string][]) {
    const f = fixture(items); await assert.rejects(refreshPosPrice(exact.sku, f.dependencies), { code });
    assert.equal(f.state.quoted.length, 0); assert.equal(f.state.mutations.length, 0);
  }
  const f = fixture(); f.state.truncated = true;
  await assert.rejects(refreshPosPrice(exact.sku, f.dependencies), { code: "AMBIGUOUS_CODE" });
  assert.equal(f.state.mutations.length, 0);
});

test("currency mismatch and invalid IDs fail before any price or inventory write", async () => {
  const f = fixture(); f.state.currency = "CAD";
  await assert.rejects(refreshPosPrice("0123456789", f.dependencies), { code: "CURRENCY_UNSUPPORTED" });
  assert.equal(f.state.quoted.length, 0);
  const item = variant(); item.id = "gid://shopify/ProductVariant/9007199254740993";
  const invalid = fixture([item]); await assert.rejects(refreshPosPrice(item.sku, invalid.dependencies), { code: "VARIANT_INVALID" });
  assert.equal(invalid.state.mutations.length, 0);
});

test("contradictory finish, condition, language, game, card ID, and metadata never fall back to another identity", async () => {
  const changes: ((item: Variant) => void)[] = [
    item => { item.selectedOptions[1].value = "Foil"; },
    item => { item.product.condition = field("Lightly Played"); },
    item => { item.selectedOptions[2].value = "Japanese"; },
    item => { item.product.game = field("Pokémon"); },
    item => { item.product.catalogId = field("999999"); },
    item => { item.product.cardName = field("A different card"); },
    item => { item.product.receivingId = field("single:riftbound:printing:999999"); },
    item => { item.selectedOptions.push({ name: "Finish", value: "Foil" }); },
  ];
  for (const change of changes) {
    const item = variant(); change(item); const f = fixture([item]);
    await assert.rejects(refreshPosPrice(item.sku, f.dependencies), { code: "IDENTITY_CONFLICT" });
    assert.equal(f.state.quoted.length, 0); assert.equal(f.state.mutations.length, 0);
  }
});

test("missing canonical variant attributes and generic card metadata are not guessed", async () => {
  const item = variant(); item.selectedOptions = [];
  const missingOptions = fixture([item]); await assert.rejects(refreshPosPrice(item.sku, missingOptions.dependencies), { code: "IDENTITY_REQUIRED" });
  item.sku = "MANUAL-SINGLE"; item.selectedOptions = variant().selectedOptions; item.product.cardName = field(""); item.product.receivingId = null;
  const missingName = fixture([item]); await assert.rejects(refreshPosPrice(item.sku, missingName.dependencies), { code: "IDENTITY_REQUIRED" });
  assert.equal(missingName.state.mutations.length, 0);
});

test("noncanonical SKU still rejects conflicting receiving identity and unsupported language", async () => {
  const item = variant(); item.sku = "CHARM-NM";
  item.product.receivingId = field("single:riftbound:652819:Foil:English:NM");
  const conflict = fixture([item]);
  await assert.rejects(refreshPosPrice(item.sku, conflict.dependencies), { code: "IDENTITY_CONFLICT" });
  assert.equal(conflict.state.quoted.length, 0);
  item.product.receivingId = null; item.selectedOptions[2].value = "Japanese";
  const language = fixture([item]);
  await assert.rejects(refreshPosPrice(item.sku, language.dependencies), { code: "LANGUAGE_UNSUPPORTED" });
  assert.equal(language.state.mutations.length, 0);
});

test("a mapping edit while a quote is loading aborts the update", async () => {
  const f = fixture(); f.state.current = variant(); f.state.current.product.number = field("044/298");
  await assert.rejects(refreshPosPrice("0123456789", f.dependencies), { code: "IDENTITY_CONFLICT" });
  assert.equal(f.state.quoted.length, 1); assert.equal(f.state.mutations.length, 0);
  const disappeared = fixture(); disappeared.state.current = null;
  await assert.rejects(refreshPosPrice("0123456789", disappeared.dependencies), { code: "IDENTITY_CONFLICT" });
});

test("provider and Shopify update failures cannot return a successful cart price", async () => {
  const provider = fixture(); provider.state.quoteFailure = true;
  await assert.rejects(refreshPosPrice("0123456789", provider.dependencies), /Provider unavailable/);
  assert.equal(provider.state.mutations.length, 0);
  for (const change of [(state: ReturnType<typeof fixture>["state"]) => { state.updateFailure = true; },
    (state: ReturnType<typeof fixture>["state"]) => { state.returnedPrice = "1.00"; },
    (state: ReturnType<typeof fixture>["state"]) => { state.returnedId = "gid://shopify/ProductVariant/999"; }]) {
    const f = fixture(); change(f.state);
    await assert.rejects(refreshPosPrice("0123456789", f.dependencies), { code: "PRICE_UPDATE_UNCONFIRMED" });
  }
});

test("unchanged price skips the mutation after verifying current identity", async () => {
  const item = variant(); item.price = "11.00"; const f = fixture([item]);
  assert.equal((await refreshPosPrice(item.sku, f.dependencies)).priceCents, 1100);
  assert.equal(f.state.mutations.length, 0); assert.equal(f.state.queries.length, 2);
});

test("search metacharacters remain within escaped field values and no inexact result is accepted", async () => {
  const code = 'X" OR sku:* (tag:test)\\'; const f = fixture([]);
  await assert.rejects(refreshPosPrice(code, f.dependencies), { code: "NOT_FOUND" });
  assert.deepEqual(f.state.queries[0].variables, { query: String.raw`sku:"X\" OR sku\:* \(tag\:test\)\\" OR barcode:"X\" OR sku\:* \(tag\:test\)\\"` });
  for (const value of ["", "  ", "a\nb", "a".repeat(129)]) {
    const invalid = fixture(); await assert.rejects(refreshPosPrice(value, invalid.dependencies), { code: "INVALID_CODE" });
    assert.equal(invalid.state.queries.length, 0);
  }
});
