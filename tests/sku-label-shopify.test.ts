import assert from "node:assert/strict";
import test from "node:test";
import { linkSkuLabelToShopify, getSkuLabelShopifyStatuses, readSkuLabelStockTarget, type SkuLabelShopifyProduct, type SkuLabelShopifyDependencies } from "../lib/sku-label-shopify.ts";
import { ScrydexError, selectScrydexPrice, type ScrydexErrorCode } from "../lib/scrydex.ts";
import { digest } from "../lib/singles/intake.ts";

const card: SkuLabelShopifyProduct = { id: 77, sku: "DEFY-9775456393", name: "Time Warp", game: "Magic: The Gathering", setName: "Test set", cardNumber: "122", condition: "Near Mint", finish: "Foil", tcgplayerId: 652905, costCents: 0, listPriceCents: 0, quantity: 0, initialQuantity: 0 };
type Barcode = { value: string; type: string | null };
type Variant = { id: string; sku: string | null; barcode: string | null; barcodes: { nodes: Barcode[]; pageInfo: { hasNextPage: boolean } }; price: string; inventoryQuantity: number; inventoryPolicy: string; inventoryItem: { id: string; tracked: boolean }; selectedOptions: { name: string; value: string }[]; pos: boolean; qrIdentity: { value: string } | null };
type Product = { id: string; status: string; pos: boolean; catalogId: { value: string } | null; sourceId: { value: string } | null; manualOrigin?: { value: string } | null; options: { name: string }[]; variants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type Fields = { namespace: string; key: string; value: string; compareDigest?: string | null };
type VariantInput = { id?: string; barcodes?: { value: string; type?: string }[]; price?: string; inventoryPolicy?: string; inventoryItem?: { sku?: string; tracked?: boolean }; metafields?: Fields[]; optionValues?: { optionName: string; name: string }[] };
type CatalogType = "app" | "market" | "company" | "none";
function fixture(options: { missingScopes?: boolean; priceError?: boolean; starting?: Product; failAfterCreate?: boolean; failAfterStock?: boolean; failBeforePublish?: boolean; untagged?: boolean; failAfterAdopt?: boolean; channels?: { id: string; type: CatalogType }[]; incompleteChannels?: CatalogType; unpublishFailure?: "error" | "unconfirmed" | "response-loss"; changedPolicyIdentity?: boolean; websiteChannel?: "missing" | "ambiguous" | "incomplete" | "same-as-pos" | "legacy"; websiteFailure?: "error" | "unconfirmed" | "response-loss"; changedWebsiteIdentity?: boolean } = {}) {
  let time = 1_800_000_000_000;
  let product = options.starting ? structuredClone(options.starting) : null;
  let serial = 0;
  const journals = new Map<string, { value: string; compareDigest: string }>();
  const calls: { name: string; variables: Record<string, unknown> }[] = [];
  const adjustments = new Map<string, string>();
  const channels = new Map((options.channels ?? []).map(channel => [channel.id, channel.type]));
  const website = { product: false, variants: new Set<string>() };
  let quantityAdded = 0;
  let failedCreate = false, failedStock = false, failedPublish = false, failedAdopt = false, failedUnpublish = false, failedWebsite = false;
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
        case "QrLinkPublications": result = { publications: { nodes: [
          { id: "gid://shopify/Publication/2", name: "Point of Sale", catalog: options.websiteChannel === "same-as-pos" ? { title: "Defy TCG website" } : null },
          ...(options.websiteChannel === "missing" || options.websiteChannel === "same-as-pos" ? [] : [{ id: options.websiteChannel === "legacy" ? "gid://shopify/Publication/202600611926" : "gid://shopify/Publication/30", name: options.websiteChannel === "legacy" ? "Headless" : "Defy TCG website", catalog: null }]),
          ...(options.websiteChannel === "ambiguous" ? [{ id: "gid://shopify/Publication/31", name: "Defy TCG website", catalog: null }] : []),
        ], pageInfo: { hasNextPage: options.websiteChannel === "incomplete" } } }; break;
        case "QrLinkWebsiteAvailability": {
          const value = product?.variants.nodes.find(item => item.id === variables.variant);
          result = { product: product ? { ...current(), website: website.product } : null, variant: value ? { ...clone(value), ...(options.changedWebsiteIdentity ? { qrIdentity: { value: "changed-identity" } } : {}), website: website.variants.has(value.id), product: { id: product!.id } } : null }; break;
        }
        case "QrLinkWebsitePublish":
        case "QrLinkWebsitePublishVariant": {
          assert.deepEqual(variables.input, [{ publicationId: options.websiteChannel === "legacy" ? "gid://shopify/Publication/202600611926" : "gid://shopify/Publication/30" }]);
          if (options.websiteFailure === "error") result = { publishablePublish: { userErrors: [{ message: "Publication rejected" }] } };
          else {
            if (options.websiteFailure !== "unconfirmed") {
              if (name === "QrLinkWebsitePublish") { assert.equal(variables.id, product!.id); website.product = true; }
              else { assert.ok(product!.variants.nodes.some(item => item.id === variables.id)); website.variants.add(String(variables.id)); }
            }
            if (options.websiteFailure === "response-loss" && !failedWebsite) { failedWebsite = true; throw new Error("website publish response lost"); }
            result = { publishablePublish: { userErrors: [] } };
          }
          break;
        }
        case "QrLinkChannelPolicy": {
          for (const type of ["APP", "MARKET", "COMPANY_LOCATION", "NONE"]) assert.ok(query.includes(`catalogType: ${type}`));
          assert.equal(query.match(/onlyPublished: false/g)?.length, 4, "Scheduled publications must also be checked");
          const bindings = Object.fromEntries((["app", "market", "company", "none"] as const).map(type => [type, {
            nodes: [...channels].filter(([, catalogType]) => catalogType === type).map(([id]) => ({ publication: { id } })),
            pageInfo: { hasNextPage: options.incompleteChannels === type },
          }]));
          const value = product?.variants.nodes.find(item => item.id === variables.variant);
          result = { product: product ? { ...current(), ...bindings } : null, variant: value ? { ...clone(value), ...(options.changedPolicyIdentity ? { qrIdentity: { value: "changed-identity" } } : {}), product: { id: product!.id } } : null }; break;
        }
        case "QrLinkInStoreOnly": {
          assert.equal(variables.id, product!.id);
          const input = variables.input as { publicationId: string }[];
          assert.ok(input.length <= 100);
          assert.ok(input.every(item => item.publicationId !== "gid://shopify/Publication/2"), "Never remove POS");
          if (options.unpublishFailure === "error") result = { publishableUnpublish: { userErrors: [{ message: "Unpublish rejected" }] } };
          else {
            if (options.unpublishFailure !== "unconfirmed") input.forEach(item => channels.delete(item.publicationId));
            if (options.unpublishFailure === "response-loss" && !failedUnpublish) { failedUnpublish = true; throw new Error("Unpublish response lost"); }
            result = { publishableUnpublish: { userErrors: [] } };
          }
          break;
        }
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
        case "QrStockTarget": {
          const value = product?.variants.nodes.find(item => item.id === variables.id);
          result = { productVariant: value ? { ...clone(value), product: current(), inventoryItem: { ...clone(value.inventoryItem), inventoryLevel: { location: { id: "gid://shopify/Location/1" }, quantities: [{ name: "available", quantity: value.inventoryQuantity }] } } } : null }; break;
        }
        case "QrStockScanCode": {
          const code = /barcode:"([^"]+)"/.exec(String(variables.query))?.[1];
          result = { productVariants: { nodes: (product?.variants.nodes || []).filter(item => item.barcodes.nodes.some(barcode => barcode.value === code)).map(clone), pageInfo: { hasNextPage: false } } }; break;
        }
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
  return { deps, calls, journals, channels, website, product: () => product!, quantityAdded: () => quantityAdded, advance: (amount: number) => { time += amount; } };
}
function existing(overrides: Partial<Variant> = {}): Product {
  return { id: "gid://shopify/Product/12", status: "ACTIVE", pos: true, catalogId: { value: "single:tcgplayer:printing:652905" }, sourceId: { value: "652905" }, options: [{ name: "Condition" }, { name: "Finish" }, { name: "Language" }], variants: { nodes: [{ id: "gid://shopify/ProductVariant/123", sku: card.sku, barcode: "9780262033848", barcodes: { nodes: [{ value: "9780262033848", type: "ISBN" }], pageInfo: { hasNextPage: false } }, price: "50.00", inventoryQuantity: 7, inventoryPolicy: "DENY", inventoryItem: { id: "gid://shopify/InventoryItem/1", tracked: true }, selectedOptions: [{ name: "Condition", value: "Near Mint" }, { name: "Finish", value: "Foil" }, { name: "Language", value: "English" }], pos: true, qrIdentity: null, ...overrides }], pageInfo: { hasNextPage: false, endCursor: null } } };
}
const japaneseCard: SkuLabelShopifyProduct = { ...card, id: 79, sku: "DEFY-3448510729", name: "Charmander", game: "Pokémon (Japanese)", setName: "SV2a: Pokemon Card 151", cardNumber: "168/165", tcgplayerId: 566513, quantity: 1, initialQuantity: 1 };
const qrJournalKey = (sku: string) => `qr_${digest(sku).slice(0, 60)}`;
const quoteFixture: NonNullable<SkuLabelShopifyDependencies["resolvePrice"]> = async () => ({ cents: 4802, matchedName: "Charmander", groupName: "Pokemon Card 151", variation: "Foil", scrydexId: "fixture-japanese", url: "https://example.com" });

