// Server module: imported only by API routes and the Node-only intake service.
import { digest, SinglesError, type PlannedSingle, type ReceiptRow, type SingleProduct, type SinglesAdapter, type SinglesConnectionStatus, type SinglesContext, type Snapshot } from "./intake.ts";

const API_VERSION = "2026-07";
const NAMESPACE = "$app:singles";
const RECEIVING = "$app:receiving";
type Variables = Record<string, unknown>;
interface UserError { code?: string; message: string }
interface Payload { userErrors?: UserError[] }
interface Field { value: string; compareDigest: string; namespace: string }
export type SinglesGraphQL = <T>(query: string, variables?: Variables) => Promise<T>;

function check(payload: Payload | null | undefined, action: string) {
  if (!payload) throw new SinglesError("SHOPIFY_UNAVAILABLE", `${action} returned no confirmation. Retry the same receipt.`, true, true);
  if (payload.userErrors?.length) throw new SinglesError("SHOPIFY_REJECTED", `${action}: ${payload.userErrors.map(error => error.message).join("; ")}`);
}
function config() {
  if (typeof window !== "undefined") throw new Error("Shopify singles credentials are server-only.");
  const shop = process.env.SHOPIFY_SHOP_DOMAIN?.trim() ?? "";
  const clientId = process.env.SHOPIFY_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? "";
  const locationId = process.env.SHOPIFY_LOCATION_ID?.trim() ?? "";
  if (!shop || !clientId || !clientSecret || !locationId) throw new SinglesError("CONNECTION_REQUIRED", "Configure the server's Shopify shop, app credentials, and receiving location.");
  if (!["n4a7aa-fi.myshopify.com", "defy-receiving-test.myshopify.com"].includes(shop)) throw new SinglesError("SHOP_INVALID", "The singles connection must use the approved Defy Shopify shop or its test store.");
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId)) throw new SinglesError("LOCATION_INVALID", "Configure a complete Shopify location ID.");
  return { shop, clientId, clientSecret, locationId };
}

let tokenCache: { shop: string; clientId: string; clientSecret: string; value: string; expiresAt: number } | null = null;
async function transport(settings: ReturnType<typeof config>): Promise<{ graphql: SinglesGraphQL; clock: () => number }> {
  if (!tokenCache || tokenCache.shop !== settings.shop || tokenCache.clientId !== settings.clientId || tokenCache.clientSecret !== settings.clientSecret || tokenCache.expiresAt <= Date.now()) {
    let response: Response;
    try {
      response = await fetch(`https://${settings.shop}/admin/oauth/access_token`, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: settings.clientId, client_secret: settings.clientSecret }) });
    } catch { throw new SinglesError("SHOPIFY_UNAVAILABLE", "Shopify app authentication is unavailable. Retry shortly.", true); }
    if (!response.ok) throw new SinglesError("SHOPIFY_AUTH_FAILED", `Shopify app authentication failed (${response.status}). Check the installed app credentials.`);
    const token = await response.json() as { access_token?: string; expires_in?: number };
    if (!token.access_token) throw new SinglesError("SHOPIFY_AUTH_FAILED", "Shopify returned no app token.");
    tokenCache = { ...settings, value: token.access_token, expiresAt: Date.now() + Math.max(60, (token.expires_in ?? 3600) - 60) * 1000 };
  }
  const token = tokenCache.value;
  let serverOffset: number | null = null;
  const graphql: SinglesGraphQL = async <T>(query: string, variables: Variables = {}): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`https://${settings.shop}/admin/api/${API_VERSION}/graphql.json`, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }) });
    } catch { throw new SinglesError("SHOPIFY_UNAVAILABLE", "Shopify timed out. Retry the same saved request.", true, query.includes("mutation")); }
    const date = Date.parse(response.headers.get("date") ?? "");
    if (Number.isFinite(date)) serverOffset = date - Date.now();
    if (!response.ok) throw new SinglesError("SHOPIFY_UNAVAILABLE", `Shopify returned HTTP ${response.status}. Retry the same request.`, true, query.includes("mutation"));
    const body = await response.json() as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (body.errors?.length) {
      const code = body.errors[0].extensions?.code ?? "GRAPHQL_ERROR";
      throw new SinglesError(code, body.errors.map(error => error.message).join("; "), ["THROTTLED", "INTERNAL_SERVER_ERROR"].includes(code), query.includes("mutation"));
    }
    if (!body.data) throw new SinglesError("SHOPIFY_UNAVAILABLE", "Shopify returned no confirmed result. Retry the same request.", true, query.includes("mutation"));
    return body.data;
  };
  return { graphql, clock: () => {
    if (serverOffset === null) throw new SinglesError("CLOCK_UNAVAILABLE", "Shopify server time could not be verified. Retry this receipt.", true);
    return Date.now() + serverOffset;
  } };
}

