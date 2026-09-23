// Server-only Shopify registration of the permanent QR identity saved in Defy.
import { randomUUID } from "node:crypto";
import { canonicalInventoryLabelFinish, inventoryLabelIdentityText } from "./sku-label-inventory.ts";
import { cardLanguageForGame, gameFromAlias } from "./tcg-games.ts";
import { scrydexSellPriceCents } from "./pricing-policy.ts";
import { resolveScrydexPrice, ScrydexError, type ScrydexErrorCode, type ScrydexPrice, type ScrydexProduct } from "./scrydex.ts";
import { digest, SinglesError, type PlannedSingle } from "./singles/intake.ts";
import { createShopifyGraphQL, LEGACY_DEFY_MAPPING, ShopifySinglesAdapter, type SinglesGraphQL } from "./singles/shopify.ts";
import { canonicalSinglesCondition } from "./singles/types.ts";
import { isGeneratedSku } from "./sku-labels.ts";

export interface SkuLabelShopifyProduct {
  id: string | number; sku: string; name: string; game: string; setName: string; cardNumber: string;
  condition: string; finish: string; tcgplayerId?: number | null; tcgplayerUrl?: string | null;
  costCents: number; listPriceCents: number; quantity: number; initialQuantity: number;
}
export interface SkuLabelShopifyStatus {
  sku: string; status: "ready" | "pending" | "blocked"; message: string;
  productId?: string; variantId?: string; adminUrl?: string; priceCents?: number; checkedAt?: string; transferredQuantity?: number; availableQuantity?: number;
}
export interface SkuLabelShopifyDependencies {
  graphql: SinglesGraphQL;
  settings: { shop: string; locationId: string };
  clock: () => number;
  resolvePrice?: (product: ScrydexProduct) => Promise<ScrydexPrice>;
}
export interface SkuLabelStockTarget {
  identity: string; productId: string; variantId: string; inventoryItemId: string;
  locationId: string; shopifySku: string; publicationId: string; availableQuantity: number;
}
interface Field { value: string; namespace?: string; compareDigest?: string }
interface Variant {
  id: string; sku: string | null; barcode: string | null; price: string; inventoryQuantity: number;
  inventoryPolicy: string; inventoryItem: { id: string; tracked: boolean };
  selectedOptions: { name: string; value: string }[]; pos: boolean;
  qrIdentity: Field | null;
  barcodes: { nodes: { value: string; type: string | null }[]; pageInfo: { hasNextPage: boolean } };
}
interface Product {
  id: string; status: string; pos: boolean; catalogId: Field | null; sourceId: Field | null; manualOrigin?: Field | null;
  options: { name: string }[]; variants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}
interface Journal {
  version: 1; identity: string; sku: string; owner: string | null; expiresAt: number;
  productId?: string; variantId?: string; shopifySku?: string; status?: SkuLabelShopifyStatus;
  initialQuantity?: number; adjustmentStartedAt?: number; adjustmentId?: string; publicationId?: string;
  previousIdentity?: string; adoptionPending?: boolean; creationStartedAt?: number; stockRequestKey?: string; stockInventoryItemId?: string; stockLocationId?: string;
}
interface Payload { userErrors?: { code?: string; message: string }[] }
const NAMESPACE = "$app:singles";
const RECEIVING = "$app:receiving";
const LEASE_MS = 120_000;
const V_FIELDS = `id sku barcode barcodes(first: 20) { nodes { value type } pageInfo { hasNextPage } } price inventoryQuantity inventoryPolicy inventoryItem { id tracked }
  selectedOptions { name value } pos: publishedOnPublication(publicationId: $pos)
  qrIdentity: metafield(namespace: "${NAMESPACE}", key: "qr_identity") { value }`;
const P_FIELDS = `id status pos: publishedOnPublication(publicationId: $pos)
  catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value }
  sourceId: metafield(namespace: "defy_intake", key: "catalog_id") { value } manualOrigin: metafield(namespace: "${NAMESPACE}", key: "manual_origin") { value } options { name }
  variants(first: 100) { nodes { ${V_FIELDS} } pageInfo { hasNextPage endCursor } }`;
