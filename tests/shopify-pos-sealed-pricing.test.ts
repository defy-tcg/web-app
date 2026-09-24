import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ScrydexError } from "../lib/scrydex.ts";
import { linkSealedPrice, lookupSealedPrice } from "../lib/shopify/pos-sealed-pricing.ts";
import type { SealedCatalogProduct } from "../lib/scrydex-sealed-catalog.ts";
import type { SinglesGraphQL } from "../lib/singles/shopify.ts";

const key = (code: string) => createHash("sha256").update(code).digest("hex");
const field = (value: string) => ({ value });
const NOW = "2026-09-24T01:02:03.000Z";
const UPC = "820650853166";
const EAN = `0${UPC}`;
const GTIN = `00${UPC}`;
function catalog(id = "sv3pt5-s1"): SealedCatalogProduct {
  return { id, game: "pokemon", name: "151 Elite Trainer Box", setName: "151", language: "English", unit: "Elite Trainer Box",
    imageUrl: "https://images.scrydex.com/sv3pt5-s1/medium", marketCents: 18245 };
}
function variant() {
  return {
    id: "gid://shopify/ProductVariant/10", sku: "290-85316", barcode: UPC as string | null,
    barcodes: { nodes: [{ value: UPC }], pageInfo: { hasNextPage: false } },
    selectedOptions: [{ name: "Title", value: "Default Title" }],
    unit: field("Elite Trainer Box") as ReturnType<typeof field> | null,
    receivingGame: field("Pokémon") as ReturnType<typeof field> | null,
    product: {
      id: "gid://shopify/Product/20", title: "Pokémon 151 Elite Trainer Box", productType: "Pokémon sealed",
      game: field("Pokémon") as ReturnType<typeof field> | null, language: field("English") as ReturnType<typeof field> | null,
      cardName: field(catalog().name) as ReturnType<typeof field> | null, set: field("151") as ReturnType<typeof field> | null,
      condition: field("U") as ReturnType<typeof field> | null,
      finish: field("Normal") as ReturnType<typeof field> | null,
      scrydexId: field(catalog().id) as ReturnType<typeof field> | null,
      receivingId: field(`scrydex:pokemon:${catalog().id}`) as ReturnType<typeof field> | null,
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/10" }], pageInfo: { hasNextPage: false } },
    },
  };
}
type Variant = ReturnType<typeof variant>;
type Stored = { type: string; value: string; compareDigest: string };
type MetafieldInput = { ownerId: string; namespace: string; key: string; type: string; value: string; compareDigest: string | null };
function fixture(initial = [] as Variant[]) {
  const state = {
    variants: initial, truncated: false, ownerId: "gid://shopify/AppInstallation/30", records: new Map<string, Stored>(),
    queries: [] as { query: string; variables: Record<string, unknown> }[], mutations: [] as MetafieldInput[], fetched: [] as string[],
    product: catalog(), failGet: false, failWrite: false, loseResponse: false, loseAndFailRead: false, malformedWrite: false,
    race: null as null | (() => void), serial: 0,
  };
  const save = (code: string, id = catalog().id) => state.records.set(key(code), {
    type: "json", value: JSON.stringify({ version: 1, code, id, game: "pokemon", language: "English" }), compareDigest: `digest-${++state.serial}`,
  });
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}) => {
    state.queries.push({ query, variables });
    if (query.includes("query DefySealedPriceMapping")) {
      if (state.loseAndFailRead && state.mutations.length) throw new Error("private read failure");
      return structuredClone({ currentAppInstallation: { id: state.ownerId, mapping: state.records.get(String(variables.key)) ?? null } }) as T;
    }
    if (query.includes("query DefySealedPriceScan")) return structuredClone({ productVariants: { nodes: state.variants, pageInfo: { hasNextPage: state.truncated } } }) as T;
    if (query.includes("mutation DefySealedPriceMappingCAS")) {
      const fields = variables.metafields as MetafieldInput[];
      assert.equal(fields.length, 1);
      const input = fields[0];
      state.mutations.push(input);
      if (state.failWrite) throw new Error("private write failure");
      state.race?.();
      const current = state.records.get(input.key);
      if ((current?.compareDigest ?? null) !== input.compareDigest) {
        return { metafieldsSet: { metafields: [], userErrors: [{ code: "INVALID_COMPARE_DIGEST" }] } } as T;
      }
      const stored = { type: input.type, value: input.value, compareDigest: `digest-${++state.serial}` };
      state.records.set(input.key, stored);
      if (state.loseResponse || state.loseAndFailRead) throw new Error("private lost write response");
      return { metafieldsSet: { metafields: state.malformedWrite ? [] : [{ ...stored, namespace: input.namespace, key: input.key }], userErrors: [] } } as T;
    }
    throw new Error("Unexpected operation: only app-owned mapping writes are permitted");
  };
  const dependencies = { graphql, now: () => new Date(NOW), getProduct: async (id: string) => {
    state.fetched.push(id);
    if (state.failGet) throw new Error("provider unavailable");
    return { ...state.product, id };
  } };
  return { state, dependencies, save };
}