async function blockedJapaneseFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture({ ...options, priceError: true });
  assert.equal((await linkSkuLabelToShopify({ ...japaneseCard, game: "Other" }, f.deps)).status, "blocked");
  assert.equal(f.product(), null);
  f.deps.resolvePrice = quoteFixture;
  return f;
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
test("pricing failures distinguish catalog, price, configuration, and service issues without exposing upstream details", async t => {
  const warning = t.mock.method(console, "warn", () => {});
  const cases: [ScrydexErrorCode, RegExp][] = [
    ["not_found", /catalog mapping needs review/], ["price_unavailable", /no verified positive USD market price/],
    ["not_configured", /pricing is not configured/], ["unsupported", /does not support/],
    ["incomplete_identity", /needs its exact name/], ["ambiguous", /multiple possible matches/],
    ["upstream_error", /Retry this saved QR shortly/],
  ];
  for (const [code, message] of cases) {
    const f = fixture();
    f.deps.resolvePrice = async () => { throw new ScrydexError(code, "Private upstream detail with credentials"); };
    const result = await linkSkuLabelToShopify(card, f.deps);
    assert.equal(result.status, code === "upstream_error" ? "pending" : "blocked");
    assert.match(result.message, message);
    assert.doesNotMatch(result.message, /Private|credentials/);
    assert.equal(f.product(), null);
    assert.equal(f.quantityAdded(), 0);
    assert.deepEqual(warning.mock.calls.at(-1)?.arguments, ["[sku-label-shopify] Scrydex pricing blocked linking", { sku: card.sku, code }]);
    assert.equal((await getSkuLabelShopifyStatuses([card], f.deps))[0].message, result.message);
  }
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
test("Nidoking's actual Pokémon printing keeps its QR, exact market price, and one-time stock receipt", async () => {
  const input: SkuLabelShopifyProduct = {
    ...card, id: 78, sku: "DEFY-3099353165", name: "Nidoking - 174/165", game: "Pokémon",
    setName: "SV: Scarlet & Violet 151", cardNumber: "174/165", condition: "Near Mint", finish: "Foil",
    tcgplayerId: 517029, quantity: 1, initialQuantity: 1,
  };
  // Identity and raw prices from the captured English Scrydex 151 response.
  const expansion = { id: "sv3pt5", name: "151", series: "Scarlet & Violet", code: "MEW", printed_total: 165, language_code: "EN", is_online_only: false };
  const providerCards = [
    {
      id: "sv3pt5-34", name: "Nidoking", number: "34", printed_number: "034/165", language_code: "EN", expansion,
      variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "516024" }], prices: [{ type: "raw", condition: "NM", currency: "USD", market: 0.28 }] }],
    },
    {
      id: "sv3pt5-174", name: "Nidoking", number: "174", printed_number: "174/165", language_code: "EN", expansion,
      variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "517029" }], prices: [
        { type: "raw", condition: "NM", currency: "USD", market: 17.02 },
        { type: "raw", condition: "LP", currency: "USD", market: 16.74 },
      ] }],
    },
  ];
  const f = fixture({ failAfterStock: true });
  f.deps.resolvePrice = async product => {
    const quote = selectScrydexPrice(product, providerCards);
    assert.equal(quote.scrydexId, "sv3pt5-174");
    assert.equal(quote.variation, "holofoil / NM");
    assert.equal(quote.cents, 1702);
    return quote;
  };

  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "pending");
  const variant = structuredClone(f.product().variants.nodes[0]);
  assert.equal(variant.price, "17.02", "Pokémon does not receive the Riftbound markup");
  assert.equal(variant.barcode, input.sku);
  assert.equal(f.quantityAdded(), 1);

  const retried = await linkSkuLabelToShopify(input, f.deps);
  assert.equal(retried.status, "ready");
  assert.equal(retried.priceCents, 1702);
  assert.equal(retried.transferredQuantity, 1);
  assert.equal((await linkSkuLabelToShopify({ ...input, quantity: 0 }, f.deps)).status, "ready");
  assert.equal(f.product().variants.nodes.length, 1);
  assert.equal(f.product().variants.nodes[0].id, variant.id);
  assert.equal(f.product().variants.nodes[0].sku, variant.sku);
  assert.deepEqual(f.product().variants.nodes[0].barcodes.nodes, [{ value: input.sku, type: null }]);
  assert.equal(f.product().variants.nodes[0].price, "17.02");
  assert.equal(f.product().variants.nodes[0].inventoryQuantity, 1);
  assert.equal(f.quantityAdded(), 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
  const stockCalls = f.calls.filter(call => call.name === "QrLinkInitialStock");
  assert.equal(stockCalls.length, 2);
  assert.deepEqual(stockCalls[0].variables, stockCalls[1].variables);
});
test("Mega Evolution resumes a price-blocked QR with its exact quote and one original stock transfer", async () => {
  const input: SkuLabelShopifyProduct = {
    ...card, id: 79, sku: "DEFY-8490864590", name: "Mega Latias ex - 181/132", game: "Pokémon",
    setName: "ME01: Mega Evolution", cardNumber: "181/132", finish: "Foil", tcgplayerId: 654520,
    quantity: 1, initialQuantity: 1,
  };
  const f = fixture({ priceError: true });
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "blocked");
  assert.equal(f.product(), null);
  assert.equal(f.quantityAdded(), 0);
  // Identity and raw prices captured from Scrydex's me1-181 response.
  const providerCards = [{
    id: "me1-181", name: "Mega Latias ex", number: "181", printed_number: "181/132", language_code: "EN",
    expansion: { id: "me1", name: "Mega Evolution", series: "Mega Evolution", code: "MEG", printed_total: 132, language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "654520" }], prices: [
      { type: "raw", condition: "NM", currency: "USD", market: 76.5 },
      { type: "raw", condition: "LP", currency: "USD", market: 85.85 },
    ] }],
  }];
  f.deps.resolvePrice = async product => selectScrydexPrice(product, providerCards);
  const result = await linkSkuLabelToShopify(input, f.deps);
  assert.equal(result.status, "ready");
  assert.equal(result.sku, input.sku);
  assert.equal(result.priceCents, 7650);
  assert.equal(result.transferredQuantity, 1);
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
  const variants = f.product().variants.nodes;
  assert.equal(variants.length, 1);
  assert.equal(variants[0].barcode, input.sku);
  assert.equal(variants[0].price, "76.50");
  assert.equal(f.quantityAdded(), 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("Ancient Mew's verified unnumbered promo repairs the existing QR and transfers starting stock once", async () => {
  const input: SkuLabelShopifyProduct = {
    ...card, id: 98, sku: "DEFY-7174844875", name: "Ancient Mew", game: "Pokémon",
    setName: "Miscellaneous Cards & Products", cardNumber: "1", tcgplayerId: 108589, quantity: 1, initialQuantity: 1,
  };
  const f = fixture({ priceError: true });
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "blocked");
  assert.equal(f.product(), null);
  // Verified live miscp-1 record: TCGplayer's catalog numeral is not printed
  // on this promo, so both Scrydex collector fields are explicitly null.
  f.deps.resolvePrice = async product => selectScrydexPrice(product, [{
    id: "miscp-1", name: "Ancient Mew", number: null, printed_number: null, rarity: "Promo", language_code: "EN",
    expansion: { id: "miscp", name: "Miscellaneous", series: "Other", code: "MISC", printed_total: null, language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "108589" }],
      prices: [{ type: "raw", condition: "NM", currency: "USD", market: 117.64 }] }],
  }]);
  const result = await linkSkuLabelToShopify(input, f.deps);
  assert.equal(result.status, "ready");
  assert.equal(result.priceCents, 11764, "Pokémon uses the unmarked exact market price");
  assert.equal(result.transferredQuantity, 1);
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
  const variants = f.product().variants.nodes;
  assert.equal(variants.length, 1);
  assert.equal(variants[0].barcode, input.sku);
  assert.equal(variants[0].price, "117.64");
  assert.equal(variants[0].pos, true);
  assert.equal(f.website.product, false, "Pokémon remains available in-store only");
  assert.equal(f.quantityAdded(), 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("a price-blocked Japanese card corrects only its unused language identity and retains the original QR stock receipt", async () => {
  const f = await blockedJapaneseFixture({ failAfterStock: true });
  const key = qrJournalKey(japaneseCard.sku);
  const before = JSON.parse(f.journals.get(key)!.value);
  assert.equal(JSON.parse(before.identity)[3], "English");
  assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "pending");
  const partial = JSON.parse(f.journals.get(key)!.value);
  assert.equal(JSON.parse(partial.identity)[3], "Japanese");
  assert.equal(partial.stockRequestKey, before.stockRequestKey);
  assert.equal(partial.initialQuantity, 1);
  assert.equal(partial.previousIdentity, undefined);
  assert.equal(partial.adoptionPending, undefined);
  const ready = await linkSkuLabelToShopify(japaneseCard, f.deps);
  assert.equal(ready.status, "ready");
  assert.equal(ready.priceCents, 4802, "Japanese Pokémon does not receive a Riftbound markup");
  assert.equal(ready.transferredQuantity, 1);
  const variant = f.product().variants.nodes[0];
  assert.equal(variant.sku, japaneseCard.sku);
  assert.deepEqual(variant.barcodes.nodes, [{ value: japaneseCard.sku, type: null }]);
  assert.equal(variant.selectedOptions.find(option => option.name === "Language")!.value, "Japanese");
  assert.equal(variant.qrIdentity!.value, partial.identity);
  const creation = f.calls.find(call => call.name === "QrLinkCreate")!.variables.product as { tags: string[] };
  assert.ok(creation.tags.includes("Japanese"));
  assert.ok(!creation.tags.includes("English"));
  assert.equal((await linkSkuLabelToShopify({ ...japaneseCard, quantity: 0 }, f.deps)).status, "ready");
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
  assert.equal(f.product().variants.nodes.length, 1);
  assert.equal(f.quantityAdded(), 1);
  const stockCalls = f.calls.filter(call => call.name === "QrLinkInitialStock");
  assert.equal(stockCalls.length, 2);
  assert.equal(stockCalls[0].variables.key, `${before.stockRequestKey}-receive`);
  assert.deepEqual(stockCalls[0].variables, stockCalls[1].variables);
  assert.equal((await readSkuLabelStockTarget(japaneseCard, f.deps)).identity, partial.identity);
  assert.equal((await getSkuLabelShopifyStatuses([japaneseCard], f.deps))[0].status, "ready");

  const count = f.calls.length;
  variant.selectedOptions.find(option => option.name === "Language")!.value = "English";
  assert.equal((await getSkuLabelShopifyStatuses([japaneseCard], f.deps))[0].status, "blocked");
  await assert.rejects(readSkuLabelStockTarget(japaneseCard, f.deps), /identity changed/);
  assert.ok(f.calls.slice(count).every(call => ["QrLinkStatusConnection", "QrLinkStatuses", "QrLinkLiveStatuses", "SinglesRecord", "QrStockTarget"].includes(call.name)));
});
test("a precreation Japanese correction fills a missing stock key from the original English identity", async () => {
  const f = await blockedJapaneseFixture();
  const key = qrJournalKey(japaneseCard.sku), stored = f.journals.get(key)!;
  const record = JSON.parse(stored.value);
  const originalKey = record.stockRequestKey;
  delete record.stockRequestKey;
  f.journals.set(key, { value: JSON.stringify(record), compareDigest: "legacy-no-stock-key" });
  assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "ready");
  assert.equal(JSON.parse(f.journals.get(key)!.value).stockRequestKey, originalKey);
  assert.equal(f.quantityAdded(), 1);
});
test("Japanese identity correction refuses any creation, mapping, stock, adoption, or completed-status evidence", async () => {
  const recordPatches: Record<string, unknown>[] = [
    { creationStartedAt: 0 }, { creationStartedAt: null }, { productId: "gid://shopify/Product/12" }, { variantId: "gid://shopify/ProductVariant/123" },
    { shopifySku: "" }, { publicationId: "gid://shopify/Publication/2" }, { stockInventoryItemId: "gid://shopify/InventoryItem/1" },
    { stockLocationId: "gid://shopify/Location/1" }, { adjustmentStartedAt: 0 }, { adjustmentId: "gid://shopify/InventoryAdjustmentGroup/1" },
    { previousIdentity: "previous" }, { adoptionPending: false }, { owner: "in-flight" }, { stockRequestKey: null },
  ];
  const statusPatches: Record<string, unknown>[] = [
    { status: "ready" }, { productId: "gid://shopify/Product/12" }, { variantId: "gid://shopify/ProductVariant/123" },
    { adminUrl: "https://example.com" }, { transferredQuantity: 0 }, { availableQuantity: 0 }, { priceCents: 0 }, { checkedAt: "2026-09-23" },
  ];
  for (const [recordPatch, statusPatch] of [...recordPatches.map(patch => [patch, {}]), ...statusPatches.map(patch => [{}, patch])]) {
    const f = await blockedJapaneseFixture();
    const key = qrJournalKey(japaneseCard.sku), current = f.journals.get(key)!;
    const record = JSON.parse(current.value);
    Object.assign(record, recordPatch); Object.assign(record.status, statusPatch);
    const changed = JSON.stringify(record);
    f.journals.set(key, { value: changed, compareDigest: "blocked-intent" });
    assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "blocked", JSON.stringify({ recordPatch, statusPatch }));
    assert.equal(f.journals.get(key)!.value, changed);
    assert.equal(f.product(), null); assert.equal(f.quantityAdded(), 0);
  }
  for (const patch of [{ tcgplayerId: 566514 }, { condition: "Lightly Played" }, { finish: "Normal" }, { initialQuantity: 2 }]) {
    const f = await blockedJapaneseFixture();
    assert.equal((await linkSkuLabelToShopify({ ...japaneseCard, ...patch }, f.deps)).status, "blocked");
    assert.equal(f.product(), null); assert.equal(f.quantityAdded(), 0);
  }
});
test("Japanese language correction requires the unchanged journal snapshot under both leases", async () => {
  for (const language of ["English", "Japanese"]) {
    const f = await blockedJapaneseFixture();
    const key = qrJournalKey(japaneseCard.sku), graphql = f.deps.graphql;
    let reads = 0;
    f.deps.graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      if (query.includes("query SinglesRecord(") && variables.key === key && ++reads === 2) {
        const record = JSON.parse(f.journals.get(key)!.value);
        const identity = JSON.parse(record.identity); identity[3] = language; record.identity = JSON.stringify(identity);
        record.status.message = "Changed by another request";
        f.journals.set(key, { value: JSON.stringify(record), compareDigest: "changed-before-language-cas" });
      }
      return graphql<T>(query, variables);
    };
    assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "blocked");
    assert.equal(f.product(), null); assert.equal(f.quantityAdded(), 0);
    assert.equal(JSON.parse(JSON.parse(f.journals.get(key)!.value).identity)[3], language);
    assert.equal(JSON.parse(f.journals.get(key)!.value).status.message, "Changed by another request");
  }
  const f = await blockedJapaneseFixture();
  const key = qrJournalKey(japaneseCard.sku), original = f.journals.get(key)!.value;
  const skuLease = `qr_lock_${digest(`sku:${japaneseCard.sku}`).slice(0, 55)}`, graphql = f.deps.graphql;
  let reads = 0;
  f.deps.graphql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    if (query.includes("query SinglesRecord(") && variables.key === skuLease && ++reads === 2) {
      const lock = JSON.parse(f.journals.get(skuLease)!.value); lock.owner = "another-worker";
      f.journals.set(skuLease, { value: JSON.stringify(lock), compareDigest: "changed-sku-lease" });
    }
    return graphql<T>(query, variables);
  };
  assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "pending");
  assert.equal(f.journals.get(key)!.value, original);
  assert.equal(f.product(), null); assert.equal(f.quantityAdded(), 0);
});
test("Japanese cards do not adopt an English-only Shopify listing or attach another language variant", async () => {
  const starting = existing({ sku: "ENGLISH-CARD", barcode: null, barcodes: { nodes: [], pageInfo: { hasNextPage: false } } });
  starting.catalogId = { value: "single:tcgplayer:printing:566513" }; starting.sourceId = { value: "566513" };
  const f = fixture({ starting });
  const result = await linkSkuLabelToShopify(japaneseCard, f.deps);
  assert.equal(result.status, "blocked"); assert.match(result.message, /does not identify a Japanese card/);
  assert.deepEqual(f.product(), starting);
  assert.equal(f.quantityAdded(), 0);
  assert.ok(!f.calls.some(call => ["QrLinkCreate", "QrLinkVariant", "QrLinkBarcode", "QrLinkInitialStock", "QrLinkStockActivate"].includes(call.name)));
});
test("English and Japanese Pokémon singles remove every non-POS catalog publication and keep the same card and stock on retry", async () => {
  for (const input of [{ ...japaneseCard, game: "Pokémon", name: "Nidoking", sku: "DEFY-3099353165", tcgplayerId: 517029, cardNumber: "174/165" }, japaneseCard]) {
    const starting = existing({ sku: "EXISTING-STORE-SKU" });
    starting.catalogId = { value: `single:tcgplayer:printing:${input.tcgplayerId}` }; starting.sourceId = { value: String(input.tcgplayerId) };
    starting.variants.nodes[0].selectedOptions[2].value = input.game === "Pokémon" ? "English" : "Japanese";
    const channels = (["app", "market", "company", "none"] as const).map((type, index) => ({ id: `gid://shopify/Publication/${index + 10}`, type }));
    const f = fixture({ starting, channels: [...channels, { id: "gid://shopify/Publication/2", type: "app" }] });
    const result = await linkSkuLabelToShopify(input, f.deps);
    assert.equal(result.status, "ready");
    assert.equal(result.productId, starting.id); assert.equal(result.variantId, starting.variants.nodes[0].id);
    assert.equal(f.product().variants.nodes[0].sku, "EXISTING-STORE-SKU");
    assert.equal(f.product().pos, true); assert.equal(f.product().variants.nodes[0].pos, true);
    assert.equal(f.product().variants.nodes[0].price, "48.02");
    assert.equal(f.quantityAdded(), 1);
    const mutations = f.calls.filter(call => call.name === "QrLinkInStoreOnly");
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].variables.input, channels.map(channel => ({ publicationId: channel.id })));
    assert.deepEqual([...f.channels.keys()], ["gid://shopify/Publication/2"]);
    assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
    assert.equal((await readSkuLabelStockTarget(input, f.deps)).availableQuantity, 8);
    assert.equal(f.calls.filter(call => call.name === "QrLinkInStoreOnly").length, 1);
    assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 0);
    assert.equal(f.quantityAdded(), 1);
  }
});
test("Pokémon policy failures or incomplete publication enumeration never report ready or transfer starting stock", async () => {
  for (const extra of [{ unpublishFailure: "error" as const }, { unpublishFailure: "unconfirmed" as const }, { incompleteChannels: "market" as const }, { changedPolicyIdentity: true }]) {
    const f = fixture({ ...extra, channels: [{ id: "gid://shopify/Publication/3", type: "app" }] });
    const result = await linkSkuLabelToShopify(japaneseCard, f.deps);
    assert.notEqual(result.status, "ready");
    assert.equal(f.quantityAdded(), 0);
    assert.ok(f.channels.has("gid://shopify/Publication/3"));
    assert.ok(!f.calls.some(call => ["QrLinkInitialStock", "QrLinkPublish", "QrLinkPublishVariant"].includes(call.name)));
    if ("incompleteChannels" in extra || "changedPolicyIdentity" in extra) assert.ok(!f.calls.some(call => call.name === "QrLinkInStoreOnly"));
    assert.notEqual((await getSkuLabelShopifyStatuses([japaneseCard], f.deps))[0].status, "ready");
  }
});
test("a lost Pokémon unpublish response reconciles the same product before receiving stock once", async () => {
  const f = fixture({ unpublishFailure: "response-loss", channels: [{ id: "gid://shopify/Publication/3", type: "app" }] });
  assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "pending");
  assert.equal(f.quantityAdded(), 0); assert.equal(f.channels.size, 0);
  assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "ready");
  assert.equal(f.quantityAdded(), 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkInStoreOnly").length, 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
});
test("read-only readiness detects Pokémon republished or scheduled outside POS and requires an explicit relink", async () => {
  const f = fixture(); assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "ready");
  f.channels.set("gid://shopify/Publication/3", "market");
  const count = f.calls.length;
  const status = (await getSkuLabelShopifyStatuses([japaneseCard], f.deps))[0];
  assert.equal(status.status, "blocked"); assert.match(status.message, /outside POS/); assert.equal(status.availableQuantity, undefined);
  await assert.rejects(readSkuLabelStockTarget(japaneseCard, f.deps), /outside POS/);
  assert.ok(f.channels.has("gid://shopify/Publication/3"));
  assert.ok(!f.calls.slice(count).some(call => ["QrLinkInStoreOnly", "QrLinkInitialStock", "QrLinkPublish"].includes(call.name)));
  assert.equal((await linkSkuLabelToShopify(japaneseCard, f.deps)).status, "ready");
  assert.equal(f.channels.size, 0); assert.equal(f.quantityAdded(), 1);
});
test("non-Pokémon QR links preserve their other publications and never invoke the Pokémon policy", async () => {
  for (const game of ["MTG", "Riftbound"]) {
    const f = fixture({ channels: [{ id: "gid://shopify/Publication/3", type: "app" }] });
    const input = { ...card, game };
    assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
    assert.equal((await getSkuLabelShopifyStatuses([input], f.deps))[0].status, "ready");
    assert.ok(f.channels.has("gid://shopify/Publication/3"));
    assert.ok(!f.calls.some(call => ["QrLinkChannelPolicy", "QrLinkInStoreOnly"].includes(call.name)));
  }
});
test("Riftbound QR links publish the exact product and variant to the website without adding other channels", async () => {
  const inputs = [
    { ...card, game: "Riftbound", initialQuantity: 2 },
    { ...card, game: "Riftbound TCG", tcgplayerId: null, listPriceCents: 5000, initialQuantity: 2 },
    { ...card, game: "riftbound league of legends trading card game", finish: "Etched Foil", initialQuantity: 2 },
  ];
  for (const input of inputs) {
    const f = fixture();
    const result = await linkSkuLabelToShopify(input, f.deps);
    assert.equal(result.status, "ready"); assert.match(result.message, /Defy website/);
    assert.equal(result.priceCents, input.tcgplayerId ? 5090 : 5000);
    assert.equal(f.website.product, true); assert.deepEqual([...f.website.variants], [result.variantId]);
    assert.deepEqual(f.calls.filter(call => call.name === "QrLinkWebsitePublish" || call.name === "QrLinkWebsitePublishVariant").map(call => call.variables.id), [result.productId, result.variantId]);
    assert.equal(f.quantityAdded(), 2);
    const before = f.calls.length;
    assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
    assert.equal((await readSkuLabelStockTarget(input, f.deps)).availableQuantity, 2);
    assert.equal(f.quantityAdded(), 2);
    assert.ok(!f.calls.slice(before).some(call => ["QrLinkWebsitePublish", "QrLinkWebsitePublishVariant", "QrLinkInitialStock", "QrLinkCreate"].includes(call.name)));
  }
});
test("POS-ready Riftbound links with a missing website product or excluded variant become pending and repair without receiving stock again", async () => {
  for (const missing of ["product", "variant"] as const) {
    const f = fixture(), input = { ...card, game: "Riftbound", initialQuantity: 3 };
    const first = await linkSkuLabelToShopify(input, f.deps);
    assert.equal(first.status, "ready");
    if (missing === "product") f.website.product = false; else f.website.variants.clear();
    const before = f.calls.length;
    const [status] = await getSkuLabelShopifyStatuses([input], f.deps);
    assert.equal(status.status, "pending"); assert.match(status.message, /not available on the Defy website/);
    await assert.rejects(readSkuLabelStockTarget(input, f.deps), /not available on the Defy website/);
    assert.ok(!f.calls.slice(before).some(call => ["QrLinkWebsitePublish", "QrLinkWebsitePublishVariant", "QrLinkInitialStock"].includes(call.name)), "Status and stock checks stay read-only");
    const repaired = await linkSkuLabelToShopify(input, f.deps);
    assert.equal(repaired.status, "ready"); assert.equal(repaired.variantId, first.variantId);
    assert.equal(f.quantityAdded(), 3); assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
  }
});
test("Riftbound website channel must be unique and complete before any card or stock mutation", async () => {
  for (const websiteChannel of ["missing", "ambiguous", "incomplete", "same-as-pos"] as const) {
    const f = fixture({ websiteChannel });
    const result = await linkSkuLabelToShopify({ ...card, game: "Riftbound", initialQuantity: 2 }, f.deps);
    assert.equal(result.status, "blocked");
    assert.equal(f.product(), null); assert.equal(f.quantityAdded(), 0);
    assert.ok(!f.calls.some(call => ["SinglesRecordCAS", "QrLinkCreate", "QrLinkInitialStock", "QrLinkWebsitePublish"].includes(call.name)));
  }
});
test("legacy Headless ID is accepted only for the verified Defy store", async () => {
  const input = { ...card, game: "Riftbound" };
  const unverified = fixture({ websiteChannel: "legacy" });
  assert.equal((await linkSkuLabelToShopify(input, unverified.deps)).status, "blocked");
  const verified = fixture({ websiteChannel: "legacy" });
  verified.deps.settings.shop = "n4a7aa-fi.myshopify.com";
  assert.equal((await linkSkuLabelToShopify(input, verified.deps)).status, "ready");
});
test("failed website publication never reports ready and a lost response retains the same stock receipt", async () => {
  const input = { ...card, game: "Riftbound", initialQuantity: 2 };
  for (const websiteFailure of ["error", "unconfirmed"] as const) {
    const f = fixture({ websiteFailure });
    assert.notEqual((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
    assert.notEqual((await getSkuLabelShopifyStatuses([input], f.deps))[0].status, "ready");
    assert.equal(f.quantityAdded(), 2);
  }
  const f = fixture({ websiteFailure: "response-loss" });
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "pending");
  const original = f.product().variants.nodes[0];
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
  assert.equal(f.product().variants.nodes[0].id, original.id); assert.equal(f.quantityAdded(), 2);
  assert.equal(f.calls.filter(call => call.name === "QrLinkInitialStock").length, 1);
});
test("changed exact card identity blocks website publication", async () => {
  const f = fixture({ changedWebsiteIdentity: true });
  const result = await linkSkuLabelToShopify({ ...card, game: "Riftbound" }, f.deps);
  assert.equal(result.status, "blocked"); assert.match(result.message, /identity changed/);
  assert.ok(!f.calls.some(call => call.name.startsWith("QrLinkWebsitePublish")));
});
test("Pokémon and other games never acquire a website publication through QR linking", async () => {
  for (const input of [japaneseCard, { ...card, game: "Pokémon" }, card]) {
    const f = fixture({ websiteChannel: "missing" });
    assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
    assert.equal(f.website.product, false); assert.equal(f.website.variants.size, 0);
    assert.ok(!f.calls.some(call => call.name.startsWith("QrLinkWebsite")));
  }
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
test("Kha'Zix Overnumbered recovers its saved QR with the correct price, website link, and one starting copy", async () => {
  const input: SkuLabelShopifyProduct = {
    ...card, id: 97, sku: "DEFY-9588198806", name: "Kha'Zix, Voidreaver (Overnumbered)", game: "Riftbound",
    setName: "Unleashed", cardNumber: "236/219", tcgplayerId: 684507, quantity: 1, initialQuantity: 1,
  };
  const f = fixture({ priceError: true, failAfterStock: true });
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "blocked");
  assert.equal(f.product(), null);
  // The live provider splits the Legend's character and name; its Signature
  // sibling has a different collector number and marketplace identity.
  const printing = {
    id: "UNL-236", name: "Voidreaver", type: "Legend", subtypes: ["Kha'Zix"], rarity: "Showcase",
    number: "236", printed_number: "236/219", language_code: "EN",
    expansion: { id: "UNL", name: "Unleashed", code: "UNL", printed_total: 219, language_code: "EN" },
    variants: [{ name: "foil", marketplaces: [{ name: "tcgplayer", product_id: "684507" }],
      prices: [{ type: "raw", condition: "NM", currency: "USD", market: 112.45 }] }],
  };
  const signature = { ...printing, id: "UNL-236s", number: "236*", printed_number: "236*/219",
    variants: [{ name: "foil", marketplaces: [{ name: "tcgplayer", product_id: "684210" }],
      prices: [{ type: "raw", condition: "NM", currency: "USD", market: 395.47 }] }] };
  f.deps.resolvePrice = async product => selectScrydexPrice(product, [printing, signature]);
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "pending", "A lost stock response stays retryable");
  assert.equal(f.quantityAdded(), 1);
  const result = await linkSkuLabelToShopify(input, f.deps);
  assert.equal(result.status, "ready");
  assert.equal(result.priceCents, 11920, "The exact market quote receives the existing 6% Riftbound markup");
  assert.equal(result.transferredQuantity, 1);
  assert.equal((await linkSkuLabelToShopify(input, f.deps)).status, "ready");
  const variants = f.product().variants.nodes;
  assert.equal(variants.length, 1);
  assert.equal(variants[0].sku, "DEFY-RFB-684507-FOIL-EN-NM");
  assert.equal(variants[0].barcode, input.sku);
  assert.equal(variants[0].price, "119.20");
  assert.equal(variants[0].pos, true);
  assert.equal(f.website.product, true);
  assert.ok(f.website.variants.has(variants[0].id));
  assert.equal(f.quantityAdded(), 1);
  assert.equal(f.calls.filter(call => call.name === "QrLinkCreate").length, 1);
  const stockCalls = f.calls.filter(call => call.name === "QrLinkInitialStock");
  assert.equal(stockCalls.length, 2);
  assert.deepEqual(stockCalls[0].variables, stockCalls[1].variables);
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
