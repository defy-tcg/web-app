import assert from "node:assert/strict";
import test from "node:test";
import { linkSkuLabelToShopify, getSkuLabelShopifyStatuses, type SkuLabelShopifyProduct, type SkuLabelShopifyDependencies } from "../lib/sku-label-shopify.ts";
import { ScrydexError } from "../lib/scrydex.ts";

const card: SkuLabelShopifyProduct = { id: 77, sku: "DEFY-9775456393", name: "Time Warp", game: "Magic: The Gathering", setName: "Test set", cardNumber: "122", condition: "Near Mint", finish: "Foil", tcgplayerId: 652905, costCents: 0, listPriceCents: 0, quantity: 0, initialQuantity: 0 };
type Barcode = { value: string; type: string | null };
type Variant = { id: string; sku: string | null; barcode: string | null; barcodes: { nodes: Barcode[]; pageInfo: { hasNextPage: boolean } }; price: string; inventoryQuantity: number; inventoryPolicy: string; inventoryItem: { id: string; tracked: boolean }; selectedOptions: { name: string; value: string }[]; pos: boolean; qrIdentity: { value: string } | null };
type Product = { id: string; status: string; pos: boolean; catalogId: { value: string } | null; sourceId: { value: string } | null; manualOrigin?: { value: string } | null; options: { name: string }[]; variants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type Fields = { namespace: string; key: string; value: string; compareDigest?: string | null };
type VariantInput = { id?: string; barcodes?: { value: string; type?: string }[]; price?: string; inventoryPolicy?: string; inventoryItem?: { sku?: string; tracked?: boolean }; metafields?: Fields[]; optionValues?: { optionName: string; name: string }[] };
function fixture(options: { missingScopes?: boolean; priceError?: boolean; starting?: Product; failAfterCreate?: boolean; failAfterStock?: boolean; failBeforePublish?: boolean; untagged?: boolean; failAfterAdopt?: boolean } = {}) {
  let time = 1_800_000_000_000;
  let product = options.starting ? structuredClone(options.starting) : null;
  let serial = 0;
  const journals = new Map<string, { value: string; compareDigest: string }>();
  const calls: { name: string; variables: Record<string, unknown> }[] = [];
  const adjustments = new Map<string, string>();
  let quantityAdded = 0;
  let failedCreate = false, failedStock = false, failedPublish = false, failedAdopt = false;
  const clone = <T>(value: T) => structuredClone(value);
  const variant = (id: string, opts = [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }]): Variant => ({ id, sku: null, barcode: null, barcodes: { nodes: [], pageInfo: { hasNextPage: false } }, price: "0.00", inventoryQuantity: 0, inventoryPolicy: "DENY", inventoryItem: { id: `gid://shopify/InventoryItem/${id.split("/").at(-1)}`, tracked: false }, selectedOptions: opts, pos: false, qrIdentity: null });
  const deps: SkuLabelShopifyDependencies = {
    settings: { shop: "defy-receiving-test.myshopify.com", locationId: "gid://shopify/Location/1" }, clock: () => time,
    resolvePrice: async () => { if (options.priceError) throw new ScrydexError("not_found", "Private upstream detail"); return { cents: 4802, matchedName: card.name, groupName: card.setName, variation: card.finish, scrydexId: "card-1", url: "https://example.com" }; },
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] || "unknown";
      calls.push({ name, variables: clone(variables) });
      let result: unknown;
      const current = () => product ? { ...clone(product), storefrontCatalogId: clone(product.sourceId) } : null;
      switch (name) {
        case "QrLinkPreflight": result = { shop: { id: "gid://shopify/Shop/1", currencyCode: "USD", receiving: { value: "{}", namespace: "app--1--receiving" } }, location: { isActive: true }, currentAppInstallation: { accessScopes: (options.missingScopes ? ["write_products", "write_inventory"] : ["write_products", "write_inventory", "write_publications"]).map(handle => ({ handle })) } }; break;
        case "QrLinkStatusConnection": result = { currentAppInstallation: { accessScopes: (options.missingScopes ? ["write_products", "write_inventory"] : ["write_products", "write_inventory", "write_publications"]).map(handle => ({ handle })) } }; break;
        case "QrLinkCatalogScan": result = { products: { nodes: product ? [current()] : [], pageInfo: { hasNextPage: false, endCursor: null } } }; break;
        case "QrLinkPublications": result = { publications: { nodes: [{ id: "gid://shopify/Publication/2", name: "Point of Sale", catalog: null }], pageInfo: { hasNextPage: false } } }; break;
        case "QrLinkByIdentity": case "QrLinkOriginalManual": case "SinglesProduct": {
          const identifier = variables.identifier as { customId: { value: string } };
          result = { productByIdentifier: product?.catalogId?.value === identifier.customId.value ? current() : null }; break;
        }
        case "QrLinkProduct": case "SinglesProductById": result = { product: variables.id === product?.id ? current() : null }; break;
        case "SinglesStorefrontHandle": result = { productByIdentifier: null }; break;
        case "SinglesMappings": result = { productVariants: { nodes: product?.variants.nodes.filter(item => item.sku?.startsWith("DEFY-RFB-")).map(item => ({ ...clone(item), product: { id: product!.id } })) || [], pageInfo: { hasNextPage: false } } }; break;
        case "SinglesTaggedMappings": case "QrLinkTagged": result = { products: { nodes: !options.untagged && product?.sourceId?.value === String(card.tcgplayerId) ? [{ id: product.id }] : [], pageInfo: { hasNextPage: false } } }; break;
        case "SinglesRecord": result = { shop: { id: "gid://shopify/Shop/1", metafield: journals.has(String(variables.key)) ? clone(journals.get(String(variables.key))) : null } }; break;
        case "SinglesRecordCAS": {
          const field = (variables.metafields as Fields[])[0];
          const current = journals.get(field.key);
          if ((current?.compareDigest ?? null) !== field.compareDigest) result = { metafieldsSet: { metafields: [], userErrors: [{ code: "INVALID_COMPARE_DIGEST", message: "race" }] } };
          else { const saved = { value: field.value, compareDigest: String(++serial) }; journals.set(field.key, saved); result = { metafieldsSet: { metafields: [{ compareDigest: saved.compareDigest }], userErrors: [] } }; }
          break;
        }
        case "QrLinkStatuses": { const fields: Record<string, unknown> = {}; for (const match of query.matchAll(/(q\d+): metafield\(namespace: "[^"]+", key: "([^"]+)"\)/g)) fields[match[1]] = journals.get(match[2]) || null; result = { shop: fields }; break; }
        case "QrLinkCode": { const code = /sku:"([^"]+)"/.exec(String(variables.query))?.[1]; result = { productVariants: { nodes: (product?.variants.nodes || []).filter(item => item.sku === code || item.barcodes.nodes.some(barcode => barcode.value === code)).map(item => ({ ...clone(item), product: { id: product!.id } })), pageInfo: { hasNextPage: false } } }; break; }
        case "QrLinkCreate": {
          assert.equal(product, null, "No duplicate product creation");
          const input = variables.product as { metafields: Fields[]; productOptions: { name: string; values: { name: string }[] }[] };
          product = { id: "gid://shopify/Product/12", status: "DRAFT", pos: false, catalogId: { value: input.metafields.find(field => field.key === "catalog_id" && field.namespace.startsWith("app--"))!.value }, sourceId: input.metafields.some(field => field.namespace === "defy_intake") ? { value: input.metafields.find(field => field.namespace === "defy_intake")!.value } : null,
            options: input.productOptions.map(option => ({ name: option.name })), variants: { nodes: [variant("gid://shopify/ProductVariant/123", input.productOptions.map(option => ({ name: option.name, value: option.values[0].name })))], pageInfo: { hasNextPage: false, endCursor: null } } };
          if (options.failAfterCreate && !failedCreate) { failedCreate = true; throw new Error("lost create response"); }
          result = { productCreate: { product: { id: product.id }, userErrors: [] } }; break;
        }
        case "QrLinkAdoptCatalog": {
          const input = variables.product as { metafields: Fields[] };
          product!.catalogId = { value: input.metafields.find(field => field.namespace.startsWith("app--"))!.value };
          product!.sourceId = { value: input.metafields.find(field => field.namespace === "defy_intake")!.value };
          product!.manualOrigin = { value: input.metafields.find(field => field.key === "manual_origin")!.value };
          if (options.failAfterAdopt && !failedAdopt) { failedAdopt = true; throw new Error("lost adoption response"); }
          result = { productUpdate: { userErrors: [] } }; break;
        }
        case "QrLinkAdoptVariant":
        case "QrLinkVariant": case "QrLinkBarcode": {
          const input = (variables.variants as VariantInput[])[0];
          assert.equal(Object.hasOwn(input, "barcode"), false, "Never mix legacy barcode with full barcode input");
          assert.equal(Object.hasOwn(input.inventoryItem || {}, "cost"), false, "Never change cost");
          const match = input.id ? product!.variants.nodes.find(item => item.id === input.id)! : variant(`gid://shopify/ProductVariant/${124 + product!.variants.nodes.length}`, input.optionValues!.map(option => ({ name: option.optionName, value: option.name })));
          if (!input.id) product!.variants.nodes.push(match);
          if (input.barcodes) { match.barcodes.nodes = input.barcodes.map(code => ({ ...code, type: code.type || null })); match.barcode = input.barcodes[0]?.value || null; }
          if (input.price) match.price = input.price;
          if (input.inventoryItem?.sku) match.sku = input.inventoryItem.sku;
          if (input.inventoryItem?.tracked !== undefined) match.inventoryItem.tracked = input.inventoryItem.tracked;
          if (input.inventoryPolicy) match.inventoryPolicy = input.inventoryPolicy;
          if (input.metafields) match.qrIdentity = { value: input.metafields.find(field => field.key === "qr_identity")!.value };
          result = { productVariantsBulkUpdate: { userErrors: [] }, productVariantsBulkCreate: { userErrors: [] } }; break;
        }
        case "QrLinkLiveStatuses": {
          const variants: Record<string, unknown> = {};
          for (const key of Object.keys(variables).filter(key => key.startsWith("variant"))) {
            const index = key.slice("variant".length); const value = product?.variants.nodes.find(item => item.id === variables[key]);
            variants[`v${index}`] = value ? { ...clone(value), product: { id: product!.id, status: product!.status, pos: product!.pos, catalogId: product!.catalogId, sourceId: product!.sourceId, manualOrigin: product!.manualOrigin, variants: { nodes: product!.variants.nodes.map(item => ({ id: item.id })), pageInfo: { hasNextPage: false } } }, inventoryItem: { id: value.inventoryItem.id, tracked: value.inventoryItem.tracked, inventoryLevel: { quantities: [{ name: "available", quantity: value.inventoryQuantity }] } } } : null;
          }
          result = variants; break;
        }
        case "QrLinkStockLocation": result = { inventoryItem: { inventoryLevel: null } }; break;
        case "QrLinkStockActivate": result = { inventoryActivate: { inventoryLevel: { id: "gid://shopify/InventoryLevel/1" }, userErrors: [] } }; break;
        case "QrLinkInitialStock": {
          const key = String(variables.key);
          if (!adjustments.has(key)) { const input = variables.input as { changes: { delta: number }[] }; quantityAdded += input.changes[0].delta; product!.variants.nodes[0].inventoryQuantity += input.changes[0].delta; adjustments.set(key, `gid://shopify/InventoryAdjustmentGroup/${adjustments.size + 1}`); }
          if (options.failAfterStock && !failedStock) { failedStock = true; throw new Error("lost stock response"); }
          result = { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: adjustments.get(key) }, userErrors: [] } }; break;
        }
        case "QrLinkActivate": product!.status = "ACTIVE"; result = { productUpdate: { userErrors: [] } }; break;
        case "QrLinkPublish": if (options.failBeforePublish && !failedPublish) { failedPublish = true; throw new Error("publish unavailable"); } product!.pos = true; result = { publishablePublish: { userErrors: [] } }; break;
        case "QrLinkPublishVariant": product!.variants.nodes.find(item => item.id === variables.id)!.pos = true; result = { publishablePublish: { userErrors: [] } }; break;
        default: throw new Error(`Unhandled mock query ${name}`);
      }
      return clone(result) as T;
    },
  };
  return { deps, calls, journals, product: () => product!, quantityAdded: () => quantityAdded, advance: (amount: number) => { time += amount; } };
}
function existing(overrides: Partial<Variant> = {}): Product {
  return { id: "gid://shopify/Product/12", status: "ACTIVE", pos: true, catalogId: { value: "single:tcgplayer:printing:652905" }, sourceId: { value: "652905" }, options: [{ name: "Condition" }, { name: "Finish" }, { name: "Language" }], variants: { nodes: [{ id: "gid://shopify/ProductVariant/123", sku: card.sku, barcode: "9780262033848", barcodes: { nodes: [{ value: "9780262033848", type: "ISBN" }], pageInfo: { hasNextPage: false } }, price: "50.00", inventoryQuantity: 7, inventoryPolicy: "DENY", inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true }, selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }], pos: true, qrIdentity: null, ...overrides }], pageInfo: { hasNextPage: false, endCursor: null } } };
}

