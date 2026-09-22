import assert from "node:assert/strict";
import test from "node:test";
import { digest, previewSingles, type ReceiptRow, type SinglesContext } from "../lib/singles/intake.ts";
import { LEGACY_DEFY_MAPPING, ShopifySinglesAdapter, type SinglesGraphQL } from "../lib/singles/shopify.ts";
import type { CatalogCard } from "../lib/singles/types.ts";

const card: CatalogCard = { key: "652819:Normal", productId: 652819, groupId: 1, name: "Charm", setName: "Origins", setCode: "OGN", number: "043/298", rarity: "Common", finish: "Normal", language: "English", imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/652819_200w.jpg", productUrl: "", marketCents: 100 };
const plan = (changes: Partial<CatalogCard> = {}, condition = "Near Mint") => previewSingles([{ cardKey: changes.key || card.key, condition, quantity: 2, costCents: 25, priceCents: 100 }], { fetchedAt: "2026-09-18", sourceUpdatedAt: "2026-09-18", warnings: [], cards: [{ ...card, ...changes }] }).rows[0];
const context: SinglesContext = { shopId: "shop", shop: LEGACY_DEFY_MAPPING.shop, locationId: "location", locationName: "Redmond", currencyCode: "USD", receivingNamespace: "app--1--receiving", publicationIds: ["online", "pos", "website"] };
const options = (finish = "Nonfoil", condition = "Near Mint") => [{ name: "Condition", value: condition }, { name: "Finish", value: finish }, { name: "Language", value: "English" }];
const variant = (id: string, sku: string, selectedOptions = options()) => ({ id, sku, price: "1.00", inventoryQuantity: 4, inventoryPolicy: "DENY", selectedOptions, inventoryItem: { id: `item-${id}`, tracked: true } });
type Variant = ReturnType<typeof variant>;
type Product = { id: string; status: string; title: string; catalogId: { value: string } | null; storefrontCatalogId: { value: string } | null; options: { name: string }[]; variants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } } };
const product = (id: string, variants = [variant("normal", plan().sku)], source = "652819"): Product => ({ id, title: "Original title", status: "ACTIVE", catalogId: null, storefrontCatalogId: source ? { value: source } : null, options: ["Condition", "Finish", "Language"].map(name => ({ name })), variants: { nodes: variants, pageInfo: { hasNextPage: false } } });
function fixture(initial: Product[] = [], pageSize = 100, shop = "defy-receiving-test.myshopify.com") {
  const products = new Map(initial.map(item => [item.id, structuredClone(item)]));
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const state = { loseCreate: false, loseVariant: false, receivingCatalogType: "id", publications: [{ id: "online", name: "Online Store", catalog: { title: "Online Store" } }, { id: "pos", name: "Point of Sale", catalog: { title: "Point of Sale" } }, { id: "gid://shopify/Publication/202600611926", name: "Defy TCG website", catalog: { title: "Headless" } }] };
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ query, variables });
    if (query.includes("query SinglesMappings")) {
      const prefixes = [...String(variables.query).matchAll(/sku:([^ *]+)\*/g)].map(match => match[1]);
      const all = [...products.values()].flatMap(p => p.variants.nodes.filter(v => prefixes.some(prefix => v.sku.startsWith(prefix))).map(v => ({ ...v, product: { ...p, variants: undefined } })));
      const after = Number(variables.after || 0), end = after + pageSize;
      return structuredClone({ productVariants: { nodes: all.slice(after, end), pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } }) as T;
    }
    if (query.includes("query SinglesStorefrontHandle")) return { productByIdentifier: null } as T;
    if (query.includes("query SinglesTaggedMappings")) return { products: { nodes: [...products.values()].filter(p => p.storefrontCatalogId?.value === String(variables.query).replace("tag:defy-catalog-", "")).map(p => ({ id: p.id })), pageInfo: { hasNextPage: false } } } as T;
    if (query.includes("query SinglesProductById")) return structuredClone({ product: products.get(String(variables.id)) ?? null }) as T;
    if (query.includes("query SinglesProduct(")) {
      const id = (variables.identifier as { customId: { value: string } }).customId.value;
      return structuredClone({ productByIdentifier: [...products.values()].find(p => p.catalogId?.value === id) ?? null }) as T;
    }
    if (query.includes("mutation SinglesCreate")) {
      const input = variables.product as { title: string; metafields: { namespace: string; key: string; type?: string; value: string }[]; productOptions: { name: string; values: { name: string }[] }[] };
      const catalogField = input.metafields.find(f => f.namespace.includes("receiving") && f.key === "catalog_id")!;
      if (catalogField.type && catalogField.type !== state.receivingCatalogType) return { productCreate: { product: null, userErrors: [{ message: `Type ${catalogField.type} must be consistent with the definition's type: ${state.receivingCatalogType}.` }] } } as T;
      const identity = catalogField.value;
      const existing = [...products.values()].find(p => p.catalogId?.value === identity);
      if (existing) return { productCreate: { product: null, userErrors: [{ message: "Catalog ID must be unique" }] } } as T;
      const id = `created-${products.size}`;
      const first = variant(`${id}-initial`, "", input.productOptions.map(o => ({ name: o.name, value: o.values[0].name })));
      first.inventoryQuantity = 0; first.inventoryItem.tracked = false;
      const created = product(id, [first], input.metafields.find(f => f.namespace === "defy_intake")!.value);
      created.title = input.title; created.status = "DRAFT"; created.catalogId = { value: identity };
      products.set(id, created);
      if (state.loseCreate) { state.loseCreate = false; throw new Error("Lost create response"); }
      return { productCreate: { product: { id }, userErrors: [] } } as T;
    }
    if (query.includes("mutation SinglesInitializeVariant") || query.includes("mutation SinglesAddVariant")) {
      const p = products.get(String(variables.id))!;
      const input = (variables.variants as { id?: string; price: string; inventoryItem: { sku: string; tracked: boolean }; optionValues?: { optionName: string; name: string }[] }[])[0];
      if (input.id) {
        const v = p.variants.nodes.find(v => v.id === input.id)!;
        v.sku = input.inventoryItem.sku; v.inventoryItem.tracked = true; v.price = input.price;
      } else p.variants.nodes.push(variant(`added-${p.variants.nodes.length}`, input.inventoryItem.sku, input.optionValues!.map(o => ({ name: o.optionName, value: o.name }))));
      if (state.loseVariant) { state.loseVariant = false; throw new Error("Lost variant response"); }
      return { [input.id ? "productVariantsBulkUpdate" : "productVariantsBulkCreate"]: { userErrors: [] } } as T;
    }
    if (query.includes("mutation SinglesStorefrontMetadata") || query.includes("mutation SinglesMakeActive")) return { productUpdate: { product: { id: (variables.product as { id: string }).id }, userErrors: [] } } as T;
    if (query.includes("mutation SinglesPrice")) return { productVariantsBulkUpdate: { productVariants: variables.variants, userErrors: [] } } as T;
    if (query.includes("query SinglesConnection")) return { shop: { id: "shop", currencyCode: "USD", receiving: { namespace: "app--1--receiving" } }, currentAppInstallation: { accessScopes: ["write_products", "write_inventory", "read_locations", "write_publications"].map(handle => ({ handle })) }, location: { id: "location", name: "Redmond", isActive: true } } as T;
    if (query.includes("query SinglesPublications")) return { publications: { nodes: state.publications, pageInfo: { hasNextPage: false } } } as T;
    if (query.includes("mutation SinglesPublish")) return { publishablePublish: { userErrors: [] } } as T;
    if (query.includes("query SinglesPublished")) return { product: { status: "ACTIVE", online: true, pos: true, website: true } } as T;
    throw new Error(`Unhandled query ${query}`);
  };
  return { products, calls, state, adapter: new ShopifySinglesAdapter(graphql, { shop, locationId: context.locationId }, () => Date.now()) };
}