test("an unregistered manufacturer code is unmapped without any catalog guess or write", async () => {
  const f = fixture();
  assert.deepEqual(await lookupSealedPrice("290-85316", f.dependencies), { status: "unmapped", code: "290-85316" });
  assert.equal(f.state.fetched.length, 0);
  assert.equal(f.state.mutations.length, 0);
});

test("a confirmed SKU mapping is authoritative and reads fresh market price on every scan", async () => {
  const wrongShopifyItem = variant(); wrongShopifyItem.product.game = field("Riftbound");
  const f = fixture([wrongShopifyItem]); f.save("290-85316");
  assert.deepEqual(await lookupSealedPrice(" 290-85316 ", f.dependencies), { status: "quoted", quote: {
    code: "290-85316", product: catalog(), currency: "USD", fetchedAt: NOW, mappingSource: "saved",
  } });
  f.state.product.marketCents = 19001;
  const second = await lookupSealedPrice("290-85316", f.dependencies);
  assert.equal(second.status === "quoted" && second.quote.product.marketCents, 19001);
  assert.equal(f.state.queries.length, 2);
  assert.deepEqual(f.state.fetched, [catalog().id, catalog().id]);
  assert.equal(f.state.mutations.length, 0);
});

test("checksum-valid UPC, EAN, and GTIN14 share one saved mapping", async () => {
  const f = fixture();
  const quote = await linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, f.dependencies);
  assert.equal(quote.mappingSource, "confirmed");
  assert.equal(quote.code, UPC);
  assert.equal(f.state.records.size, 1);
  assert.ok(f.state.records.has(key(GTIN)));
  for (const code of [UPC, EAN, GTIN]) {
    const result = await lookupSealedPrice(code, f.dependencies);
    assert.equal(result.status === "quoted" && result.quote.code, code);
    assert.equal(result.status === "quoted" && result.quote.mappingSource, "saved");
  }
  assert.deepEqual(f.state.mutations[0], {
    ownerId: f.state.ownerId, namespace: "defy_sealed_prices", key: key(GTIN), type: "json", compareDigest: null,
    value: JSON.stringify({ version: 1, code: GTIN, id: catalog().id, game: "pokemon", language: "English" }),
  });
});

test("valid EAN8 padding aliases are recognized, and a nonzero GTIN14 case indicator stays distinct", async () => {
  const f = fixture();
  await linkSealedPrice({ code: "96385074", id: catalog().id, expectedId: null }, f.dependencies);
  assert.equal((await lookupSealedPrice("00000096385074", f.dependencies)).status, "quoted");
  const caseCode = "10820650853163";
  await linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, f.dependencies);
  assert.deepEqual(await lookupSealedPrice(caseCode, f.dependencies), { status: "unmapped", code: caseCode });
  const query = f.state.queries.at(-1)!.variables.query;
  assert.equal(query, `sku:"${caseCode}" OR barcode:"${caseCode}"`);
});