test("QR registration creates one exact card, publishes only POS, and caches confirmed status", async () => {
  const f = fixture(); const result = await linkSkuLabelToShopify(card, f.deps);
  assert.equal(result.status, "ready"); assert.equal(result.priceCents, 4802); assert.equal(f.quantityAdded(), 0);
  assert.equal(f.product().variants.nodes[0].barcode, card.sku);
  assert.deepEqual(f.calls.filter(call => call.name.startsWith("QrLinkPublish")).map(call => call.variables.input), [[{ publicationId: "gid://shopify/Publication/2" }], [{ publicationId: "gid://shopify/Publication/2" }]]);
  const statuses = await getSkuLabelShopifyStatuses([card], f.deps); assert.equal(statuses[0].status, "ready"); assert.ok(statuses[0].checkedAt);
});
test("missing publication permission blocks before any mutation", async () => {
  const f = fixture({ missingScopes: true }); const result = await linkSkuLabelToShopify(card, f.deps);
  assert.equal(result.status, "blocked"); assert.match(result.message, /write_publications/); assert.equal(f.calls.length, 1); assert.equal(f.product(), null);
});
test("unknown Scrydex price never publishes a zero-price linked card", async () => {
  const f = fixture({ priceError: true }); const result = await linkSkuLabelToShopify(card, f.deps);
  assert.equal(result.status, "blocked"); assert.doesNotMatch(result.message, /Private/); assert.equal(f.product(), null);
});
test("manual complete cards use their saved positive sale price without market lookup", async () => {
  const f = fixture({ priceError: true }); const result = await linkSkuLabelToShopify({ ...card, tcgplayerId: null, listPriceCents: 750 }, f.deps);
  assert.equal(result.status, "ready"); assert.equal(result.priceCents, 750);
});
test("manual zero-price cards remain saved and blocked", async () => {
  const f = fixture(); assert.equal((await linkSkuLabelToShopify({ ...card, tcgplayerId: null }, f.deps)).status, "blocked"); assert.equal(f.product(), null);
});
test("existing barcode types, order, SKU, stock, and cost are preserved", async () => {
  const f = fixture({ starting: existing() }); assert.equal((await linkSkuLabelToShopify(card, f.deps)).status, "ready");
  assert.deepEqual(f.product().variants.nodes[0].barcodes.nodes, [{ value: "9780262033848", type: "ISBN" }, { value: card.sku, type: null }]);
  assert.equal(f.product().variants.nodes[0].sku, card.sku); assert.equal(f.product().variants.nodes[0].inventoryQuantity, 7); assert.equal(f.quantityAdded(), 0);
});
test("concurrent employee requests and repeat submissions create only one product and stock receipt", async () => {
  const f = fixture(); const input = { ...card, initialQuantity: 3, quantity: 3 };
  const results = await Promise.all([linkSkuLabelToShopify(input, f.deps), linkSkuLabelToShopify(input, f.deps)]);
  assert.ok(results.some(result => result.status === "ready")); assert.ok(results.some(result => result.status === "pending"));
  assert.equal((await linkSkuLabelToShopify({ ...input, quantity: 1 }, f.deps)).status, "ready");
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1); assert.equal(f.quantityAdded(), 3); assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("lost product creation response recovers the unique product without duplicate creation", async () => {
  const f = fixture({ failAfterCreate: true }); assert.equal((await linkSkuLabelToShopify(card, f.deps)).status, "pending");
  assert.equal((await linkSkuLabelToShopify(card, f.deps)).status, "ready"); assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
});
test("lost stock response replays its identical idempotent receipt without double inventory", async () => {
  const f = fixture({ failAfterStock: true }); const input = { ...card, initialQuantity: 4, quantity: 4 };
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "pending"); assert.equal(f.quantityAdded(), 4);
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready"); assert.equal(f.quantityAdded(), 4);
  const calls = f.calls.filter(call => call.name === "QrLinkInitialStock"); assert.equal(calls.length, 2); assert.deepEqual(calls[0].variables, calls[1].variables);
});
test("uncertain stock outside Shopify replay window fails closed", async () => {
  const f = fixture({ failAfterStock: true }); const input = { ...card, initialQuantity: 4 };
  await linkSkuLabelToShopify(input, f.deps); f.advance(23 * 60 * 60 * 1000 + 1);
  const result = await linkSkuLabelToShopify(input, f.deps); assert.equal(result.status, "blocked"); assert.match(result.message, /window expired/); assert.equal(f.quantityAdded(), 4); assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("publication retry keeps variant mapping and never repeats confirmed initial stock", async () => {
  const f = fixture({ failBeforePublish: true }); const input = { ...card, initialQuantity: 2 };
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "pending"); assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready"); assert.equal(f.quantityAdded(), 2); assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("changed immutable starting receipt is blocked without additional stock", async () => {
  const f = fixture(); await linkSkuLabelToShopify({ ...card, initialQuantity: 2 }, f.deps);
  const result = await linkSkuLabelToShopify({ ...card, initialQuantity: 5 }, f.deps); assert.equal(result.status, "blocked"); assert.match(result.message, /original starting quantity/); assert.equal(f.quantityAdded(), 2);
});
test("an unrelated barcode collision cannot retag or replace the existing product", async () => {
  const wrong = existing({ barcodes: { nodes: [{ value: card.sku, type: null }], pageInfo: { hasNextPage: false } } }); wrong.catalogId = { value: "single:tcgplayer:printing:555" }; wrong.sourceId = { value: "555" };
  const f = fixture({ starting: wrong }); const result = await linkSkuLabelToShopify(card, f.deps); assert.equal(result.status, "blocked"); assert.equal(f.calls.filter(call => ["QrLinkCreate", "QrLinkBarcode", "QrLinkVariant"].includes(call.name)).length, 0);
});
test("stocked sibling with no price blocks product publication", async () => {
  const value = existing(); value.status = "DRAFT"; value.pos = false;
  value.variants.nodes.push({ ...structuredClone(value.variants.nodes[0]), id: "gid://shopify/ProductVariant/456", sku: "sibling", barcode: null, barcodes: { nodes: [], pageInfo: { hasNextPage: false } }, selectedOptions: [{ name: "Condition", value: "Lightly Played" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }], price: "0.00" });
  const f = fixture({ starting: value }); const result = await linkSkuLabelToShopify(card, f.deps); assert.equal(result.status, "blocked"); assert.match(result.message, /Another stocked variant/); assert.equal(f.calls.filter(call => call.name === "QrLinkActivate").length, 0);
});
test("Riftbound registration retains canonical SKU and applies established markup", async () => {
  const f = fixture(); const result = await linkSkuLabelToShopify({ ...card, game: "Riftbound" }, f.deps); assert.equal(result.status, "ready"); assert.equal(result.priceCents, 5090); assert.equal(f.product().variants.nodes[0].sku, "DEFY-RFB-652905-FOIL-EN-NM"); assert.equal(f.product().variants.nodes[0].barcode, card.sku);
});

test("exact TCGplayer and variant identity preserves an existing non-Defy Shopify SKU", async () => {
  const f = fixture({ starting: existing({ sku: "STORE-EXISTING-CARD" }) });
  const result = await linkSkuLabelToShopify(card, f.deps); assert.equal(result.status, "ready"); assert.equal(f.product().variants.nodes[0].sku, "STORE-EXISTING-CARD"); assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 0);
});
test("permission blockers remain visible when the UI polls saved link status", async () => {
  const f = fixture({ missingScopes: true }); const statuses = await getSkuLabelShopifyStatuses([card], f.deps); assert.equal(statuses[0].status, "blocked"); assert.match(statuses[0].message, /write_publications/);
});
test("zero-stock QR registration activates the configured location without adding inventory", async () => {
  const f = fixture(); assert.equal((await linkSkuLabelToShopify(card, f.deps)).status, "ready"); assert.equal(f.calls.filter(call => call.name === "QrLinkStockActivate").length, 1); assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 0);
});