test("new receiving plans use the storefront's canonical finish and condition SKU", () => {
  assert.equal(plan().sku, "DEFY-RFB-652819-NORMAL-EN-NM");
  assert.equal(plan({ key: "652819:Foil", finish: "Foil" }, "Lightly Played").sku, "DEFY-RFB-652819-FOIL-EN-LP");
});

test("mapping paginates and preserves a storefront variant's product, variant, inventory IDs and its sibling", async () => {
  const p = product("charm", [variant("normal", plan().sku), variant("foil", "DEFY-RFB-652819-FOIL-EN-NM", options("Foil"))]);
  const f = fixture([product("unrelated", [variant("unrelated", "SEALED")], ""), p], 1);
  assert.deepEqual(await f.adapter.resolve(plan(), context), { productId: "charm", variantId: "normal", inventoryItemId: "item-normal", sku: plan().sku });
  assert.equal(f.calls.filter(call => call.query.includes("query SinglesMappings")).length, 2);
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
  assert.deepEqual(f.products.get("charm"), p);
});

test("duplicate SKUs, conflicting metadata, wrong options and untracked stock are blocked without mutations", async () => {
  const duplicate = product("duplicate");
  const wrongSource = product("wrong-source", [variant("normal", plan().sku)], "999999");
  const wrongOptions = product("wrong-options", [variant("normal", plan().sku, options("Foil"))]);
  const untracked = product("untracked"); untracked.variants.nodes[0].inventoryItem.tracked = false;
  for (const initial of [[product("first"), duplicate], [wrongSource], [wrongOptions], [untracked]]) {
    const f = fixture(initial);
    await assert.rejects(f.adapter.resolve(plan(), context), { code: "PRODUCT_IDENTITY_CONFLICT" });
    assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
  }
});