test("invalid numeric checksums, arbitrary manufacturer SKUs, case, and leading zeros remain exact", async () => {
  const f = fixture();
  for (const code of ["820650853167", "00820650853167", "00042", "AbC-001", "ABC  001"]) {
    await linkSealedPrice({ code, id: catalog().id, expectedId: null }, f.dependencies);
    assert.ok(f.state.records.has(key(code)));
  }
  for (const code of ["0820650853167", "42", "abc-001", "ABC 001"]) {
    assert.equal((await lookupSealedPrice(code, f.dependencies)).status, "unmapped");
    assert.equal(f.state.queries.at(-1)!.variables.query, `sku:"${code}" OR barcode:"${code}"`);
  }
});

test("Shopify SKU, primary barcode, and secondary barcode use exact coherent receiving identities", async () => {
  for (const code of ["290-85316", UPC, EAN, GTIN, "Manufacturer-QR-001"]) {
    const item = variant(); item.barcodes.nodes.push({ value: "Manufacturer-QR-001" });
    const f = fixture([item]);
    const result = await lookupSealedPrice(code, f.dependencies);
    assert.equal(result.status === "quoted" && result.quote.mappingSource, "shopify");
    assert.equal(result.status === "quoted" && result.quote.product.id, catalog().id);
    assert.equal(f.state.mutations.length, 0);
    assert.match(f.state.queries[1].query, /barcodes\(first: 20\)/);
  }
});

test("a coherent card.scrydex_id works without receiving metadata", async () => {
  const item = variant(); item.product.receivingId = null;
  const f = fixture([item]);
  const result = await lookupSealedPrice(item.sku, f.dependencies);
  assert.equal(result.status === "quoted" && result.quote.product.id, catalog().id);
});

test("a Shopify product without an exact sealed catalog ID suggests its title for staff selection", async () => {
  const item = variant(); item.product.receivingId = null; item.product.scrydexId = null;
  const f = fixture([item]);
  assert.deepEqual(await lookupSealedPrice(item.sku, f.dependencies), {
    status: "unmapped", code: item.sku, suggestedQuery: item.product.title,
  });
  assert.equal(f.state.fetched.length, 0);
  item.product.scrydexId = field(catalog().id); item.product.language = null;
  assert.equal((await lookupSealedPrice(item.sku, f.dependencies)).status, "unmapped");
});

test("ordinary Shopify categories without catalog identity remain available for staff matching", async () => {
  for (const productType of ["Booster Box", "Trading Card Games", "", "Pokemon Booster Box"]) {
    const item = variant(); item.product.productType = productType; item.product.receivingId = null; item.product.scrydexId = null;
    const f = fixture([item]);
    assert.deepEqual(await lookupSealedPrice(item.sku, f.dependencies), { status: "unmapped", code: item.sku, suggestedQuery: item.product.title });
    assert.equal(f.state.fetched.length, 0);
    assert.equal((await linkSealedPrice({ code: item.sku, id: catalog().id, expectedId: null }, f.dependencies)).mappingSource, "confirmed");
  }
});

test("inexact Shopify matches cannot supply an inferred catalog product", async () => {
  const item = variant(); item.sku = "ABC-001";
  const f = fixture([item]);
  assert.deepEqual(await lookupSealedPrice("abc-001", f.dependencies), { status: "unmapped", code: "abc-001" });
  assert.equal(f.state.fetched.length, 0);
});

test("duplicate codes and incomplete variant or secondary-barcode pages reject before price lookup", async () => {
  const base = variant();
  const duplicate = variant(); duplicate.id = "gid://shopify/ProductVariant/11"; duplicate.barcode = EAN;
  duplicate.barcodes.nodes = [{ value: EAN }];
  for (const configure of [
    (f: ReturnType<typeof fixture>) => { f.state.variants.push(duplicate); },
    (f: ReturnType<typeof fixture>) => { f.state.truncated = true; },
    (f: ReturnType<typeof fixture>) => { f.state.variants[0].barcodes.pageInfo.hasNextPage = true; },
  ]) {
    const f = fixture([structuredClone(base)]); configure(f);
    await assert.rejects(lookupSealedPrice(UPC, f.dependencies), { code: "AMBIGUOUS_CODE", status: 409 });
    assert.equal(f.state.fetched.length, 0); assert.equal(f.state.mutations.length, 0);
  }
});