interface Inspection {
  shop: { id: string; currencyCode: string; receiving: Field | null };
  currentAppInstallation: { accessScopes: { handle: string }[] };
  location: { id: string; name: string; isActive: boolean } | null;
}
interface VariantNode {
  id: string; sku: string; price: string; inventoryQuantity: number; inventoryPolicy: string;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean };
}
interface ProductNode {
  id: string; status: string; catalogId: { value: string } | null;
  storefrontCatalogId?: { value: string } | null;
  options?: { name: string }[];
  variants: { nodes: VariantNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
}
const PRODUCT_IDENTITY_FIELDS = `id status catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value }
  storefrontCatalogId: metafield(namespace: "defy_intake", key: "catalog_id") { value } options { name }`;
const VARIANT_FIELDS = `id sku price inventoryQuantity inventoryPolicy selectedOptions { name value } inventoryItem { id tracked }`;
const PRODUCT_FIELDS = `${PRODUCT_IDENTITY_FIELDS}
  variants(first: 100) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } }`;
// Verified against the original storefront's BATCH_PREVIEW and intake mapping.
// This legacy no-SKU variant is the only exception to exact SKU + option matching.
export const LEGACY_DEFY_MAPPING = {
  shop: "n4a7aa-fi.myshopify.com", sourceProductId: 652821,
  productId: "gid://shopify/Product/8056288673878", variantId: "gid://shopify/ProductVariant/45773521059926",
  inventoryItemId: "gid://shopify/InventoryItem/47937252163670",
} as const;
const printingId = (row: PlannedSingle) => `single:riftbound:printing:${row.card.productId}`;
const canonicalSku = (row: PlannedSingle) => `DEFY-RFB-${row.card.productId}-${row.card.finish.toUpperCase()}-EN-${row.catalogId.split(":").at(-1)}`;
const oldSku = (row: PlannedSingle) => `DEFY-RFB-S${row.card.productId}-${digest(row.card.finish).slice(0, 12).toUpperCase()}-EN-${row.catalogId.split(":").at(-1)}`;
const optionsFor = (row: PlannedSingle) => [
  { name: "Condition", value: row.condition },
  { name: "Finish", value: row.card.finish === "Normal" ? "Nonfoil" : row.card.finish },
  { name: "Language", value: "English" },
];
const exactOptions = (variant: VariantNode, row: PlannedSingle) => variant.selectedOptions?.length === 3 && optionsFor(row).every(expected => variant.selectedOptions.some(actual => actual.name === expected.name && actual.value === expected.value));
const identityConflict = (message: string) => new SinglesError("PRODUCT_IDENTITY_CONFLICT", `${message} Review the Shopify mappings before receiving; no duplicate listing will be created.`, false, true);
function fullSizeImage(row: PlannedSingle) {
  if (!/^https:\/\/(?:product-images|tcgplayer-cdn)\.tcgplayer\.com\//.test(row.card.imageUrl)) return null;
  return `https://tcgplayer-cdn.tcgplayer.com/product/${row.card.productId}_in_1000x1000.jpg`;
}
const money = (cents: number) => (cents / 100).toFixed(2);
const html = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export class ShopifySinglesAdapter implements SinglesAdapter {
  private shopId = "";
  private graphql: SinglesGraphQL;
  private settings: { shop: string; locationId: string };
  private clock: () => number;
  private catalogCache = new Map<number, Map<string, ProductNode>>();
  constructor(graphql: SinglesGraphQL, settings: { shop: string; locationId: string }, clock: () => number) {
    this.graphql = graphql;
    this.settings = settings;
    this.clock = clock;
  }

  async inspect(): Promise<{ status: SinglesConnectionStatus; context: SinglesContext }> {
    const data = await this.graphql<Inspection>(`query SinglesConnection($locationId: ID!) {
      shop { id currencyCode receiving: metafield(namespace: "${RECEIVING}", key: "state") { value namespace compareDigest } }
      currentAppInstallation { accessScopes { handle } }
      location(id: $locationId) { id name isActive }
    }`, { locationId: this.settings.locationId });
    this.shopId = data.shop.id;
    const scopes = new Set(data.currentAppInstallation.accessScopes.map(scope => scope.handle));
    const blockers: string[] = [];
    for (const scope of ["write_products", "write_inventory", "read_locations"]) if (!scopes.has(scope)) blockers.push(`Shopify app needs ${scope}.`);
    if (!data.location?.isActive) blockers.push("The configured receiving location is missing or inactive.");
    if (data.shop.currencyCode !== "USD") blockers.push("Singles prices currently require a Shopify store using USD.");
    const receivingNamespace = data.shop.receiving?.namespace ?? "";
    if (!/^app--\d+--receiving$/.test(receivingNamespace)) blockers.push("Initialize Defy Receiving before connecting singles inventory.");
    const publicationBlockers: string[] = [];
    let publicationIds: string[] = [];
    if (!scopes.has("write_publications")) publicationBlockers.push("The Shopify app needs write_publications permission to publish to Online Store, Point of Sale, and the Defy website.");
    else {
      try {
        const publications = await this.graphql<{ publications: { nodes: { id: string; name: string; catalog: { title: string } | null }[]; pageInfo: { hasNextPage: boolean } } }>(`query SinglesPublications {
          publications(first: 250, catalogType: APP) { nodes { id name catalog { title } } pageInfo { hasNextPage } }
        }`);
        const online = publications.publications.nodes.filter(item => item.catalog?.title === "Online Store" || item.name === "Online Store");
        const pos = publications.publications.nodes.filter(item => item.catalog?.title === "Point of Sale" || item.name === "Point of Sale");
        const website = publications.publications.nodes.filter(item => item.catalog?.title === "Defy TCG website" || item.name === "Defy TCG website" || (this.settings.shop === LEGACY_DEFY_MAPPING.shop && item.id === "gid://shopify/Publication/202600611926"));
        if (publications.publications.pageInfo.hasNextPage || online.length !== 1 || pos.length !== 1 || website.length !== 1 || new Set([online[0]?.id, pos[0]?.id, website[0]?.id]).size !== 3) publicationBlockers.push("Verify Online Store, Point of Sale, and the Defy TCG website Headless publication in Shopify.");
        else publicationIds = [online[0].id, pos[0].id, website[0].id];
      } catch (error) { publicationBlockers.push(error instanceof SinglesError ? error.message : "Shopify channel publications could not be verified."); }
    }
    const status: SinglesConnectionStatus = { configured: true, ready: blockers.length === 0, shop: this.settings.shop, locationId: this.settings.locationId, locationName: data.location?.name ?? "", currencyCode: data.shop.currencyCode,
      canPublish: blockers.length === 0 && publicationBlockers.length === 0, blockers, publicationBlockers };
    return { status, context: { shopId: this.shopId, shop: this.settings.shop, locationId: this.settings.locationId, locationName: status.locationName, currencyCode: status.currencyCode, receivingNamespace, publicationIds } };
  }

  async preflight(publish: boolean): Promise<SinglesContext> {
    const { status, context } = await this.inspect();
    const errors = [...status.blockers, ...(publish ? status.publicationBlockers : [])];
    if (errors.length) throw new SinglesError("CONNECTION_BLOCKED", errors.join(" "));
    // A direct lookup also verifies the existing unique catalog ID definition before any write.
    await this.catalogProduct("single:riftbound:connection-check");
    return context;
  }
  async now() {
    await this.graphql(`query SinglesServerClock { shop { id } }`);
    return this.clock();
  }
  async read<T>(key: string): Promise<Snapshot<T>> {
    const data = await this.graphql<{ shop: { id: string; metafield: Field | null } }>(`query SinglesRecord($key: String!) {
      shop { id metafield(namespace: "${NAMESPACE}", key: $key) { value compareDigest namespace } }
    }`, { key });
    this.shopId = data.shop.id;
    if (!data.shop.metafield) return { value: null, digest: null };
    try { return { value: JSON.parse(data.shop.metafield.value) as T, digest: data.shop.metafield.compareDigest }; }
    catch { throw new SinglesError("RECEIPT_INVALID", "The Shopify singles receipt journal is damaged. Keep the request ID for owner review.", false, true); }
  }
  async cas<T>(key: string, snapshot: Snapshot<T>, value: T) {
    if (!this.shopId) throw new SinglesError("CONNECTION_REQUIRED", "Read the Shopify connection before saving receipts.");
    const data = await this.graphql<{ metafieldsSet: Payload & { metafields: { compareDigest: string }[] } }>(`mutation SinglesRecordCAS($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { compareDigest } userErrors { code message } }
    }`, { metafields: [{ ownerId: this.shopId, namespace: NAMESPACE, key, type: "json", value: JSON.stringify(value), compareDigest: snapshot.digest }] });
    if (data.metafieldsSet.userErrors?.some(error => ["INVALID_COMPARE_DIGEST", "STALE_OBJECT", "TAKEN"].includes(error.code ?? ""))) return false;
    check(data.metafieldsSet, "Saving the singles receipt");
    if (!data.metafieldsSet.metafields?.length) throw new SinglesError("RECEIPT_UNCERTAIN", "Shopify did not confirm the saved receipt. Retry the same request.", true, true);
    return true;
  }
  private async catalogProduct(catalogId: string) {
    const data = await this.graphql<{ productByIdentifier: ProductNode | null }>(`query SinglesProduct($identifier: ProductIdentifierInput!) {
      productByIdentifier(identifier: $identifier) { ${PRODUCT_FIELDS} }
    }`, { identifier: { customId: { namespace: RECEIVING, key: "catalog_id", value: catalogId } } });
    return data.productByIdentifier;
  }
  private async productById(id: string): Promise<ProductNode | null> {
    const data = await this.graphql<{ product: ProductNode | null }>(`query SinglesProductById($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id });
    const product = data.product;
    if (!product) return null;
    const seen = new Set<string>();
    while (product.variants.pageInfo.hasNextPage) {
      const after = product.variants.pageInfo.endCursor;
      if (!after || seen.has(after)) throw identityConflict("Shopify did not return a complete variant list.");
      seen.add(after);
      const next = await this.graphql<{ product: { variants: ProductNode["variants"] } | null }>(`query SinglesProductVariants($id: ID!, $after: String!) { product(id: $id) { variants(first: 100, after: $after) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } } } }`, { id, after });
      if (!next.product) throw identityConflict("The mapped Shopify product disappeared.");
      product.variants.nodes.push(...next.product.variants.nodes);
      product.variants.pageInfo = next.product.variants.pageInfo;
    }
    return product;
  }
  private async allProducts(row: PlannedSingle): Promise<Map<string, ProductNode>> {
    const sourceId = row.card.productId;
    const cached = this.catalogCache.get(sourceId);
    if (cached) return cached;
    const products = new Map<string, ProductNode>();
    const ids = new Set<string>();
    // Every known writer supplies one of these exact identifiers. We never search titles.
    for (const id of [row.catalogId, printingId(row)]) {
      const direct = await this.catalogProduct(id);
      if (direct) ids.add(direct.id);
    }
    const known: Record<number, string> = {
      652975: "8057403277398", 666830: "8057403310166", 653026: "8057403408470", 652821: "8056288673878",
      653006: "8057403539542", 652886: "8057403637846", 652819: "8057403703382", 652850: "8057403801686", 652844: "8057403899990",
    };
    if (this.settings.shop === LEGACY_DEFY_MAPPING.shop && known[sourceId]) ids.add(`gid://shopify/Product/${known[sourceId]}`);
    const handle = `riftbound-${sourceId}${sourceId === LEGACY_DEFY_MAPPING.sourceProductId ? "-catalog" : ""}`;
    const byHandle = await this.graphql<{ productByIdentifier: { id: string; storefrontCatalogId: { value: string } | null } | null }>(`query SinglesStorefrontHandle($identifier: ProductIdentifierInput!) {
      productByIdentifier(identifier: $identifier) { id storefrontCatalogId: metafield(namespace: "defy_intake", key: "catalog_id") { value } }
    }`, { identifier: { handle } });
    if (byHandle.productByIdentifier) {
      if (byHandle.productByIdentifier.storefrontCatalogId?.value !== String(sourceId)) throw identityConflict("The storefront's expected product address belongs to another printing.");
      ids.add(byHandle.productByIdentifier.id);
    }
    for (const kind of ["sku", "tag"] as const) {
      let after: string | null = null;
      const cursors = new Set<string>();
      do {
        const data: { productVariants: { nodes: { sku: string; product: { id: string } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }; products: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.graphql(kind === "sku" ? `query SinglesMappings($after: String, $query: String!) {
          productVariants(first: 100, after: $after, query: $query) { nodes { sku product { id } } pageInfo { hasNextPage endCursor } }
        }` : `query SinglesTaggedMappings($after: String, $query: String!) {
          products(first: 100, after: $after, query: $query) { nodes { id } pageInfo { hasNextPage endCursor } }
        }`, { after, query: kind === "sku" ? `sku:DEFY-RFB-${sourceId}-* OR sku:DEFY-RFB-S${sourceId}-*` : `tag:defy-catalog-${sourceId}` });
        const page = kind === "sku" ? data.productVariants.pageInfo : data.products.pageInfo;
        if (kind === "sku") {
          for (const variant of data.productVariants.nodes) if ((variant.sku || "").startsWith(`DEFY-RFB-${sourceId}-`) || (variant.sku || "").startsWith(`DEFY-RFB-S${sourceId}-`)) ids.add(variant.product.id);
        } else for (const product of data.products.nodes) ids.add(product.id);
        if (!page.hasNextPage) break;
        after = page.endCursor;
        if (!after || cursors.has(after)) throw identityConflict("Shopify did not return a complete product mapping.");
        cursors.add(after);
      } while (after);
    }
    for (const id of ids) {
      const product = await this.productById(id);
      if (product) {
        const hasSource = product.catalogId?.value?.startsWith(`single:riftbound:${sourceId}:`) || product.catalogId?.value === printingId(row) || product.storefrontCatalogId?.value === String(sourceId) || product.variants.nodes.some(variant => (variant.sku || "").startsWith(`DEFY-RFB-${sourceId}-`) || (variant.sku || "").startsWith(`DEFY-RFB-S${sourceId}-`));
        const legacy = sourceId === LEGACY_DEFY_MAPPING.sourceProductId && this.settings.shop === LEGACY_DEFY_MAPPING.shop && product.id === LEGACY_DEFY_MAPPING.productId;
        if (!hasSource && !legacy) throw identityConflict("A known product ID or catalog tag no longer identifies the expected printing.");
        products.set(id, product);
      }
      else if (id === `gid://shopify/Product/${known[sourceId]}`) throw identityConflict("A verified existing storefront listing was removed.");
      else throw identityConflict("A product disappeared while its mapping was being checked.");
    }
    this.catalogCache.set(sourceId, products);
    return products;
  }
  private isLegacy(row: PlannedSingle) {
    return this.settings.shop === LEGACY_DEFY_MAPPING.shop && row.card.productId === LEGACY_DEFY_MAPPING.sourceProductId && row.card.finish === "Normal" && row.condition === "Near Mint";
  }
  private matches(product: ProductNode, row: PlannedSingle): VariantNode[] {
    const legacy = this.isLegacy(row) && product.id === LEGACY_DEFY_MAPPING.productId;
    const source = product.storefrontCatalogId?.value;
    const catalog = product.catalogId?.value;
    const rowSkus = new Set([canonicalSku(row), oldSku(row)]);
    const matches = product.variants.nodes.filter(variant => rowSkus.has(variant.sku) || (legacy && variant.id === LEGACY_DEFY_MAPPING.variantId));
    if (matches.length && ((source && source !== String(row.card.productId)) || (catalog && ![row.catalogId, printingId(row)].includes(catalog)))) throw identityConflict("SKU and product metadata point to different printings.");
    for (const variant of matches) {
      if (legacy && variant.id === LEGACY_DEFY_MAPPING.variantId) {
        if (variant.inventoryItem.id !== LEGACY_DEFY_MAPPING.inventoryItemId || (variant.sku && !rowSkus.has(variant.sku))) throw identityConflict("The verified legacy Defy inventory item changed.");
      } else if (variant.sku === oldSku(row) && catalog === row.catalogId) {
        // Old OS receipts retain their original single-variant Default Title product.
        if (product.variants.nodes.length !== 1) throw identityConflict("The original OS single now has additional variants.");
      } else if (!exactOptions(variant, row)) throw identityConflict("The SKU's condition, finish, or language options changed.");
    }
    return matches;
  }
  private verify(product: ProductNode, variant: VariantNode, row: PlannedSingle, previous?: SingleProduct): SingleProduct {
    if (!variant.inventoryItem?.tracked || variant.inventoryPolicy !== "DENY" || product.status === "ARCHIVED") throw identityConflict("Inventory tracking, stock policy, or product status changed.");
    if (product.status === "ACTIVE" && row.priceCents <= 0) throw new SinglesError("PRICE_REQUIRED", "An active Shopify single must keep a sale price greater than zero.");
    const current = { productId: product.id, variantId: variant.id, inventoryItemId: variant.inventoryItem.id, sku: variant.sku || "" };
    if (previous && (current.productId !== previous.productId || current.variantId !== previous.variantId || current.inventoryItemId !== previous.inventoryItemId || current.sku !== previous.sku)) throw identityConflict("The reserved receipt now refers to a different Shopify inventory item.");
    return current;
  }
  private async mapping(row: PlannedSingle, previous?: SingleProduct): Promise<{ found: SingleProduct | null; product?: ProductNode }> {
    const products = await this.allProducts(row);
    // Exact evidence only: existing app identity, storefront catalog metadata, or canonical SKU.
    const candidates = [...products.values()].filter(product => product.catalogId?.value === row.catalogId || product.catalogId?.value === printingId(row) || product.storefrontCatalogId?.value === String(row.card.productId) || product.variants.nodes.some(variant => (variant.sku || "").startsWith(`DEFY-RFB-${row.card.productId}-`) || variant.sku === oldSku(row)) || (this.isLegacy(row) && product.id === LEGACY_DEFY_MAPPING.productId));
    // Defy's original normal/NM listing intentionally coexists with its newer grouped foil/condition product.
    const containers = candidates.filter(product => !(this.isLegacy(row) && product.id !== LEGACY_DEFY_MAPPING.productId && !product.variants.nodes.some(variant => [canonicalSku(row), oldSku(row)].includes(variant.sku))));
    if (containers.length > 1) throw identityConflict("More than one product claims this printing and variant.");
    const matches = candidates.flatMap(product => this.matches(product, row).map(variant => ({ product, variant })));
    if (matches.length > 1) throw identityConflict("More than one Shopify variant matches this card, finish, language, and condition.");
    if (matches.length === 1) return { found: this.verify(matches[0].product, matches[0].variant, row, previous) };
    if (previous) throw new SinglesError("PRODUCT_MISSING", "The reserved Shopify variant was removed or remapped. Keep this receipt for owner review.", false, true);
    if (this.isLegacy(row)) throw identityConflict("The verified original Defy listing is missing.");
    if (candidates.length > 1) throw identityConflict("More than one product claims this printing.");
    const product = candidates[0];
    if (product && ((product.catalogId?.value && ![row.catalogId, printingId(row)].includes(product.catalogId.value)) || (product.storefrontCatalogId?.value && product.storefrontCatalogId.value !== String(row.card.productId)))) throw identityConflict("The product's catalog mapping conflicts with its SKU.");
    if (product?.catalogId?.value === row.catalogId) throw identityConflict("The existing OS product no longer has its reserved SKU.");
    return { found: null, product };
  }
  /** Read-only, fail-closed lookup for connection checks and reconciliation previews. */
  async lookupExisting(row: PlannedSingle, previous?: SingleProduct): Promise<SingleProduct | null> {
    return (await this.mapping(row, previous)).found;
  }
  async resolve(row: PlannedSingle, context: SinglesContext, previous?: SingleProduct): Promise<SingleProduct> {
    const mapping = await this.mapping(row, previous);
    if (mapping.found) return mapping.found;
    let product = mapping.product;
    if (!product) {
      const card = row.card;
      const title = `${card.name} — ${card.setName}${card.number ? ` (${card.setCode} ${card.number})` : ""}`;
      const image = fullSizeImage(row);
      const fields = { name: card.name, game: "Riftbound", set: card.setName, set_code: card.setCode, number: card.number, rarity: card.rarity };
      // productCreate + a unique app-owned identifier refuses conflicts; unlike productSet it cannot replace an existing product's variants.
      this.catalogCache.delete(row.card.productId);
      const data = await this.graphql<{ productCreate: Payload & { product: { id: string } | null } }>(`mutation SinglesCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) { productCreate(product: $product, media: $media) { product { id } userErrors { message } } }`, {
        product: { title, status: "DRAFT", vendor: "Riot Games", productType: "Riftbound single", tags: ["Riftbound", "Singles", "English", card.setName, `defy-catalog-${card.productId}`],
          descriptionHtml: `<p>${html(card.name)} · ${html(card.setName)}${card.number ? ` · ${html(card.number)}` : ""}</p>`,
          productOptions: optionsFor(row).map(option => ({ name: option.name, values: [{ name: option.value }] })),
          metafields: [{ namespace: context.receivingNamespace, key: "catalog_id", type: "single_line_text_field", value: printingId(row) }, { namespace: "defy_intake", key: "catalog_id", type: "single_line_text_field", value: String(card.productId) },
            ...Object.entries(fields).filter(([, value]) => value).map(([key, value]) => ({ namespace: "card", key, type: "single_line_text_field", value }))] },
        media: image ? [{ originalSource: image, mediaContentType: "IMAGE", alt: title }] : [],
      });
      if (data.productCreate?.product?.id) product = (await this.productById(data.productCreate.product.id))!;
      else {
        // A concurrent create can lose the unique-ID race. Resolve its identity without overwriting it.
        product = (await this.catalogProduct(printingId(row)))!;
        if (!product) check(data.productCreate, "Creating the singles draft");
      }
      this.catalogCache.delete(row.card.productId);
      if (!product) throw new SinglesError("PRODUCT_UNCERTAIN", "The created product could not be confirmed. Retry this receipt.", true, true);
    }
    if (product.status === "ARCHIVED" || product.options?.length !== 3 || !["Condition", "Finish", "Language"].every(name => product.options?.some(option => option.name === name))) throw identityConflict("This printing needs its Shopify options reviewed before adding a variant.");
    if (product.status === "ACTIVE" && row.priceCents <= 0) throw new SinglesError("PRICE_REQUIRED", "An active Shopify single must keep a sale price greater than zero.");
    const found = this.matches(product, row);
    if (found.length > 1) throw identityConflict("The printing contains duplicate mapped variants.");
    if (found.length === 1) return this.verify(product, found[0], row);
    const optionMatches = product.variants.nodes.filter(variant => exactOptions(variant, row));
    const initial = optionMatches.length === 1 && product.variants.nodes.length === 1 && product.status === "DRAFT" && product.catalogId?.value === printingId(row) && !optionMatches[0].sku && optionMatches[0].inventoryQuantity === 0 ? optionMatches[0] : null;
    if (optionMatches.length && !initial) throw identityConflict("The intended condition and finish already exist with a different SKU.");
    this.catalogCache.delete(row.card.productId);
    const variantInput = { barcode: canonicalSku(row), price: money(row.priceCents), inventoryPolicy: "DENY", inventoryItem: { sku: canonicalSku(row), tracked: true, cost: money(row.costCents), requiresShipping: true } };
    if (initial) {
      const data = await this.graphql<{ productVariantsBulkUpdate: Payload }>(`mutation SinglesInitializeVariant($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $id, variants: $variants) { userErrors { code message } } }`, { id: product.id, variants: [{ ...variantInput, id: initial.id }] });
      check(data.productVariantsBulkUpdate, "Preparing the new single variant");
    } else {
      const data = await this.graphql<{ productVariantsBulkCreate: Payload }>(`mutation SinglesAddVariant($id: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkCreate(productId: $id, variants: $variants) { userErrors { code message } } }`, { id: product.id, variants: [{ ...variantInput, optionValues: optionsFor(row).map(option => ({ optionName: option.name, name: option.value })) }] });
      check(data.productVariantsBulkCreate, "Adding the single variant");
    }
    this.catalogCache.delete(row.card.productId);
    const confirmed = await this.productById(product.id);
    const confirmedVariants = confirmed ? this.matches(confirmed, row) : [];
    if (!confirmed || confirmedVariants.length !== 1) throw new SinglesError("PRODUCT_UNCERTAIN", "The created variant could not be confirmed. Retry the same receipt.", true, true);
    return this.verify(confirmed, confirmedVariants[0], row);
  }
  async metadata(row: PlannedSingle, item: SingleProduct) {
    const card = row.card;
    const fields: Record<string, string> = { name: card.name, game: "Riftbound", set: card.setName, set_code: card.setCode, number: card.number, rarity: card.rarity };
    // Retain old single-variant options while exposing their finish/condition to the storefront.
    if (item.sku === oldSku(row)) Object.assign(fields, { condition: row.condition, finish: card.finish === "Normal" ? "Nonfoil" : card.finish, language: "English" });
    const metadata = await this.graphql<{ productUpdate: Payload & { product: { id: string } | null } }>(`mutation SinglesStorefrontMetadata($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { message } }
    }`, { product: { id: item.productId, productType: "Riftbound single", metafields: Object.entries(fields).filter(([, value]) => value).map(([key, value]) => ({ namespace: "card", key, type: "single_line_text_field", value })) } });
    check(metadata.productUpdate, "Saving storefront card metadata");
    if (metadata.productUpdate.product?.id !== item.productId) throw new SinglesError("PRODUCT_UNCERTAIN", "The storefront metadata could not be confirmed. Retry this receipt.", true, true);
    const data = await this.graphql<{ productVariantsBulkUpdate: Payload & { productVariants: { id: string }[] } }>(`mutation SinglesPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { code message } }
    }`, { productId: item.productId, variants: [{ id: item.variantId, price: money(row.priceCents), inventoryItem: { cost: money(row.costCents) } }] });
    check(data.productVariantsBulkUpdate, "Saving the single's sale price and unit cost");
    if (!data.productVariantsBulkUpdate.productVariants.some(variant => variant.id === item.variantId)) throw new SinglesError("PRODUCT_UNCERTAIN", "The card's price could not be confirmed. Retry its receipt.", true, true);
  }
  async activate(row: ReceiptRow, context: SinglesContext, requestId: string, index: number) {
    const item = row.product!;
    const data = await this.graphql<{ inventoryItem: { inventoryLevel: { id: string } | null } | null }>(`query SinglesStockLocation($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) { inventoryLevel(locationId: $locationId) { id } }
    }`, { id: item.inventoryItemId, locationId: context.locationId });
    if (data.inventoryItem?.inventoryLevel) return;
    const activation = await this.graphql<{ inventoryActivate: Payload & { inventoryLevel: { id: string } | null } }>(`mutation SinglesActivate($inventoryItemId: ID!, $locationId: ID!, $key: String!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $key) { inventoryLevel { id } userErrors { message } }
    }`, { inventoryItemId: item.inventoryItemId, locationId: context.locationId, key: `singles-activate-${requestId}-${index}` });
    check(activation.inventoryActivate, "Activating the single at the receiving location");
    if (!activation.inventoryActivate.inventoryLevel) throw new SinglesError("ACTIVATION_UNCERTAIN", "Card inventory activation could not be confirmed. Retry its receipt.", true, true);
  }
  async adjust(row: ReceiptRow, context: SinglesContext, requestId: string, index: number) {
    const data = await this.graphql<{ inventoryAdjustQuantities: Payload & { inventoryAdjustmentGroup: { id: string } | null } }>(`mutation SinglesReceive($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { message } }
    }`, { key: `singles-receive-${requestId}-${index}`, input: { name: "available", reason: "received", referenceDocumentUri: `gid://defy-singles/Receipt/${requestId}/${index}`,
      changes: [{ inventoryItemId: row.product!.inventoryItemId, locationId: context.locationId, delta: row.quantity, changeFromQuantity: null }] } });
    const payload = data.inventoryAdjustQuantities;
    if (payload?.userErrors?.length) {
      const message = `Adding singles inventory: ${payload.userErrors.map(error => error.message).join("; ")}`;
      if (!payload.inventoryAdjustmentGroup?.id) throw new SinglesError("ADJUSTMENT_REJECTED", message);
      throw new SinglesError("ADJUSTMENT_UNCERTAIN", `${message} Shopify also returned an adjustment; keep this receipt for review.`, false, true);
    }
    check(payload, "Adding singles inventory");
    return data.inventoryAdjustQuantities.inventoryAdjustmentGroup?.id ?? "";
  }
  async publish(row: ReceiptRow, context: SinglesContext) {
    if (row.priceCents <= 0 || context.publicationIds.length !== 3 || !row.adjustmentId) throw new SinglesError("PUBLISH_BLOCKED", "Confirm stock, a positive sale price, and all three sales channels before publishing.");
    const current = await this.productById(row.product!.productId);
    if (!current) throw new SinglesError("PRODUCT_MISSING", "The received card is missing. Review its receipt before publishing.", false, true);
    const variants = this.matches(current, row);
    if (variants.length !== 1) throw identityConflict("The received variant changed before publication.");
    this.verify(current, variants[0], row, row.product);
    if (current.variants.nodes.some(variant => variant.inventoryQuantity > 0 && !(Number(variant.price) > 0))) throw new SinglesError("PRICE_REQUIRED", "Another stocked variant of this Shopify product has no positive sale price. Review every stocked variant before publishing the product.");
    if (!(Number(variants[0].price) > 0)) throw new SinglesError("PRICE_REQUIRED", "The Shopify card's current sale price must be greater than zero before publishing.");
    const active = await this.graphql<{ productUpdate: Payload & { product: { id: string } | null } }>(`mutation SinglesMakeActive($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { message } }
    }`, { product: { id: row.product!.productId, status: "ACTIVE" } });
    check(active.productUpdate, "Activating the single for sale");
    const published = await this.graphql<{ publishablePublish: Payload }>(`mutation SinglesPublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { message } }
    }`, { id: row.product!.productId, input: context.publicationIds.map(publicationId => ({ publicationId })) });
    check(published.publishablePublish, "Publishing to Online Store, Point of Sale, and the Defy website");
    const verified = await this.graphql<{ product: { status: string; online: boolean; pos: boolean; website: boolean } | null }>(`query SinglesPublished($id: ID!, $online: ID!, $pos: ID!, $website: ID!) {
      product(id: $id) { status online: publishedOnPublication(publicationId: $online) pos: publishedOnPublication(publicationId: $pos) website: publishedOnPublication(publicationId: $website) }
    }`, { id: row.product!.productId, online: context.publicationIds[0], pos: context.publicationIds[1], website: context.publicationIds[2] });
    if (verified.product?.status !== "ACTIVE" || !verified.product.online || !verified.product.pos || !verified.product.website) throw new SinglesError("PUBLICATION_UNCERTAIN", "Stock was received, but all three sales channels have not confirmed publication. Retry the same receipt.", true, true);
  }
}

export async function createShopifyGraphQL() {
  const settings = config();
  return { ...await transport(settings), settings };
}

export async function createSinglesAdapter(): Promise<ShopifySinglesAdapter> {
  const client = await createShopifyGraphQL();
  const settings = client.settings;
  return new ShopifySinglesAdapter(client.graphql, settings, client.clock);
}
export async function getSinglesConnectionStatus(): Promise<SinglesConnectionStatus> {
  try { return (await (await createSinglesAdapter()).inspect()).status; }
  catch (error) {
    const message = error instanceof SinglesError ? error.message : "Shopify connection could not be checked.";
    return { configured: Boolean(process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET && process.env.SHOPIFY_LOCATION_ID), ready: false, shop: process.env.SHOPIFY_SHOP_DOMAIN ?? "", locationId: process.env.SHOPIFY_LOCATION_ID ?? "", locationName: "", currencyCode: "USD", canPublish: false, blockers: [message], publicationBlockers: [] };
  }
}