test("old OS identities and frozen receipt SKU survive the canonical SKU change", async () => {
  const row = plan();
  const sku = `DEFY-RFB-S652819-${digest("Normal").slice(0, 12).toUpperCase()}-EN-NM`;
  const p = product("old-os", [variant("old-variant", sku, [{ name: "Title", value: "Default Title" }])], "");
  p.catalogId = { value: row.catalogId }; p.options = [{ name: "Title" }];
  const f = fixture([p]);
  const old = { productId: p.id, variantId: "old-variant", inventoryItemId: "item-old-variant", sku };
  assert.deepEqual(await f.adapter.resolve(row, context), old);
  assert.deepEqual(await f.adapter.resolve({ ...row, sku }, context, old), old);
  await assert.rejects(f.adapter.resolve(row, context, { ...old, inventoryItemId: "changed" }), { code: "PRODUCT_IDENTITY_CONFLICT" });
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
});

test("the exact legacy Defy mapping is reused without assigning a new SKU or changing options", async () => {
  const row = plan({ productId: 652821, key: "652821:Normal", name: "Defy" });
  const v = variant(LEGACY_DEFY_MAPPING.variantId, "", [{ name: "Finish", value: "Non-Foil" }]);
  v.inventoryItem.id = LEGACY_DEFY_MAPPING.inventoryItemId;
  const p = product(LEGACY_DEFY_MAPPING.productId, [v], ""); p.options = [{ name: "Finish" }];
  const f = fixture([p], 100, LEGACY_DEFY_MAPPING.shop);
  assert.deepEqual(await f.adapter.resolve(row, context), { productId: p.id, variantId: v.id, inventoryItemId: v.inventoryItem.id, sku: "" });
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
  p.variants.nodes[0].inventoryItem.id = "wrong";
  await assert.rejects(fixture([p], 100, LEGACY_DEFY_MAPPING.shop).adapter.resolve(row, context), { code: "PRODUCT_IDENTITY_CONFLICT" });
  await assert.rejects(fixture([], 100, LEGACY_DEFY_MAPPING.shop).adapter.resolve(row, context), { code: "PRODUCT_IDENTITY_CONFLICT" });
});