test("conflicting catalog IDs, games, languages, and package identities never produce a quote", async () => {
  for (const edit of [
    (v: Variant) => { v.product.scrydexId = field("different-id"); },
    (v: Variant) => { v.product.receivingId = field("scrydex:onepiece:sv3pt5-s1"); },
    (v: Variant) => { v.product.game = field("Riftbound"); },
    (v: Variant) => { v.receivingGame = field("Riftbound"); },
    (v: Variant) => { v.selectedOptions = [{ name: "Language", value: "Japanese" }]; },
    (v: Variant) => { v.selectedOptions = [{ name: "Language", value: "English" }, { name: "Language", value: "English" }]; },
    (v: Variant) => { v.product.receivingId = field("single:tcgplayer:printing:123"); },
    (v: Variant) => { v.product.variants.nodes.push({ id: "gid://shopify/ProductVariant/11" }); },
    (v: Variant) => { v.product.variants.pageInfo.hasNextPage = true; },
    (v: Variant) => { v.product.receivingId = field("scrydex:pokemon:../private"); },
    (v: Variant) => { v.product.cardName = field("151 Booster Bundle"); },
    (v: Variant) => { v.product.set = field("An unrelated set"); },
    (v: Variant) => { v.selectedOptions = [{ name: "Condition", value: "Opened" }]; },
    (v: Variant) => { v.selectedOptions = [{ name: "Finish", value: "First Edition" }]; },
    (v: Variant) => { v.unit = field("Booster bundle"); },
    (v: Variant) => { v.selectedOptions = [{ name: "Package", value: "Case" }]; },
  ]) {
    const item = variant(); edit(item); const f = fixture([item]);
    await assert.rejects(lookupSealedPrice(UPC, f.dependencies), { code: "IDENTITY_CONFLICT" });
    assert.equal(f.state.mutations.length, 0);
  }
});

test("unsupported games, languages, single cards, and opened products are rejected", async () => {
  for (const edit of [
    (v: Variant) => { v.product.productType = "Pokémon single"; },
    (v: Variant) => { v.product.language = field("Japanese"); },
    (v: Variant) => { v.product.condition = field("Near Mint"); },
    (v: Variant) => { v.product.finish = field("First Edition"); },
    (v: Variant) => { v.product.productType = "One Piece sealed"; v.product.game = field("One Piece"); v.receivingGame = field("One Piece"); v.product.receivingId = field("scrydex:onepiece:sv3pt5-s1"); },
  ]) {
    const item = variant(); edit(item); const f = fixture([item]);
    await assert.rejects(lookupSealedPrice(UPC, f.dependencies), { code: "PRODUCT_UNSUPPORTED" });
    assert.equal(f.state.fetched.length, 0); assert.equal(f.state.mutations.length, 0);
  }
});

test("saved quote failures retain the exact recoverable match and sanitize provider errors", async () => {
  for (const providerCode of ["not_configured", "unsupported", "incomplete_identity", "not_found", "ambiguous", "price_unavailable", "upstream_error"] as const) {
    const f = fixture(); f.save(GTIN);
    f.dependencies.getProduct = async () => { throw new ScrydexError(providerCode, "private upstream secret"); };
    await assert.rejects(lookupSealedPrice(UPC, f.dependencies), error => {
      const value = error as Error & { code: string; status: number; match: { id: string; source: string } };
      assert.equal(value.code, providerCode);
      assert.deepEqual(value.match, { id: catalog().id, source: "saved" });
      assert.equal(value.message.includes("private"), false);
      assert.equal(value.status, providerCode === "not_found" ? 404 : providerCode === "ambiguous" ? 409
        : ["not_configured", "upstream_error"].includes(providerCode) ? 503 : 422);
      return true;
    });
  }
  const unavailable = fixture(); unavailable.save(GTIN); unavailable.state.product.marketCents = null;
  await assert.rejects(lookupSealedPrice(UPC, unavailable.dependencies), {
    code: "PRICE_UNAVAILABLE", match: { id: catalog().id, source: "saved" },
  });
  const unknown = fixture(); unknown.save(GTIN); unknown.state.failGet = true;
  await assert.rejects(lookupSealedPrice(UPC, unknown.dependencies), {
    code: "sealed_pricing_unavailable", status: 503, message: "Sealed pricing is unavailable. Try scanning this package again shortly.",
    match: { id: catalog().id, source: "saved" },
  });
});