test("library status reads current Shopify price and stock and detects a removed QR barcode", async () => {
  const f = fixture(); await linkSkuLabelToShopify({ ...card, initialQuantity: 3 }, f.deps);
  f.product().variants.nodes[0].inventoryQuantity = 1; f.product().variants.nodes[0].price = "62.00";
  const [current] = await getSkuLabelShopifyStatuses([{ ...card, initialQuantity: 3 }], f.deps);
  assert.equal(current.status, "ready"); assert.equal(current.availableQuantity, 1); assert.equal(current.priceCents, 6200); assert.equal(current.transferredQuantity, 3);
  f.product().variants.nodes[0].barcodes.nodes = [];
  const [changed] = await getSkuLabelShopifyStatuses([{ ...card, initialQuantity: 3 }], f.deps); assert.equal(changed.status, "blocked"); assert.equal(changed.availableQuantity, undefined);
});
test("library rejects a stale completed stock receipt if the immutable initial quantity differs", async () => {
  const f = fixture(); await linkSkuLabelToShopify({ ...card, initialQuantity: 3 }, f.deps);
  assert.equal((await getSkuLabelShopifyStatuses([{ ...card, initialQuantity: 4 }], f.deps))[0].status, "pending");
});

test("legacy product with source metadata but no app identity or tags is reused", async () => {
  const value = existing({ sku: "LEGACY-SKU" }); value.catalogId = null;
  const f = fixture({ starting: value, untagged: true }); const result = await linkSkuLabelToShopify(card, f.deps);
  assert.equal(result.status, "ready"); assert.ok(f.calls.some(call => call.name === "QrLinkCatalogScan")); assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 0); assert.equal(f.product().variants.nodes[0].sku, "LEGACY-SKU");
});