test("adding a condition appends one variant and preserves existing product title, options and other variants", async () => {
  const row = plan({}, "Lightly Played");
  const p = product("charm");
  const f = fixture([p]);
  const result = await f.adapter.resolve(row, context);
  assert.equal(result.productId, p.id); assert.equal(result.sku, "DEFY-RFB-652819-NORMAL-EN-LP");
  const updated = f.products.get(p.id)!;
  assert.equal(updated.title, p.title); assert.deepEqual(updated.options, p.options);
  assert.deepEqual(updated.variants.nodes[0], p.variants.nodes[0]);
  assert.equal(updated.variants.nodes.length, 2);
  assert.equal(f.calls.filter(call => call.query.includes("mutation SinglesCreate")).length, 0);
});

test("a lost new-product response is recovered by unique mapping without another product", async () => {
  const f = fixture(); f.state.loseCreate = true;
  await assert.rejects(f.adapter.resolve(plan(), context), /Lost create response/);
  const result = await f.adapter.resolve(plan(), context);
  assert.equal(f.products.size, 1); assert.equal(result.sku, plan().sku);
  assert.equal(f.calls.filter(call => call.query.includes("mutation SinglesCreate")).length, 1);
  const creation = f.calls.find(call => call.query.includes("mutation SinglesCreate"))!;
  assert.equal((creation.variables.product as { productType: string }).productType, "Riftbound single");
  assert.equal((creation.variables.media as { originalSource: string }[])[0].originalSource, "https://tcgplayer-cdn.tcgplayer.com/product/652819_in_1000x1000.jpg");
  assert.ok(!f.calls.some(call => call.query.includes("productSet(")));
});

test("new single inherits the existing catalog ID definition type and reuses its unique mapping", async () => {
  for (const definitionType of ["id", "single_line_text_field"]) {
    const f = fixture(); f.state.receivingCatalogType = definitionType;
    const row = plan({ key: "652905:Foil", productId: 652905, name: "Time Warp", number: "122/298", rarity: "Epic", finish: "Foil" });
    const item = await f.adapter.resolve(row, await f.adapter.preflight(false));
    assert.equal(item.sku, "DEFY-RFB-652905-FOIL-EN-NM");
    assert.deepEqual(await f.adapter.lookupExisting(row), item);
    assert.deepEqual(await f.adapter.resolve(row, context), item);
    assert.equal(f.products.size, 1);
    const creations = f.calls.filter(call => call.query.includes("mutation SinglesCreate"));
    assert.equal(creations.length, 1);
    const fields = (creations[0].variables.product as { metafields: { namespace: string; key: string; type?: string; value: string }[] }).metafields;
    assert.deepEqual(fields.find(field => field.namespace === context.receivingNamespace), { namespace: context.receivingNamespace, key: "catalog_id", value: "single:riftbound:printing:652905" });
    assert.ok(fields.filter(field => field.namespace !== context.receivingNamespace).every(field => field.type === "single_line_text_field"));
  }
});

test("a lost new-variant response is recovered without inserting the condition twice", async () => {
  const f = fixture([product("charm")]); f.state.loseVariant = true;
  const row = plan({}, "Lightly Played");
  await assert.rejects(f.adapter.resolve(row, context), /Lost variant response/);
  assert.equal((await f.adapter.resolve(row, context)).sku, row.sku);
  assert.equal(f.products.get("charm")!.variants.nodes.length, 2);
  assert.equal(f.calls.filter(call => call.query.includes("mutation SinglesAddVariant")).length, 1);
});

test("existing option identity with an unexpected SKU blocks rather than adding a duplicate", async () => {
  const f = fixture([product("charm", [variant("normal", "SOMEBODY-ELSES-SKU")])]);
  await assert.rejects(f.adapter.resolve(plan(), context), { code: "PRODUCT_IDENTITY_CONFLICT" });
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
});