test("a confirmed correction replaces only the expected saved mapping with compare-and-set", async () => {
  const f = fixture(); f.save(GTIN, "old-id");
  const oldDigest = f.state.records.get(key(GTIN))!.compareDigest;
  const result = await linkSealedPrice({ code: EAN, id: catalog().id, expectedId: "old-id" }, f.dependencies);
  assert.equal(result.product.id, catalog().id);
  assert.equal(f.state.mutations[0].compareDigest, oldDigest);
  assert.equal(f.state.mutations[0].ownerId, f.state.ownerId);
  assert.equal(JSON.parse(f.state.records.get(key(GTIN))!.value).id, catalog().id);
  assert.equal(f.state.queries.some(call => /product(?:Create|Update|VariantsBulkUpdate)|inventory|price:/.test(call.query)), false);
});

test("stale correction and stale first-create requests cannot overwrite newer staff selections", async () => {
  for (const expectedId of [null, "old-id"]) {
    const f = fixture(); f.save(GTIN, "another-id");
    await assert.rejects(linkSealedPrice({ code: UPC, id: catalog().id, expectedId }, f.dependencies), { code: "MAPPING_CHANGED" });
    assert.equal(f.state.mutations.length, 0); assert.equal(f.state.fetched.length, 0);
    assert.equal(JSON.parse(f.state.records.get(key(GTIN))!.value).id, "another-id");
  }
});

test("a concurrent first save or remap wins without being overwritten", async () => {
  for (const expectedId of [null, "old-id"]) {
    const f = fixture();
    if (expectedId) f.save(GTIN, expectedId);
    f.state.race = () => f.save(GTIN, "concurrent-id");
    await assert.rejects(linkSealedPrice({ code: UPC, id: catalog().id, expectedId }, f.dependencies), { code: "MAPPING_CHANGED" });
    assert.equal(f.state.mutations.length, 1);
    assert.equal(JSON.parse(f.state.records.get(key(GTIN))!.value).id, "concurrent-id");
  }
});

test("lost mutation responses are confirmed from Shopify, and original retry inputs are idempotent", async () => {
  for (const expectedId of [null, "old-id"]) {
    const f = fixture(); if (expectedId) f.save(GTIN, expectedId);
    f.state.loseResponse = true;
    const input = { code: UPC, id: catalog().id, expectedId };
    assert.equal((await linkSealedPrice(input, f.dependencies)).product.id, catalog().id);
    assert.equal((await linkSealedPrice(input, f.dependencies)).product.id, catalog().id);
    assert.equal(f.state.mutations.length, 1);
    assert.equal(f.state.fetched.length, 2);
  }
});

test("an unconfirmed response may be retried after connectivity returns without another write", async () => {
  const f = fixture(); f.state.loseAndFailRead = true;
  const input = { code: UPC, id: catalog().id, expectedId: null };
  await assert.rejects(linkSealedPrice(input, f.dependencies), { code: "MAPPING_UNCONFIRMED" });
  assert.equal(f.state.records.size, 1);
  f.state.loseAndFailRead = false;
  assert.equal((await linkSealedPrice(input, f.dependencies)).product.id, catalog().id);
  assert.equal(f.state.mutations.length, 1);
});