test("changed condition on an already-linked variant blocks retry mutations and live readiness", async () => {
  const f = fixture(); await linkSkuLabelToShopify(card, f.deps);
  f.product().variants.nodes[0].selectedOptions[0].value = "Lightly Played";
  const before = f.calls.length;
  const result = await linkSkuLabelToShopify(card, f.deps); assert.equal(result.status, "blocked");
  assert.equal(f.calls.slice(before).filter(call => ["QrLinkBarcode", "QrLinkVariant", "QrLinkInitialStock"].includes(call.name)).length, 0);
  assert.equal((await getSkuLabelShopifyStatuses([card], f.deps))[0].status, "blocked");
});
test("QR already assigned to a different condition on the same product cannot be duplicated", async () => {
  const value = existing({ sku: "NM-SKU" });
  value.variants.nodes.push({ ...structuredClone(value.variants.nodes[0]), id: "gid://shopify/ProductVariant/456", sku: "LP-SKU", barcodes: { nodes: [{ value: card.sku, type: null }], pageInfo: { hasNextPage: false } }, selectedOptions: [{ name: "Condition", value: "Lightly Played" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }] });
  const f = fixture({ starting: value }); const result = await linkSkuLabelToShopify(card, f.deps); assert.equal(result.status, "blocked"); assert.match(result.message, /another condition or finish/);
  assert.equal(f.calls.filter(call => ["QrLinkBarcode", "QrLinkVariant", "QrLinkInitialStock"].includes(call.name)).length, 0);
});
test("changed source ID makes previously-ready Shopify barcode unavailable in the library", async () => {
  const f = fixture(); await linkSkuLabelToShopify(card, f.deps); f.product().sourceId = { value: "111" };
  assert.equal((await getSkuLabelShopifyStatuses([card], f.deps))[0].status, "blocked");
});