test("metadata exposes old OS card identity without changing its title, SKU or variant options", async () => {
  const row = plan(); const sku = `DEFY-RFB-S652819-${digest("Normal").slice(0, 12).toUpperCase()}-EN-NM`;
  const f = fixture();
  await f.adapter.metadata(row, { productId: "old", variantId: "old-variant", inventoryItemId: "old-item", sku });
  const input = f.calls.find(call => call.query.includes("SinglesStorefrontMetadata"))!.variables.product as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), ["id", "metafields", "productType"]);
  const fields = input.metafields as { namespace: string; key: string; value: string }[];
  for (const [key, value] of Object.entries({ name: "Charm", game: "Riftbound", condition: "Near Mint", finish: "Nonfoil", language: "English" })) assert.ok(fields.some(field => field.namespace === "card" && field.key === key && field.value === value));
  const price = f.calls.find(call => call.query.includes("SinglesPrice"))!.variables.variants as Record<string, unknown>[];
  assert.deepEqual(Object.keys(price[0]).sort(), ["id", "inventoryItem", "price"]);
});

test("publication requires and verifies Online Store, POS and the existing Headless website", async () => {
  const f = fixture([product("charm")]);
  const inspection = await f.adapter.inspect();
  assert.equal(inspection.status.canPublish, true);
  assert.deepEqual(inspection.context.publicationIds, ["online", "pos", "gid://shopify/Publication/202600611926"]);
  const row = plan(); const item = await f.adapter.resolve(row, context);
  await f.adapter.publish({ ...row, product: item, adjustmentId: "received" } as ReceiptRow, inspection.context);
  const publish = f.calls.find(call => call.query.includes("mutation SinglesPublish"))!;
  assert.equal((publish.variables.input as unknown[]).length, 3);
  assert.ok(f.calls.some(call => call.query.includes("website: publishedOnPublication")));
  f.state.publications.pop();
  assert.equal((await f.adapter.inspect()).status.canPublish, false);
});

test("read-only lookup never creates a missing listing or variant", async () => {
  const f = fixture();
  assert.equal(await f.adapter.lookupExisting(plan()), null);
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
  const g = fixture([product("charm")]);
  assert.equal(await g.adapter.lookupExisting(plan({}, "Lightly Played")), null);
  assert.equal(g.calls.filter(call => call.query.includes("mutation")).length, 0);
});

test("an active product cannot gain a zero-price variant during draft intake", async () => {
  const f = fixture([product("charm")]);
  await assert.rejects(f.adapter.resolve({ ...plan({}, "Lightly Played"), priceCents: 0 }, context), { code: "PRICE_REQUIRED" });
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
});

test("publication refuses a stocked zero-price sibling before activating or publishing the product", async () => {
  const p = product("charm", [variant("normal", plan().sku), variant("foil", "DEFY-RFB-652819-FOIL-EN-NM", options("Foil"))]);
  p.variants.nodes[1].price = "0.00";
  const f = fixture([p]);
  const row = plan(); const item = await f.adapter.lookupExisting(row);
  await assert.rejects(f.adapter.publish({ ...row, product: item!, adjustmentId: "received" }, context), { code: "PRICE_REQUIRED" });
  assert.equal(f.calls.filter(call => call.query.includes("mutation")).length, 0);
});

test("incomplete SKU pagination is rejected before any mutation", async () => {
  const graphql: SinglesGraphQL = async <T>(query: string): Promise<T> => {
    if (query.includes("SinglesMappings")) return { productVariants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } as T;
    return { productByIdentifier: null } as T;
  };
  const adapter = new ShopifySinglesAdapter(graphql, { shop: "defy-receiving-test.myshopify.com", locationId: "location" }, () => Date.now());
  await assert.rejects(adapter.lookupExisting(plan()), { code: "PRODUCT_IDENTITY_CONFLICT" });
});