test("write failures do not return success, while incomplete acknowledgements require a saved readback", async () => {
  const failed = fixture(); failed.state.failWrite = true;
  await assert.rejects(linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, failed.dependencies), { code: "MAPPING_UNCONFIRMED" });
  assert.equal(failed.state.records.size, 0);
  const incomplete = fixture(); incomplete.state.malformedWrite = true;
  assert.equal((await linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, incomplete.dependencies)).product.id, catalog().id);
  assert.equal(incomplete.state.queries.filter(call => call.query.includes("query DefySealedPriceMapping")).length, 2);
});

test("missing, fractional, zero, negative, and nonfinite markets cannot produce or save a price quote", async () => {
  for (const marketCents of [null, 0, -10, 1.5, NaN, Infinity, 100_000_001]) {
    const f = fixture(); f.state.product.marketCents = marketCents;
    await assert.rejects(linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, f.dependencies), { code: "PRICE_UNAVAILABLE" });
    assert.equal(f.state.mutations.length, 0);
    f.save(GTIN);
    await assert.rejects(lookupSealedPrice(UPC, f.dependencies), { code: "PRICE_UNAVAILABLE" });
  }
});

test("provider detail must still match the requested English Pokémon sealed identity", async () => {
  for (const changes of [{ id: "wrong-id" }, { game: "onepiece" }, { language: "Japanese" }, { name: "" }, { unit: "" }]) {
    const f = fixture(); f.dependencies.getProduct = async () => ({ ...catalog(), ...changes }) as SealedCatalogProduct;
    await assert.rejects(linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, f.dependencies), { code: "PRODUCT_UNVERIFIED" });
    assert.equal(f.state.mutations.length, 0);
  }
});

test("malformed saved data fails closed, including key collisions and missing compare digests", async () => {
  for (const change of [
    (stored: Stored) => { stored.value = "{"; },
    (stored: Stored) => { stored.value = "null"; },
    (stored: Stored) => { stored.compareDigest = ""; },
    (stored: Stored) => { stored.type = "single_line_text_field"; },
    (stored: Stored) => { const value = JSON.parse(stored.value); value.code = "ANOTHER"; stored.value = JSON.stringify(value); },
    (stored: Stored) => { const value = JSON.parse(stored.value); value.game = "onepiece"; stored.value = JSON.stringify(value); },
    (stored: Stored) => { const value = JSON.parse(stored.value); value.id = "../private"; stored.value = JSON.stringify(value); },
  ]) {
    const f = fixture(); f.save(GTIN); change(f.state.records.get(key(GTIN))!);
    await assert.rejects(lookupSealedPrice(UPC, f.dependencies), { code: "MAPPING_INVALID" });
    await assert.rejects(linkSealedPrice({ code: UPC, id: catalog().id, expectedId: null }, f.dependencies), { code: "MAPPING_INVALID" });
    assert.equal(f.state.fetched.length, 0); assert.equal(f.state.mutations.length, 0);
  }
});

test("invalid inputs are rejected before dependencies and query metacharacters stay escaped", async () => {
  for (const code of ["", "  ", "a".repeat(129), "a\nb", "a\u0085b"]) {
    const f = fixture();
    await assert.rejects(lookupSealedPrice(code, f.dependencies), { code: "INVALID_CODE" });
    assert.equal(f.state.queries.length, 0);
  }
  for (const id of ["", "../private", "a/b", "a".repeat(101)]) {
    const f = fixture();
    await assert.rejects(linkSealedPrice({ code: UPC, id, expectedId: null }, f.dependencies), { code: "INVALID_PRODUCT" });
    assert.equal(f.state.queries.length, 0);
  }
  const f = fixture(); const code = 'X" OR sku:* (tag:test)\\';
  assert.deepEqual(await lookupSealedPrice(code, f.dependencies), { status: "unmapped", code });
  assert.deepEqual(f.state.queries[1].variables, { query: String.raw`sku:"X\" OR sku\:* \(tag\:test\)\\" OR barcode:"X\" OR sku\:* \(tag\:test\)\\"` });
});