const textKey = inventoryLabelIdentityText;
const conditions: Record<string, string> = { "Near Mint": "NM", "Lightly Played": "LP", "Moderately Played": "MP", "Heavily Played": "HP", Damaged: "DMG" };
const fail = (message: string) => { throw new SinglesError("QR_LINK_BLOCKED", message); };
const pending = (message: string) => { throw new SinglesError("QR_LINK_PENDING", message, true); };
const journalKey = (sku: string) => `qr_${digest(sku).slice(0, 60)}`;
const lockKey = (printing: string) => `qr_lock_${digest(printing).slice(0, 55)}`;
const money = (cents: number) => (cents / 100).toFixed(2);
const inStoreOnly = (product: SkuLabelShopifyProduct) => ["pokemon", "pokemon-japanese"].includes(gameFromAlias(product.game)?.key ?? "");
const onWebsite = (product: SkuLabelShopifyProduct) => gameFromAlias(product.game)?.key === "riftbound";
type Publications = { nodes: { id: string; name: string; catalog: { title: string } | null }[]; pageInfo: { hasNextPage: boolean } };
function priceCents(value: string) { return /^\d+(?:\.\d{1,2})?$/.test(value) ? Math.round(Number(value) * 100) : 0; }
function check(payload: Payload | null | undefined) {
  if (!payload) pending("Shopify has not confirmed the link. Retry this saved QR code.");
  if (payload?.userErrors?.length) fail("Shopify rejected the card update. Review the linked Shopify product and retry this saved QR code.");
}
function identityFor(product: SkuLabelShopifyProduct) {
  const condition = canonicalSinglesCondition(product.condition);
  const finish = canonicalInventoryLabelFinish(product.finish);
  if (!isGeneratedSku(product.sku) || !product.id || !condition || !finish || !product.name.trim() || !product.game.trim() || !product.setName.trim() || !product.cardNumber.trim()) {
    fail("Complete the saved card's name, game, set, collector number, condition, and finish before linking Shopify POS.");
  }
  const source = Number.isSafeInteger(product.tcgplayerId) && Number(product.tcgplayerId) > 0 ? Number(product.tcgplayerId) : null;
  const riftbound = gameFromAlias(product.game)?.key === "riftbound" && source !== null && ["Normal", "Foil"].includes(finish);
  const printing = riftbound ? `single:riftbound:printing:${source}` : source ? `single:tcgplayer:printing:${source}` :
    `single:manual:printing:${digest(JSON.stringify([product.game, product.name, product.setName, product.cardNumber].map(textKey)))}`;
  const language = cardLanguageForGame(product.game);
  const identity = JSON.stringify([printing, condition, textKey(finish), language]);
  const sku = riftbound ? `DEFY-RFB-${source}-${finish.toUpperCase()}-EN-${conditions[condition!]}` : product.sku;
  return { printing, identity, source, riftbound, condition: condition!, finish, language, sku };
}
function optionsFor(identity: ReturnType<typeof identityFor>) {
  return [{ name: "Condition", value: identity.condition }, { name: "Finish", value: identity.finish === "Normal" ? "Nonfoil" : identity.finish }, { name: "Language", value: identity.language }];
}
function languageMatches(value: string, language: ReturnType<typeof cardLanguageForGame>) {
  return (language === "Japanese" ? ["ja", "japanese"] : ["en", "english"]).includes(textKey(value));
}
function exactOptions(variant: Variant, identity: ReturnType<typeof identityFor>) {
  return variant.selectedOptions.length === 3 && optionsFor(identity).every(expected => variant.selectedOptions.some(actual => {
    if (actual.name !== expected.name) return false;
    if (actual.name === "Condition") return canonicalSinglesCondition(actual.value) === identity.condition;
    if (actual.name === "Finish") return textKey(canonicalInventoryLabelFinish(actual.value)) === textKey(identity.finish);
    return languageMatches(actual.value, identity.language);
  }));
}
function canCorrectPrecreationLanguage(record: Journal | null, product: SkuLabelShopifyProduct, identity: ReturnType<typeof identityFor>) {
  if (!record || identity.language !== "Japanese" || !identity.source || record.version !== 1 || record.sku !== product.sku ||
    record.identity !== JSON.stringify([identity.printing, identity.condition, textKey(identity.finish), "English"]) ||
    record.initialQuantity !== product.initialQuantity || record.owner !== null || record.expiresAt !== 0 ||
    record.status?.status !== "blocked" || record.status.sku !== product.sku ||
    (record.stockRequestKey !== undefined && (typeof record.stockRequestKey !== "string" || !record.stockRequestKey.trim()))) return false;
  // Absence of every intent marker is required; even an unconfirmed create cannot be relabeled.
  const untouched = [record.productId, record.variantId, record.shopifySku, record.publicationId,
    record.creationStartedAt, record.stockInventoryItemId, record.stockLocationId, record.adjustmentStartedAt,
    record.adjustmentId, record.previousIdentity, record.adoptionPending];
  const status = record.status;
  return untouched.every(value => value === undefined) && [status.productId, status.variantId, status.adminUrl,
    status.priceCents, status.checkedAt, status.transferredQuantity, status.availableQuantity].every(value => value === undefined);
}
function matchesProductIdentity(product: { catalogId: Field | null; sourceId: Field | null; manualOrigin?: Field | null }, identity: ReturnType<typeof identityFor>) {
  const oldIdentity = identity.riftbound ? `single:riftbound:${identity.source}:${encodeURIComponent(identity.finish)}:English:${conditions[identity.condition]}` : "";
  if (product.catalogId?.value && ![identity.printing, oldIdentity].includes(product.catalogId.value) && !(identity.source === null && product.manualOrigin?.value === identity.printing)) return false;
  if (identity.source && product.sourceId?.value && product.sourceId.value !== String(identity.source)) return false;
  return true;
}
function matchesSavedVariant(variant: Pick<Variant, "id" | "sku" | "selectedOptions" | "inventoryItem" | "inventoryPolicy">, product: { id: string; catalogId: Field | null; sourceId: Field | null; manualOrigin?: Field | null; variants: { nodes: unknown[]; pageInfo: { hasNextPage: boolean } } }, identity: ReturnType<typeof identityFor>, shop: string) {
  if (!matchesProductIdentity(product, identity) || !variant.inventoryItem.tracked || variant.inventoryPolicy !== "DENY") return false;
  if (exactOptions(variant as Variant, identity)) return true;
  const oldIdentity = `single:riftbound:${identity.source}:${encodeURIComponent(identity.finish)}:English:${conditions[identity.condition]}`;
  const oldSku = `DEFY-RFB-S${identity.source}-${digest(identity.finish).slice(0, 12).toUpperCase()}-EN-${conditions[identity.condition]}`;
  if (identity.riftbound && variant.sku === oldSku && product.catalogId?.value === oldIdentity && product.variants.nodes.length === 1 && !product.variants.pageInfo.hasNextPage) return true;
  return identity.riftbound && shop === LEGACY_DEFY_MAPPING.shop && identity.source === LEGACY_DEFY_MAPPING.sourceProductId && identity.condition === "Near Mint" && identity.finish === "Normal" &&
    product.id === LEGACY_DEFY_MAPPING.productId && variant.id === LEGACY_DEFY_MAPPING.variantId && variant.inventoryItem.id === LEGACY_DEFY_MAPPING.inventoryItemId;
}
function rowFor(product: SkuLabelShopifyProduct, identity: ReturnType<typeof identityFor>, cents: number): PlannedSingle {
  return { cardKey: identity.identity, condition: identity.condition, quantity: 0, costCents: 0, priceCents: cents, sku: identity.sku,
    catalogId: `single:riftbound:${identity.source}:${encodeURIComponent(identity.finish)}:English:${conditions[identity.condition]}`,
    card: { key: identity.identity, productId: identity.source!, groupId: 0, name: product.name, setName: product.setName,
      setCode: "", number: product.cardNumber, rarity: "", finish: identity.finish, language: "English",
      imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${identity.source}_in_1000x1000.jpg`, productUrl: product.tcgplayerUrl || "", marketCents: null } };
}
const pricingFailureMessages: Record<ScrydexErrorCode, string> = {
  not_configured: "Scrydex pricing is not configured. Ask an administrator to check the pricing connection, then retry this QR.",
  unsupported: "Scrydex automatic pricing does not support this card's game, language, product type, or condition. Review its saved details.",
  incomplete_identity: "The saved card needs its exact name, set, collector number, and finish before Scrydex can verify its price. Review its saved details.",
  not_found: "Defy could not match this card's name, set, and collector number to Scrydex. Its catalog mapping needs review before Shopify can link it.",
  ambiguous: "Scrydex returned multiple possible matches. The exact printing, finish, and condition need review before Shopify can link it.",
  price_unavailable: "Scrydex has no verified positive USD market price for this exact finish and condition. Retry after its pricing is available.",
  upstream_error: "Scrydex could not complete the price request. Retry this saved QR shortly; Shopify linking is still pending.",
};
function safeFailure(sku: string, error: unknown): SkuLabelShopifyStatus {
  if (error instanceof ScrydexError) {
    // Log only the known error code and saved SKU, never provider errors or credentials.
    console.warn("[sku-label-shopify] Scrydex pricing blocked linking", { sku, code: error.code });
    return { sku, status: error.code === "upstream_error" ? "pending" : "blocked", message: `The QR is saved. ${pricingFailureMessages[error.code]}` };
  }
  if (error instanceof SinglesError && ["QR_LINK_BLOCKED", "QR_LINK_PENDING", "PRODUCT_IDENTITY_CONFLICT"].includes(error.code)) return { sku, status: error.retryable ? "pending" : "blocked", message: error.message };
  if (error instanceof SinglesError && !error.retryable) return { sku, status: "blocked", message: "The QR is saved, but Shopify could not verify its connection or card mapping. Review the Shopify connection and retry the saved QR." };
  return { sku, status: "pending", message: "The QR is saved. Shopify has not confirmed POS readiness yet; retry this same QR code." };
}

async function websitePublication(deps: SkuLabelShopifyDependencies, known?: Publications): Promise<string> {
  const publications = known ?? (await deps.graphql<{ publications: Publications }>(`query QrLinkPublications { publications(first: 250, catalogType: APP) { nodes { id name catalog { title } } pageInfo { hasNextPage } } }`)).publications;
  const matches = publications.nodes.filter(item => item.name === "Defy TCG website" || item.catalog?.title === "Defy TCG website" ||
    (deps.settings.shop === LEGACY_DEFY_MAPPING.shop && item.id === "gid://shopify/Publication/202600611926"));
  const pos = publications.nodes.filter(item => item.name === "Point of Sale" || item.catalog?.title === "Point of Sale");
  if (publications.pageInfo.hasNextPage || matches.length !== 1 || pos.length !== 1 || matches[0].id === pos[0].id || !/^gid:\/\/shopify\/Publication\/\d+$/.test(matches[0].id)) {
    fail("The Defy website sales channel could not be identified uniquely. Review its Headless channel connection before linking this Riftbound card.");
  }
  return matches[0].id;
}

/** A channel repair must prove the same saved card and exact variant before publishing it. */
async function websiteAvailable(product: SkuLabelShopifyProduct, record: Pick<Journal, "productId" | "variantId" | "shopifySku" | "publicationId">, deps: SkuLabelShopifyDependencies, website: string): Promise<boolean> {
  const identity = identityFor(product);
  type WebsiteProduct = Pick<Product, "id" | "catalogId" | "sourceId" | "manualOrigin" | "variants"> & { website: boolean };
  const data = await deps.graphql<{ product: WebsiteProduct | null; variant: (Variant & { website: boolean; product: { id: string } }) | null }>(`query QrLinkWebsiteAvailability($id: ID!, $variant: ID!, $pos: ID!, $website: ID!) {
    product(id: $id) { id website: publishedOnPublication(publicationId: $website)
      catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value } sourceId: metafield(namespace: "defy_intake", key: "catalog_id") { value }
      manualOrigin: metafield(namespace: "${NAMESPACE}", key: "manual_origin") { value } variants(first: 2) { nodes { id } pageInfo { hasNextPage } } }
    variant: productVariant(id: $variant) { ${V_FIELDS} website: publishedOnPublication(publicationId: $website) product { id } }
  }`, { id: record.productId, variant: record.variantId, pos: record.publicationId, website });
  const target = data.product, variant = data.variant;
  if (!target || target.id !== record.productId || !variant || variant.id !== record.variantId || variant.product.id !== target.id ||
    variant.sku !== record.shopifySku || variant.qrIdentity?.value !== identity.identity || !matchesSavedVariant(variant, target, identity, deps.settings.shop) ||
    variant.barcodes.pageInfo.hasNextPage || !variant.barcodes.nodes.some(code => code.value === product.sku)) {
    fail("The Shopify card identity changed before its website availability could be verified. Review its saved QR link.");
  }
  return target!.website === true && variant!.website === true;
}

/** Include scheduled publications and every catalog type; APP alone omits other checkout catalogs. */
async function nonPosPublications(product: SkuLabelShopifyProduct, record: Pick<Journal, "productId" | "variantId" | "shopifySku" | "publicationId">, deps: SkuLabelShopifyDependencies): Promise<string[]> {
  const identity = identityFor(product);
  type Connection = { nodes: { publication: { id: string } }[]; pageInfo: { hasNextPage: boolean } };
  type Channels = Pick<Product, "id" | "catalogId" | "sourceId" | "manualOrigin" | "variants"> & { app: Connection; market: Connection; company: Connection; none: Connection };
  const fields = [["app", "APP"], ["market", "MARKET"], ["company", "COMPANY_LOCATION"], ["none", "NONE"]]
    .map(([alias, type]) => `${alias}: resourcePublicationsV2(first: 100, onlyPublished: false, catalogType: ${type}) { nodes { publication { id } } pageInfo { hasNextPage } }`).join("\n");
  const data = await deps.graphql<{ product: Channels | null; variant: (Variant & { product: { id: string } }) | null }>(`query QrLinkChannelPolicy($id: ID!, $variant: ID!, $pos: ID!) {
    product(id: $id) { id catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value }
      sourceId: metafield(namespace: "defy_intake", key: "catalog_id") { value } manualOrigin: metafield(namespace: "${NAMESPACE}", key: "manual_origin") { value }
      variants(first: 2) { nodes { id } pageInfo { hasNextPage } } ${fields} }
    variant: productVariant(id: $variant) { ${V_FIELDS} product { id } }
  }`, { id: record.productId, variant: record.variantId, pos: record.publicationId });
  const target = data.product, variant = data.variant;
  if (!target || target.id !== record.productId || !variant || variant.id !== record.variantId || variant.product.id !== target.id ||
    variant.sku !== record.shopifySku || variant.qrIdentity?.value !== identity.identity || !matchesSavedVariant(variant, target, identity, deps.settings.shop) ||
    variant.barcodes.pageInfo.hasNextPage || !variant.barcodes.nodes.some(code => code.value === product.sku)) {
    fail("The Shopify card identity changed before its in-store-only sales policy could be verified. Review its saved QR link.");
  }
  const ids = new Set<string>();
  for (const connection of [target!.app, target!.market, target!.company, target!.none]) {
    if (!connection || !Array.isArray(connection.nodes) || connection.nodes.length > 100 || connection.pageInfo?.hasNextPage !== false) {
      fail("Shopify could not return every publication for this Pokémon single. Its in-store-only sales policy needs review before it is ready.");
    }
    for (const node of connection.nodes) {
      if (!/^gid:\/\/shopify\/Publication\/\d+$/.test(node?.publication?.id)) fail("Shopify returned an invalid publication for this Pokémon single. Review its in-store-only sales policy.");
      if (node.publication.id !== record.publicationId) ids.add(node.publication.id);
    }
  }
  return [...ids];
}

/** Read-only proof for a separate stock receipt; never repairs or reprices a saved link. */
export async function readSkuLabelStockTarget(product: SkuLabelShopifyProduct, deps: SkuLabelShopifyDependencies): Promise<SkuLabelStockTarget> {
  const identity = identityFor(product);
  const adapter = new ShopifySinglesAdapter(deps.graphql, deps.settings, deps.clock);
  const { value: record } = await adapter.read<Journal>(journalKey(product.sku));
  if (record?.version !== 1 || record.sku !== product.sku || record.identity !== identity.identity || record.initialQuantity !== product.initialQuantity || record.status?.status !== "ready" || record.status.sku !== product.sku || !record.productId || !record.variantId || !record.publicationId || record.shopifySku === undefined || (record.initialQuantity !== 0 && !record.adjustmentId) || record.adoptionPending) {
    fail("Finish linking this saved QR to Shopify POS before adding stock.");
  }
  const saved = record!;
  if (saved.owner && saved.expiresAt > deps.clock()) pending("This QR link is being updated. Retry adding stock with the same request shortly.");
  const data = await deps.graphql<{ productVariant: (Variant & { product: Product; inventoryItem: Variant["inventoryItem"] & { inventoryLevel: { location: { id: string }; quantities: { name: string; quantity: number }[] } | null } }) | null }>(`query QrStockTarget($id: ID!, $pos: ID!, $location: ID!) {
    productVariant(id: $id) { ${V_FIELDS}
      product { id status pos: publishedOnPublication(publicationId: $pos) catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value } sourceId: metafield(namespace: "defy_intake", key: "catalog_id") { value } manualOrigin: metafield(namespace: "${NAMESPACE}", key: "manual_origin") { value } variants(first: 2) { nodes { id } pageInfo { hasNextPage } } }
      inventoryItem { id tracked inventoryLevel(locationId: $location) { location { id } quantities(names: ["available"]) { name quantity } } }
    }
  }`, { id: saved.variantId, pos: saved.publicationId, location: deps.settings.locationId });
  const variant = data.productVariant;
  if (!variant || variant.id !== saved.variantId || variant.product.id !== saved.productId || variant.qrIdentity?.value !== saved.identity || (variant.sku || "") !== saved.shopifySku || !matchesSavedVariant(variant, variant.product, identity, deps.settings.shop) || variant.barcodes.pageInfo.hasNextPage || !variant.barcodes.nodes.some(code => code.value === product.sku)) {
    fail("The saved Shopify card or QR identity changed. Review its link before adding stock.");
  }
  const verified = variant!;
  const level = verified.inventoryItem.inventoryLevel;
  const availableQuantity = level?.quantities.find(item => item.name === "available")?.quantity;
  if (verified.product.status !== "ACTIVE" || !verified.product.pos || !verified.pos || priceCents(verified.price) <= 0 || level?.location.id !== deps.settings.locationId || !Number.isSafeInteger(availableQuantity)) {
    fail("This card is not ready at the configured Shopify POS stock location. Review its saved link before adding stock.");
  }
  if (inStoreOnly(product) && (await nonPosPublications(product, saved, deps)).length) fail("This Pokémon single is available outside POS. Retry its saved link to restore in-store-only sales before adding stock.");
  if (onWebsite(product) && !await websiteAvailable(product, saved, deps, await websitePublication(deps))) fail("This Riftbound card is not available on the Defy website. Retry its saved link before adding stock.");
  // A QR moved or copied to another variant must never receive inventory silently.
  const duplicates = await deps.graphql<{ productVariants: { nodes: { id: string; barcodes: Variant["barcodes"] }[]; pageInfo: { hasNextPage: boolean } } }>(`query QrStockScanCode($query: String!) {
    productVariants(first: 10, query: $query) { nodes { id barcodes(first: 20) { nodes { value } pageInfo { hasNextPage } } } pageInfo { hasNextPage } }
  }`, { query: `barcode:"${product.sku}"` });
  const candidates = duplicates.productVariants;
  const exact = candidates.nodes.filter(item => item.barcodes.nodes.some(code => code.value === product.sku));
  if (candidates.pageInfo.hasNextPage || candidates.nodes.some(item => item.barcodes.pageInfo.hasNextPage) || exact.length !== 1 || exact[0].id !== saved.variantId) fail("This QR does not uniquely identify one Shopify card. Review its barcode mapping before adding stock.");
  return { identity: saved.identity, productId: saved.productId!, variantId: saved.variantId!, inventoryItemId: verified.inventoryItem.id,
    locationId: deps.settings.locationId, shopifySku: saved.shopifySku!, publicationId: saved.publicationId!, availableQuantity: availableQuantity! };
}

/** Read-only status: persisted progress plus live barcode, POS, price, and location stock verification. */
export async function getSkuLabelShopifyStatuses(products: readonly SkuLabelShopifyProduct[], dependencies?: SkuLabelShopifyDependencies): Promise<SkuLabelShopifyStatus[]> {
  if (!products.length) return [];
  try {
    const deps: SkuLabelShopifyDependencies = dependencies ?? await createShopifyGraphQL({ apiVersion: "2026-10" });
    const connection = await deps.graphql<{ currentAppInstallation: { accessScopes: { handle: string }[] } }>(`query QrLinkStatusConnection { currentAppInstallation { accessScopes { handle } } }`);
    const scopes = new Set(connection.currentAppInstallation.accessScopes.map(scope => scope.handle));
    const missing = ["write_products", "write_inventory", "write_publications"].filter(scope => !scopes.has(scope));
    if (missing.length) return products.map(product => ({ sku: product.sku, status: "blocked", message: `The QR is saved. Shopify POS linking needs these app permissions: ${missing.join(", ")}. The owner must approve the updated Shopify app permissions.` }));
    const results: SkuLabelShopifyStatus[] = [];
    let website: Promise<string> | undefined;
    for (let start = 0; start < products.length; start += 20) {
      const batch = products.slice(start, start + 20);
      const fields = batch.map((product, index) => `q${index}: metafield(namespace: "${NAMESPACE}", key: "${journalKey(product.sku)}") { value }`).join("\n");
      const response = await deps.graphql<{ shop: Record<string, Field | null> }>(`query QrLinkStatuses { shop { ${fields} } }`);
      const ready: { index: number; record: Journal; product: SkuLabelShopifyProduct }[] = [];
      batch.forEach((product, index) => {
        let stored: Journal | null = null;
        try { stored = JSON.parse(response.shop[`q${index}`]?.value || "null") as Journal | null; } catch { /* An invalid journal cannot confirm readiness. */ }
        try {
          const identity = identityFor(product).identity;
          const valid = stored?.version === 1 && stored.sku === product.sku && stored.identity === identity && stored.initialQuantity === product.initialQuantity && stored.status?.sku === product.sku;
          results.push(valid && stored?.status ? stored.status : { sku: product.sku, status: "pending", message: "Shopify POS has not confirmed this saved QR yet." });
          if (valid && stored && stored.status?.status === "ready") {
            if (stored.variantId && stored.productId && stored.publicationId && (stored.initialQuantity === 0 || stored.adjustmentId)) ready.push({ index: results.length - 1, record: stored, product });
            else results[results.length - 1] = { sku: product.sku, status: "pending", message: "Shopify POS needs to reverify this saved QR link." };
          }
        } catch (error) { results.push(safeFailure(product.sku, error)); }
      });
      if (ready.length) {
        const variables: Record<string, unknown> = { location: deps.settings.locationId };
        const declarations = ["$location: ID!"];
        const fields = ready.map(({ record }, index) => {
          variables[`variant${index}`] = record.variantId; variables[`pos${index}`] = record.publicationId;
          declarations.push(`$variant${index}: ID!`, `$pos${index}: ID!`);
          return `v${index}: productVariant(id: $variant${index}) { id sku price inventoryPolicy selectedOptions { name value } qrIdentity: metafield(namespace: "${NAMESPACE}", key: "qr_identity") { value } barcodes(first: 20) { nodes { value } pageInfo { hasNextPage } } pos: publishedOnPublication(publicationId: $pos${index}) product { id status catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value } sourceId: metafield(namespace: "defy_intake", key: "catalog_id") { value } manualOrigin: metafield(namespace: "${NAMESPACE}", key: "manual_origin") { value } variants(first: 2) { nodes { id } pageInfo { hasNextPage } } pos: publishedOnPublication(publicationId: $pos${index}) } inventoryItem { id tracked inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } }`;
        });
        type LiveVariant = { id: string; sku: string | null; price: string; inventoryPolicy: string; selectedOptions: Variant["selectedOptions"]; qrIdentity: Field | null; barcodes: { nodes: { value: string }[]; pageInfo: { hasNextPage: boolean } }; pos: boolean; product: { id: string; status: string; pos: boolean; catalogId: Field | null; sourceId: Field | null; manualOrigin?: Field | null; variants: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } } }; inventoryItem: { id: string; tracked: boolean; inventoryLevel: { quantities: { name: string; quantity: number }[] } | null } };
        const live = await deps.graphql<Record<string, LiveVariant | null>>(`query QrLinkLiveStatuses(${declarations.join(", ")}) { ${fields.join("\n")} }`, variables);
        for (const [offset, { index, record, product }] of ready.entries()) {
          const variant = live[`v${offset}`];
          const current = results[index];
          if (!variant || variant.id !== record.variantId || variant.product.id !== record.productId || variant.qrIdentity?.value !== record.identity || !matchesSavedVariant(variant, variant.product, identityFor(product), deps.settings.shop) || (variant.sku || "") !== record.shopifySku || variant.barcodes.pageInfo.hasNextPage || !variant.barcodes.nodes.some(code => code.value === record.sku)) {
            results[index] = { ...current, status: "blocked", message: "The saved Shopify variant or QR barcode changed. Review its existing link before printing or selling.", availableQuantity: undefined }; continue;
          }
          const available = variant.inventoryItem.inventoryLevel?.quantities.find(quantity => quantity.name === "available")?.quantity;
          if (variant.product.status !== "ACTIVE" || !variant.product.pos || !variant.pos || !Number.isSafeInteger(available) || priceCents(variant.price) <= 0) {
            results[index] = { ...current, status: "pending", message: "Shopify POS availability changed. Retry the saved link to verify its price and sales channel.", availableQuantity: undefined }; continue;
          }
          if (inStoreOnly(product)) {
            try {
              if ((await nonPosPublications(product, record, deps)).length) fail("This Pokémon single is available outside POS. Retry its saved link to restore in-store-only sales.");
            } catch (error) {
              results[index] = { ...current, ...safeFailure(product.sku, error), availableQuantity: undefined }; continue;
            }
          }
          if (onWebsite(product)) {
            try {
              website ??= websitePublication(deps);
              if (!await websiteAvailable(product, record, deps, await website)) pending("This Riftbound card is linked to POS but is not available on the Defy website. Retry its saved link to restore website availability.");
            } catch (error) {
              results[index] = { ...current, ...safeFailure(product.sku, error), availableQuantity: undefined }; continue;
            }
          }
          results[index] = { ...current, priceCents: priceCents(variant.price), availableQuantity: available, transferredQuantity: record.adjustmentId ? record.initialQuantity : 0, checkedAt: new Date(deps.clock()).toISOString() };
        }
      }
    }
    return results;
  } catch { return products.map(product => ({ sku: product.sku, status: "pending", message: "Shopify POS status is temporarily unavailable. The QR remains saved." })); }
}

/** Transfers only original starting stock; never changes unit cost. Retries retain both identities. */
export async function linkSkuLabelToShopify(product: SkuLabelShopifyProduct, dependencies?: SkuLabelShopifyDependencies): Promise<SkuLabelShopifyStatus> {
  let adapter: ShopifySinglesAdapter | undefined;
  let record: Journal | undefined;
  let leaseName = "";
  let skuLeaseName = "";
  let owner = "";
  let languageCorrectionPending = false;
  try {
    const identity = identityFor(product);
    const deps: SkuLabelShopifyDependencies = dependencies ?? await createShopifyGraphQL({ apiVersion: "2026-10" });
    const graphql = deps.graphql;
    adapter = new ShopifySinglesAdapter(graphql, deps.settings, deps.clock);
    const preflight = await graphql<{ shop: { id: string; currencyCode: string; receiving: Field | null }; location: { isActive: boolean } | null; currentAppInstallation: { accessScopes: { handle: string }[] } }>(`query QrLinkPreflight($locationId: ID!) {
      shop { id currencyCode receiving: metafield(namespace: "${RECEIVING}", key: "state") { value namespace } }
      currentAppInstallation { accessScopes { handle } }
      location(id: $locationId) { isActive }
    }`, { locationId: deps.settings.locationId });
    const scopes = new Set(preflight.currentAppInstallation.accessScopes.map(scope => scope.handle));
    for (const scope of ["write_products", "write_inventory", "write_publications"]) if (!scopes.has(scope)) fail(`The QR is saved. Shopify POS linking needs the ${scope} app permission. The owner must approve the updated Shopify app permissions.`);
    if (!scopes.has("read_publications") && !scopes.has("write_publications")) fail("Shopify POS linking needs read_publications permission.");
    if (!preflight.location?.isActive) fail("The configured Shopify POS stock location is missing or inactive.");
    if (preflight.shop.currencyCode !== "USD") fail("Shopify POS linking requires the store currency to be USD.");
    const receivingNamespace = preflight.shop.receiving?.namespace || "";
    if (!/^app--\d+--receiving$/.test(receivingNamespace)) fail("Initialize the Defy Shopify receiving connection before linking saved QR codes.");
    const publications = await graphql<{ publications: Publications }>(`query QrLinkPublications { publications(first: 250, catalogType: APP) { nodes { id name catalog { title } } pageInfo { hasNextPage } } }`);
    const matches = publications.publications.nodes.filter(publication => publication.name === "Point of Sale" || publication.catalog?.title === "Point of Sale");
    if (publications.publications.pageInfo.hasNextPage || matches.length !== 1) fail("Shopify's Point of Sale sales channel could not be identified uniquely. Review the POS channel connection.");
    const pos = matches[0].id;
    const website = onWebsite(product) ? await websitePublication(deps, publications.publications) : null;
    // Exact unique-ID lookup also verifies the existing identifier definition before writes.
    const byIdentity = async () => (await graphql<{ productByIdentifier: Product | null }>(`query QrLinkByIdentity($identifier: ProductIdentifierInput!, $pos: ID!) { productByIdentifier(identifier: $identifier) { ${P_FIELDS} } }`, { identifier: { customId: { namespace: RECEIVING, key: "catalog_id", value: identity.printing } }, pos })).productByIdentifier;
    let target = await byIdentity();
    const readProduct = async (id: string): Promise<Product> => {
      const result = await graphql<{ product: Product | null }>(`query QrLinkProduct($id: ID!, $pos: ID!) { product(id: $id) { ${P_FIELDS} } }`, { id, pos });
      if (!result.product) fail("The linked Shopify product was removed. Review this card's mapping; a replacement was not created.");
      const current = result.product!;
      const cursors = new Set<string>();
      while (current.variants.pageInfo.hasNextPage) {
        const after = current.variants.pageInfo.endCursor;
        if (!after || cursors.has(after)) fail("Shopify did not return a complete variant list. Retry after reviewing the product.");
        cursors.add(after!);
        const page = await graphql<{ product: { variants: Product["variants"] } | null }>(`query QrLinkVariants($id: ID!, $pos: ID!, $after: String!) { product(id: $id) { variants(first: 100, after: $after) { nodes { ${V_FIELDS} } pageInfo { hasNextPage endCursor } } } }`, { id, pos, after });
        if (!page.product) fail("The linked Shopify product disappeared while its variants were checked.");
        current.variants.nodes.push(...page.product!.variants.nodes);
        current.variants.pageInfo = page.product!.variants.pageInfo;
      }
      return current;
    };
    leaseName = lockKey(identity.printing);
    skuLeaseName = lockKey(`sku:${product.sku}`);
    owner = randomUUID();
    for (const name of [skuLeaseName, leaseName]) {
      const lease = await adapter.read<Journal>(name);
      if (lease.value?.owner && lease.value.expiresAt > deps.clock()) pending("Another employee is linking this card. Its saved QR will be reused; retry shortly.");
      const lock: Journal = { version: 1, identity: identity.printing, sku: product.sku, owner, expiresAt: deps.clock() + LEASE_MS };
      if (!await adapter.cas(name, lease, lock)) pending("Another employee is linking this card. Retry shortly to use the existing link.");
    }
    const saved = await adapter.read<Journal>(journalKey(product.sku));
    const manualIdentity = identityFor({ ...product, tcgplayerId: null, tcgplayerUrl: null });
    const canAdoptManual = Boolean(identity.source && saved.value?.identity === manualIdentity.identity && !saved.value.previousIdentity);
    const canCorrectLanguage = canCorrectPrecreationLanguage(saved.value, product, identity);
    languageCorrectionPending = canCorrectLanguage;
    if (saved.value && (saved.value.version !== 1 || (saved.value.identity !== identity.identity && !canAdoptManual && !canCorrectLanguage) || saved.value.sku !== product.sku)) fail("This saved QR already has a different Shopify card identity. Review its mapping; no duplicate was created.");
    if (!Number.isSafeInteger(product.initialQuantity) || product.initialQuantity < 0 || product.initialQuantity > 100_000) fail("This saved card's original starting quantity needs review before Shopify linking.");
    record = saved.value ?? { version: 1, identity: identity.identity, sku: product.sku, owner: null, expiresAt: 0, initialQuantity: product.initialQuantity };
    record.stockRequestKey ??= `defy-qr-${digest(JSON.stringify([deps.settings.shop, product.id, record.identity])).slice(0, 48)}`;
    if (canCorrectLanguage) record = { ...record, identity: identity.identity, status: { sku: product.sku, status: "pending", message: "Verifying the Japanese card before creating its Shopify link." } };
    if (canAdoptManual && !record.productId) {
      // A lost create response must be reconciled under its ORIGINAL unique ID.
      // Looking only under the new TCGplayer ID would create a second product.
      const original = await graphql<{ productByIdentifier: Product | null }>(`query QrLinkOriginalManual($identifier: ProductIdentifierInput!, $pos: ID!) { productByIdentifier(identifier: $identifier) { ${P_FIELDS} } }`, { identifier: { customId: { namespace: RECEIVING, key: "catalog_id", value: manualIdentity.printing } }, pos });
      if (original.productByIdentifier) record.productId = original.productByIdentifier.id;
      else if (record.creationStartedAt) pending("Shopify has not confirmed the original manual card creation yet. Retry the saved QR before adopting its TCGplayer identity; no second product was created.");
    }
    if (canAdoptManual) record = { ...record, identity: identity.identity, previousIdentity: record.identity, adoptionPending: Boolean(record.productId), status: { sku: product.sku, status: "pending", message: "Linking the TCGplayer identity to the existing Shopify card and stock receipt." } };
    if (record.initialQuantity !== product.initialQuantity) fail("The original starting quantity differs from the saved Shopify receipt. Review the receipt; stock was not added again.");
    const save = async () => {
      for (const name of [skuLeaseName, leaseName]) {
        const reservation = await adapter!.read<Journal>(name);
        if (reservation.value?.owner !== owner || reservation.value.expiresAt <= deps.clock()) pending("The Shopify linking reservation expired. Retry this saved QR code.");
      }
      const current = await adapter!.read<Journal>(journalKey(product.sku));
      const unchangedLanguageCorrection = languageCorrectionPending && current.digest === saved.digest && canCorrectPrecreationLanguage(current.value, product, identity);
      if (languageCorrectionPending && !unchangedLanguageCorrection) fail("The saved Shopify mapping changed before its language could be corrected. Retry the saved QR after reviewing its mapping.");
      if (current.value && current.value.identity !== identity.identity && !(record!.previousIdentity === current.value.identity && canAdoptManual) && !unchangedLanguageCorrection) fail("The saved Shopify mapping changed during linking. Review this card.");
      if (!await adapter!.cas(journalKey(product.sku), current, record!)) pending("The saved Shopify link changed during this request. Retry this QR code.");
      languageCorrectionPending = false;
    };
    const renew = async () => {
      for (const name of [skuLeaseName, leaseName]) {
        const current = await adapter!.read<Journal>(name);
        if (current.value?.owner !== owner || current.value.expiresAt <= deps.clock()) pending("The Shopify linking reservation expired. Retry this saved QR code.");
        if (!await adapter!.cas(name, current, { ...current.value, expiresAt: deps.clock() + LEASE_MS })) pending("Another request is finishing this Shopify link. Retry shortly.");
      }
    };
    await save();
    let cents = product.listPriceCents;
    if (identity.source) {
      const quote = await (deps.resolvePrice ?? resolveScrydexPrice)({ ...product, productType: "Single" });
      cents = scrydexSellPriceCents(quote.cents, { game: product.game, productType: "Single" });
    }
    if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100_000_000) fail("The QR is saved. Set a positive sale price before making this manual card available in Shopify POS.");
    // Search both SKU and barcode, then exact-filter Shopify's search results.
    const escaped = product.sku.replace(/[\\":()]/g, "\\$&");
    const codes = await graphql<{ productVariants: { nodes: (Variant & { product: { id: string } })[]; pageInfo: { hasNextPage: boolean } } }>(`query QrLinkCode($query: String!, $pos: ID!) { productVariants(first: 100, query: $query) { nodes { ${V_FIELDS} product { id } } pageInfo { hasNextPage } } }`, { query: `sku:"${escaped}" OR barcode:"${escaped}"`, pos });
    if (codes.productVariants.pageInfo.hasNextPage) fail("Too many Shopify variants use this code. Review duplicate SKUs and barcodes.");
    if (codes.productVariants.nodes.some(variant => variant.barcodes.pageInfo.hasNextPage)) fail("Shopify returned an incomplete barcode list. Review this card before linking.");
    const exact = codes.productVariants.nodes.filter(variant => variant.sku === product.sku || variant.barcodes.nodes.some(barcode => barcode.value === product.sku));
    if (exact.length > 1) fail("This QR code appears on multiple Shopify variants. Resolve that barcode conflict before POS linking.");
    let mappedId = record.productId;
    let mappedVariant = record.variantId;
    if (identity.riftbound && !record.adoptionPending) {
      const existing = await adapter.lookupExisting(rowFor(product, identity, cents));
      if (existing) {
        if (mappedId && (mappedId !== existing.productId || mappedVariant !== existing.variantId)) fail("The saved Shopify mapping conflicts with the existing Riftbound card.");
        mappedId = existing.productId; mappedVariant = existing.variantId;
      }
    }
    if (identity.source) {
      const tagged = await graphql<{ products: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } } }>(`query QrLinkTagged($query: String!) { products(first: 100, query: $query) { nodes { id } pageInfo { hasNextPage } } }`, { query: `tag:defy-catalog-${identity.source}` });
      if (tagged.products.pageInfo.hasNextPage) fail("Shopify has too many mappings for this TCGplayer card. Review duplicate listings.");
      const ids = new Set([...tagged.products.nodes.map(item => item.id), ...exact.map(item => item.product.id), ...(target ? [target.id] : []), ...(mappedId ? [mappedId] : [])]);
      const candidates: Product[] = [];
      for (const id of ids) {
        const candidate = await readProduct(id);
        const sameSource = candidate.sourceId?.value === String(identity.source) || candidate.catalogId?.value === identity.printing;
        if (!sameSource && id !== mappedId) fail("A Shopify catalog tag or QR barcode conflicts with this card's TCGplayer identity.");
        candidates.push(candidate);
      }
      // The legacy Defy exception is resolved by the existing singles adapter.
      const applicable = mappedId ? candidates.filter(candidate => candidate.id === mappedId || candidate.variants.nodes.some(item => exactOptions(item, identity))) : candidates;
      if (applicable.length > 1) fail("More than one Shopify product claims this card printing and condition. Review duplicate mappings.");
      if (!target && applicable.length === 1) target = applicable[0];
    }
    if ((!target && !mappedId) || (identity.source && record.adoptionPending)) {
      // Legacy cards may have exact catalog metadata but no app tag or canonical SKU.
      // Complete a metadata-only scan before deciding this printing is new.
      let after: string | null = null;
      const seen = new Set<string>();
      const candidateIds = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= 100) fail("Shopify's existing card catalog is too large to verify safely in one request. Review this card's exact Shopify mapping before linking.");
        const scan: { products: { nodes: { id: string; sourceId: Field | null; catalogId: Field | null; manualOrigin?: Field | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await graphql(`query QrLinkCatalogScan($after: String) { products(first: 100, after: $after) { nodes { id sourceId: metafield(namespace: "defy_intake", key: "catalog_id") { value } catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value } manualOrigin: metafield(namespace: "${NAMESPACE}", key: "manual_origin") { value } } pageInfo { hasNextPage endCursor } } }`, { after });
        for (const candidate of scan.products.nodes) if ((identity.source && candidate.sourceId?.value === String(identity.source)) || candidate.catalogId?.value === identity.printing || (!identity.source && candidate.manualOrigin?.value === identity.printing) || (identity.riftbound && candidate.catalogId?.value.startsWith(`single:riftbound:${identity.source}:`))) candidateIds.add(candidate.id);
        if (!scan.products.pageInfo.hasNextPage) break;
        after = scan.products.pageInfo.endCursor;
        if (!after || seen.has(after)) fail("Shopify did not return a complete existing-card scan. No new product was created.");
        seen.add(after!);
        await renew();
      }
      if (candidateIds.size > 1) fail("Multiple Shopify products have this exact TCGplayer identity. Review the existing mappings before linking.");
      if (record.adoptionPending && [...candidateIds].some(id => id !== record!.productId)) fail("This TCGplayer card already has another Shopify product. Review the existing mappings before joining its saved QR.");
      if (candidateIds.size === 1) target = await readProduct([...candidateIds][0]);
    }
    if (mappedId) {
      if (target && target.id !== mappedId) fail("More than one Shopify product claims this card printing.");
      target = await readProduct(mappedId);
    } else if (target) target = await readProduct(target.id);
    if (exact.length && (!target || exact[0].product.id !== target.id || (mappedVariant && exact[0].id !== mappedVariant))) fail("This QR code already belongs to another Shopify product. Review the existing barcode; it was not replaced.");
    if (identity.language === "Japanese" && target && !target.variants.nodes.some(variant =>
      variant.selectedOptions.some(option => option.name === "Language" && languageMatches(option.value, "Japanese")))) {
      fail("The existing Shopify listing does not identify a Japanese card. Review its language before linking this QR; no English listing was changed.");
    }
    if (!target) {
      await renew();
      if (!record.creationStartedAt) { record.creationStartedAt = deps.clock(); await save(); }
      const title = `${product.name} — ${product.setName} (${product.cardNumber})`;
      const created = await graphql<{ productCreate: Payload & { product: { id: string } | null } }>(`mutation QrLinkCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id } userErrors { message } } }`, {
        product: { title, status: "DRAFT", productType: `${product.game} single`, tags: [product.game, "Singles", identity.language, ...(identity.source ? [`defy-catalog-${identity.source}`] : [])],
          productOptions: optionsFor(identity).map(option => ({ name: option.name, values: [{ name: option.value }] })),
          metafields: [{ namespace: receivingNamespace, key: "catalog_id", value: identity.printing },
            ...(identity.source ? [{ namespace: "defy_intake", key: "catalog_id", type: "single_line_text_field", value: String(identity.source) }] : []),
            ...Object.entries({ name: product.name, game: product.game, set: product.setName, number: product.cardNumber }).map(([key, value]) => ({ namespace: "card", key, type: "single_line_text_field", value }))] },
        media: identity.source ? [{ originalSource: `https://tcgplayer-cdn.tcgplayer.com/product/${identity.source}_in_1000x1000.jpg`, mediaContentType: "IMAGE", alt: title }] : [],
      });
      // Unique app-owned identifier resolves a concurrent creator or response loss.
      target = created.productCreate.product?.id ? await readProduct(created.productCreate.product.id) : await byIdentity();
      if (!target) { check(created.productCreate); pending("Shopify has not confirmed the new card. Retry this saved QR; no replacement SKU is needed."); }
    }
    if (record.adoptionPending) {
      if (!record.previousIdentity || record.previousIdentity !== manualIdentity.identity || !target || target.id !== record.productId) fail("The original manual Shopify mapping could not be verified before linking its TCGplayer identity.");
      const originalCandidates = record.variantId ? target!.variants.nodes.filter(item => item.id === record!.variantId) : target!.variants.nodes.filter(item => exactOptions(item, identity));
      const original = originalCandidates.length === 1 ? originalCandidates[0] : undefined;
      const blankInitial = original && !original.sku && original.barcodes.nodes.length === 0 && target!.status === "DRAFT" && target!.variants.nodes.length === 1 && original.inventoryQuantity === 0;
      const allowedCatalogs = [manualIdentity.printing, identity.printing];
      if (!original || (record.shopifySku !== undefined && (original.sku || "") !== record.shopifySku) || !exactOptions(original, identity) || (!blankInitial && (!original.inventoryItem.tracked || original.inventoryPolicy !== "DENY" || !original.barcodes.nodes.some(code => code.value === product.sku) || ![record.previousIdentity, identity.identity].includes(original.qrIdentity?.value || ""))) || !allowedCatalogs.includes(target!.catalogId?.value || "") || (target!.sourceId?.value && target!.sourceId.value !== String(identity.source))) fail("The manual card's Shopify identity changed. Review it before adopting the TCGplayer link.");
      if (!record.adjustmentId && record.adjustmentStartedAt && deps.clock() - record.adjustmentStartedAt >= 23 * 60 * 60 * 1000) fail("The original manual card stock receipt needs review before its TCGplayer link can be adopted. Stock was not added again.");
      await renew();
      const adopted = await graphql<{ productUpdate: Payload }>(`mutation QrLinkAdoptCatalog($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`, { product: { id: target!.id, metafields: [{ namespace: receivingNamespace, key: "catalog_id", value: identity.printing }, { namespace: "defy_intake", key: "catalog_id", type: "single_line_text_field", value: String(identity.source) }, { namespace: NAMESPACE, key: "manual_origin", type: "single_line_text_field", value: manualIdentity.printing }] } });
      check(adopted.productUpdate);
      if (!blankInitial) {
      record.variantId = original!.id; record.shopifySku = original!.sku || ""; await save();
      await renew();
      const marked = await graphql<{ productVariantsBulkUpdate: Payload }>(`mutation QrLinkAdoptVariant($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $variants) { userErrors { code message } } }`, { id: target!.id, variants: [{ id: original!.id, metafields: [{ namespace: NAMESPACE, key: "qr_identity", type: "single_line_text_field", value: identity.identity }] }] });
      check(marked.productVariantsBulkUpdate);
      }
      target = await readProduct(target!.id);
      const confirmed = target.variants.nodes.find(item => item.id === record!.variantId);
      if (target.catalogId?.value !== identity.printing || target.sourceId?.value !== String(identity.source) || (!blankInitial && (confirmed?.qrIdentity?.value !== identity.identity || confirmed.sku !== record.shopifySku))) pending("Shopify has not confirmed the existing card's TCGplayer link. Retry this same QR; its original stock receipt is retained.");
      record.adoptionPending = false; await save();
      mappedId = record.productId; mappedVariant = record.variantId;
    }
    if (target!.status === "ARCHIVED") fail("This Shopify product is archived. Review it before restoring POS availability.");
    if (!matchesProductIdentity(target!, identity)) fail("Shopify's saved catalog identity belongs to another card.");
    if (identity.source && target!.sourceId?.value && target!.sourceId.value !== String(identity.source)) fail("Shopify's TCGplayer ID conflicts with this saved card.");
    if (!record.productId) { record.productId = target!.id; await save(); }
    let variant = mappedVariant ? target!.variants.nodes.find(item => item.id === mappedVariant) : undefined;
    if (mappedVariant && !variant) fail("The saved Shopify variant was removed. Review its mapping before creating another listing.");
    const optionMatches = target!.variants.nodes.filter(item => exactOptions(item, identity));
    if (!variant) {
      if (optionMatches.length > 1) fail("More than one Shopify variant has this condition and finish.");
      variant = optionMatches[0];
      // Exact catalog ID plus unique condition/finish/language is authoritative; retain any existing SKU.
    }
    if (exact.length && (!variant || exact[0].id !== variant.id)) fail("This QR code belongs to another condition or finish of this Shopify product. Review its existing barcode before linking.");
    const initial = variant && !variant.sku && !variant.barcodes.nodes.length && target!.status === "DRAFT" && target!.catalogId?.value === identity.printing && target!.variants.nodes.length === 1 && variant.inventoryQuantity === 0;
    if (variant && !initial && !matchesSavedVariant(variant, target!, identity, deps.settings.shop)) fail("The Shopify card's condition, finish, language, or TCGplayer identity changed. Review the saved link before changing its price or stock.");
    if (variant?.qrIdentity?.value && variant.qrIdentity.value !== identity.identity) fail("This Shopify variant is already linked to a different QR card identity.");
    if (!variant || initial) {
      if (target!.options.length !== 3 || !optionsFor(identity).every(option => target!.options.some(actual => actual.name === option.name))) fail("Review this Shopify product's condition, finish, and language options before linking.");
      await renew();
      const input = { price: money(cents), barcodes: [{ value: product.sku }], inventoryPolicy: "DENY", inventoryItem: { sku: identity.sku, tracked: true, requiresShipping: true },
        metafields: [{ namespace: NAMESPACE, key: "qr_identity", type: "single_line_text_field", value: identity.identity }],
        ...(initial ? { id: variant!.id } : { optionValues: optionsFor(identity).map(option => ({ optionName: option.name, name: option.value })) }) };
      const mutation = initial ? "productVariantsBulkUpdate" : "productVariantsBulkCreate";
      const updated = await graphql<Record<string, Payload>>(`mutation QrLinkVariant($id: ID!, $variants: [ProductVariantsBulkInput!]!) { ${mutation}(productId: $id, variants: $variants) { userErrors { code message } } }`, { id: target!.id, variants: [input] });
      check(updated[mutation]);
      target = await readProduct(target!.id);
      variant = target.variants.nodes.find(item => item.sku === identity.sku && exactOptions(item, identity));
      if (!variant) pending("Shopify has not confirmed the card variant. Retry this saved QR code.");
    }
    if (!variant!.inventoryItem.tracked || variant!.inventoryPolicy !== "DENY") fail("The Shopify card must track stock and stop selling when out of stock. Review its inventory settings.");
    target = await readProduct(target!.id);
    variant = target.variants.nodes.find(item => item.id === variant!.id);
    if (!variant) fail("The Shopify variant disappeared before linking its QR code.");
    if (!matchesSavedVariant(variant!, target, identity, deps.settings.shop) || (variant!.qrIdentity?.value && variant!.qrIdentity.value !== identity.identity)) fail("The Shopify variant identity changed before linking. Review its condition, finish, and language.");
    if (variant!.barcodes.pageInfo.hasNextPage || (variant!.barcodes.nodes.length >= 20 && !variant!.barcodes.nodes.some(barcode => barcode.value === product.sku))) fail("This Shopify variant has reached its barcode limit. Review its barcodes; the existing codes were preserved.");
    if (record.variantId && (record.variantId !== variant!.id || record.shopifySku !== variant!.sku)) fail("The original Shopify variant or SKU changed. Review the saved link.");
    record.variantId = variant!.id; record.shopifySku = variant!.sku || ""; record.publicationId = pos; await save();
    const retainedBarcodes = variant!.barcodes.nodes.map(code => ({ ...code }));
    if (!variant!.barcodes.nodes.some(barcode => barcode.value === product.sku) || priceCents(variant!.price) !== cents || variant!.qrIdentity?.value !== identity.identity) {
      await renew();
      const result = await graphql<{ productVariantsBulkUpdate: Payload }>(`mutation QrLinkBarcode($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $variants) { userErrors { code message } } }`, { id: target!.id, variants: [{ id: variant!.id, barcodes: [...variant!.barcodes.nodes.map(barcode => ({ value: barcode.value, ...(barcode.type ? { type: barcode.type } : {}) })), ...(!variant!.barcodes.nodes.some(barcode => barcode.value === product.sku) ? [{ value: product.sku }] : [])], price: money(cents), metafields: [{ namespace: NAMESPACE, key: "qr_identity", type: "single_line_text_field", value: identity.identity }] }] });
      check(result.productVariantsBulkUpdate);
    }
    target = await readProduct(target!.id);
    variant = target.variants.nodes.find(item => item.id === record!.variantId);
    if (!variant || variant.sku !== record.shopifySku || variant.barcodes.pageInfo.hasNextPage || !variant.barcodes.nodes.some(barcode => barcode.value === product.sku) || retainedBarcodes.some(code => !variant!.barcodes.nodes.some(current => current.value === code.value && current.type === code.type)) || priceCents(variant.price) !== cents) pending("Shopify has not confirmed the original SKU, QR barcode, and price. Retry this saved QR.");
    if (!matchesSavedVariant(variant!, target, identity, deps.settings.shop) || variant!.qrIdentity?.value !== identity.identity) fail("The Shopify card identity changed. Its starting stock and POS publication were not applied.");
    if (target.variants.nodes.some(item => item.inventoryQuantity > 0 && priceCents(item.price) <= 0)) fail("Another stocked variant of this Shopify product has no positive price. Price it before enabling the product in POS.");
    if (inStoreOnly(product)) {
      await renew();
      const outsidePos = await nonPosPublications(product, record, deps);
      if (outsidePos.length) {
        for (let start = 0; start < outsidePos.length; start += 100) {
          await renew();
          const removed = await graphql<{ publishableUnpublish: Payload }>(`mutation QrLinkInStoreOnly($id: ID!, $input: [PublicationInput!]!) {
            publishableUnpublish(id: $id, input: $input) { userErrors { message } }
          }`, { id: target.id, input: outsidePos.slice(start, start + 100).map(publicationId => ({ publicationId })) });
          check(removed.publishableUnpublish);
        }
        if ((await nonPosPublications(product, record, deps)).length) pending("Shopify has not confirmed in-store-only sales for this Pokémon single. Retry the same QR; it is not ready yet.");
      }
    }
    // Only the immutable original Defy receipt is transferred, never today's stock.
    {
      if (!record.adjustmentId && record.adjustmentStartedAt && deps.clock() - record.adjustmentStartedAt >= 23 * 60 * 60 * 1000) fail("The stock transfer response is uncertain and its safe retry window expired. Review the Shopify receipt before adding stock; this QR will not add it twice.");
      await renew();
      const level = await graphql<{ inventoryItem: { inventoryLevel: { id: string } | null } | null }>(`query QrLinkStockLocation($id: ID!, $locationId: ID!) { inventoryItem(id: $id) { inventoryLevel(locationId: $locationId) { id } } }`, { id: variant!.inventoryItem.id, locationId: deps.settings.locationId });
      const requestKey = record.stockRequestKey!;
      if ((record.stockInventoryItemId && record.stockInventoryItemId !== variant!.inventoryItem.id) || (record.stockLocationId && record.stockLocationId !== deps.settings.locationId)) fail("The original Shopify stock receipt uses another item or location. Review it before transferring any starting stock.");
      if (!record.stockInventoryItemId || !record.stockLocationId) { record.stockInventoryItemId = variant!.inventoryItem.id; record.stockLocationId = deps.settings.locationId; await save(); }
      if (!level.inventoryItem) fail("The Shopify inventory item was removed. Review the saved link before transferring starting stock.");
      if (!level.inventoryItem!.inventoryLevel) {
        const activated = await graphql<{ inventoryActivate: Payload & { inventoryLevel: { id: string } | null } }>(`mutation QrLinkStockActivate($id: ID!, $locationId: ID!, $key: String!) { inventoryActivate(inventoryItemId: $id, locationId: $locationId) @idempotent(key: $key) { inventoryLevel { id } userErrors { message } } }`, { id: variant!.inventoryItem.id, locationId: deps.settings.locationId, key: `${requestKey}-activate` });
        check(activated.inventoryActivate);
        if (!activated.inventoryActivate.inventoryLevel?.id) pending("Shopify has not confirmed this card at the POS stock location. Retry the saved QR.");
      }
      if (record.initialQuantity! > 0 && !record.adjustmentId) {
        if (!record.adjustmentStartedAt) { record.adjustmentStartedAt = deps.clock(); await save(); }
        await renew();
        const adjusted = await graphql<{ inventoryAdjustQuantities: Payload & { inventoryAdjustmentGroup: { id: string } | null } }>(`mutation QrLinkInitialStock($input: InventoryAdjustQuantitiesInput!, $key: String!) { inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { code message } } }`, { key: `${requestKey}-receive`, input: { name: "available", reason: "received", referenceDocumentUri: `gid://defy-qr/InitialStock/${product.id}`, changes: [{ inventoryItemId: variant!.inventoryItem.id, locationId: deps.settings.locationId, delta: record.initialQuantity, changeFromQuantity: null }] } });
        check(adjusted.inventoryAdjustQuantities);
        if (!adjusted.inventoryAdjustQuantities.inventoryAdjustmentGroup?.id) pending("Shopify has not confirmed the starting stock transfer. Retry this same saved QR; its transfer receipt prevents duplicate stock.");
        record.adjustmentId = adjusted.inventoryAdjustQuantities.inventoryAdjustmentGroup!.id;
        await save();
      }
    }
    if (target.status !== "ACTIVE") {
      await renew();
      const result = await graphql<{ productUpdate: Payload }>(`mutation QrLinkActivate($product: ProductUpdateInput!) { productUpdate(product: $product) { userErrors { message } } }`, { product: { id: target.id, status: "ACTIVE" } });
      check(result.productUpdate);
    }
    if (!target.pos || !variant!.pos) {
      await renew();
      const published = await graphql<{ publishablePublish: Payload }>(`mutation QrLinkPublish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`, { id: target.id, input: [{ publicationId: pos }] });
      check(published.publishablePublish);
      // Variant-level exclusions must be verified separately; never report a product-only publication as ready.
      const variantPublish = await graphql<{ publishablePublish: Payload }>(`mutation QrLinkPublishVariant($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`, { id: variant!.id, input: [{ publicationId: pos }] });
      check(variantPublish.publishablePublish);
    }
    target = await readProduct(target.id);
    variant = target.variants.nodes.find(item => item.id === record!.variantId);
    if (target.status !== "ACTIVE" || !target.pos || !variant?.pos || !matchesSavedVariant(variant, target, identity, deps.settings.shop) || variant.qrIdentity?.value !== identity.identity || variant.sku !== record.shopifySku || !variant.barcodes.nodes.some(barcode => barcode.value === product.sku) || priceCents(variant.price) !== cents) pending("Shopify is still confirming POS availability. Retry this saved QR code shortly.");
    if (website && !await websiteAvailable(product, record, deps, website)) {
      await renew();
      const published = await graphql<{ publishablePublish: Payload }>(`mutation QrLinkWebsitePublish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`, { id: target.id, input: [{ publicationId: website }] });
      check(published.publishablePublish);
      await renew();
      const publishedVariant = await graphql<{ publishablePublish: Payload }>(`mutation QrLinkWebsitePublishVariant($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { message } } }`, { id: variant!.id, input: [{ publicationId: website }] });
      check(publishedVariant.publishablePublish);
      if (!await websiteAvailable(product, record, deps, website)) pending("Shopify has not confirmed this Riftbound card on the Defy website. Retry the saved QR; its original stock receipt is retained.");
    }
    record.status = { sku: product.sku, status: "ready", message: website ? "Linked to Shopify POS and the Defy website. Refresh POS before scanning this saved QR." : "Linked to Shopify POS. Refresh POS before scanning this saved QR.", productId: target.id, variantId: variant!.id,
      adminUrl: `https://${deps.settings.shop}/admin/products/${target.id.split("/").at(-1)}/variants/${variant!.id.split("/").at(-1)}`, priceCents: cents, transferredQuantity: record.adjustmentId ? record.initialQuantity : 0, checkedAt: new Date(deps.clock()).toISOString() };
    await save();
    return (await getSkuLabelShopifyStatuses([product], deps))[0];
  } catch (error) {
    const status = { ...safeFailure(product.sku, error), ...(record?.productId ? { productId: record.productId } : {}), ...(record?.variantId ? { variantId: record.variantId } : {}) };
    if (adapter && record && !languageCorrectionPending) {
      try { const reservation = await adapter.read<Journal>(leaseName); const saved = await adapter.read<Journal>(journalKey(product.sku)); if (reservation.value?.owner === owner && saved.value?.identity === record.identity) await adapter.cas(journalKey(product.sku), saved, { ...saved.value, status }); } catch { /* A retry reconciles any unconfirmed status. */ }
    }
    return status;
  } finally {
    if (adapter && leaseName && owner) {
      for (const name of [leaseName, skuLeaseName].filter(Boolean)) {
        try { const current = await adapter.read<Journal>(name); if (current.value?.owner === owner) await adapter.cas(name, current, { ...current.value, owner: null, expiresAt: 0 }); } catch { /* Expiring lease permits a later retry. */ }
      }
    }
  }
}