test("manual card enriched with a TCGplayer link retains SKU, variant, and its confirmed starting stock", async () => {
  const f = fixture(); const manual = { ...card, game: "Riftbound", tcgplayerId: null, listPriceCents: 5000, initialQuantity: 3 };
  const first = await linkSkuLabelToShopify(manual, f.deps); assert.equal(first.status, "ready");
  const linked = { ...manual, tcgplayerId: card.tcgplayerId }; const adopted = await linkSkuLabelToShopify(linked, f.deps);
  assert.equal(adopted.status, "ready"); assert.equal(adopted.productId, first.productId); assert.equal(adopted.variantId, first.variantId); assert.equal(f.product().variants.nodes[0].sku, card.sku); assert.equal(f.quantityAdded(), 3);
  assert.equal((await linkSkuLabelToShopify(linked, f.deps)).status, "ready", "Existing Riftbound adapter recognizes the adopted short SKU");
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1); assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("TCGplayer enrichment of an uncertain manual stock receipt replays the original key and payload", async () => {
  const f = fixture({ failAfterStock: true }); const manual = { ...card, game: "Riftbound", tcgplayerId: null, listPriceCents: 5000, initialQuantity: 3 };
  assert.equal((await linkSkuLabelToShopify(manual, f.deps)).status, "pending"); assert.equal(f.quantityAdded(), 3);
  assert.equal((await linkSkuLabelToShopify({ ...manual, tcgplayerId: card.tcgplayerId }, f.deps)).status, "ready");
  assert.equal(f.quantityAdded(), 3); const transfers = f.calls.filter(call => call.name === "QrLinkInitialStock"); assert.equal(transfers.length, 2); assert.deepEqual(transfers[0].variables, transfers[1].variables);
});
test("lost adoption response recovers the same product without duplicate stock or cards", async () => {
  const f = fixture({ failAfterAdopt: true }); const manual = { ...card, tcgplayerId: null, listPriceCents: 5000, initialQuantity: 3 };
  const first = await linkSkuLabelToShopify(manual, f.deps); const linked = { ...manual, tcgplayerId: card.tcgplayerId };
  assert.equal((await linkSkuLabelToShopify(linked, f.deps)).status, "pending");
  const result = await linkSkuLabelToShopify(linked, f.deps); assert.equal(result.status, "ready"); assert.equal(result.variantId, first.variantId); assert.equal(f.quantityAdded(), 3); assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
});

test("new Shopify draft default untracked variant is initialized before POS registration", async () => {
  const f = fixture(); const result = await linkSkuLabelToShopify(card, f.deps); assert.equal(result.status, "ready"); assert.equal(f.product().variants.nodes[0].inventoryItem.tracked, true); assert.equal(f.calls.filter(call => call.name === "QrLinkVariant").length, 1);
});
test("adopting one manual condition preserves existing sibling QR links and accepts new manual conditions", async () => {
  const f = fixture(); const manual = { ...card, game: "Riftbound", tcgplayerId: null, listPriceCents: 5000, initialQuantity: 2 };
  const sibling = { ...manual, id: 78, sku: "DEFY-9775456394", condition: "Lightly Played", initialQuantity: 0 };
  assert.equal((await linkSkuLabelToShopify(manual, f.deps)).status, "ready");
  assert.equal((await linkSkuLabelToShopify(sibling, f.deps)).status, "ready");
  assert.equal((await linkSkuLabelToShopify({ ...manual, tcgplayerId: card.tcgplayerId }, f.deps)).status, "ready");
  assert.equal((await getSkuLabelShopifyStatuses([sibling], f.deps))[0].status, "ready");
  assert.equal((await linkSkuLabelToShopify(sibling, f.deps)).status, "ready");
  assert.equal((await linkSkuLabelToShopify({ ...sibling, id: 79, sku: "DEFY-9775456395", condition: "Moderately Played" }, f.deps)).status, "ready");
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1); assert.equal(f.quantityAdded(), 2);
});

test("manual create response lost before mapping is recovered before adopting TCGplayer, without a second product", async () => {
  const f = fixture({ failAfterCreate: true }); const manual = { ...card, tcgplayerId: null, listPriceCents: 5000, initialQuantity: 3 };
  assert.equal((await linkSkuLabelToShopify(manual, f.deps)).status, "pending");
  const result = await linkSkuLabelToShopify({ ...manual, tcgplayerId: card.tcgplayerId }, f.deps);
  assert.equal(result.status, "ready"); assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1); assert.equal(f.quantityAdded(), 3);
});
