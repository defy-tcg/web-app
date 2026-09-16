// Server module: imported only by API routes and the Node-only intake service.
import { SinglesError, type PlannedSingle, type ReceiptRow, type SingleProduct, type SinglesAdapter, type SinglesConnectionStatus, type SinglesContext, type Snapshot } from "./intake.ts";

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
interface ProductNode {
  id: string; status: string; catalogId: { value: string } | null;
  variants: { nodes: { id: string; sku: string; price: string; inventoryPolicy: string; inventoryItem: { id: string; tracked: boolean } }[]; pageInfo: { hasNextPage: boolean } };
}
const PRODUCT_FIELDS = `id status catalogId: metafield(namespace: "${RECEIVING}", key: "catalog_id") { value }
  variants(first: 2) { nodes { id sku price inventoryPolicy inventoryItem { id tracked } } pageInfo { hasNextPage } }`;
const money = (cents: number) => (cents / 100).toFixed(2);
const html = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export class ShopifySinglesAdapter implements SinglesAdapter {
  private shopId = "";
  private graphql: SinglesGraphQL;
  private settings: { shop: string; locationId: string };
  private clock: () => number;
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
    if (!scopes.has("write_publications")) publicationBlockers.push("The Shopify app needs write_publications permission to publish to Online Store and Point of Sale.");
    else {
      try {
        const publications = await this.graphql<{ publications: { nodes: { id: string; catalog: { title: string } | null }[]; pageInfo: { hasNextPage: boolean } } }>(`query SinglesPublications {
          publications(first: 250, catalogType: APP) { nodes { id catalog { title } } pageInfo { hasNextPage } }
        }`);
        const online = publications.publications.nodes.filter(item => item.catalog?.title === "Online Store");
        const pos = publications.publications.nodes.filter(item => item.catalog?.title === "Point of Sale");
        if (publications.publications.pageInfo.hasNextPage || online.length !== 1 || pos.length !== 1) publicationBlockers.push("Verify exactly one Online Store and one Point of Sale publication in Shopify.");
        else publicationIds = [online[0].id, pos[0].id];
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
  private verify(product: ProductNode, row: PlannedSingle, previous?: SingleProduct): SingleProduct {
    const variant = product.variants.nodes[0];
    if (product.catalogId?.value !== row.catalogId || product.variants.nodes.length !== 1 || product.variants.pageInfo.hasNextPage || variant?.sku !== row.sku || !variant.inventoryItem?.tracked || variant.inventoryPolicy !== "DENY" || product.status === "ARCHIVED") throw new SinglesError("PRODUCT_IDENTITY_CONFLICT", "The Shopify card identity, SKU, variant structure, or stock policy changed. Review it before receiving.", false, true);
    if (product.status === "ACTIVE" && row.priceCents <= 0) throw new SinglesError("PRICE_REQUIRED", "An active Shopify single must keep a sale price greater than zero.");
    const current = { productId: product.id, variantId: variant.id, inventoryItemId: variant.inventoryItem.id, sku: variant.sku };
    if (previous && JSON.stringify(current) !== JSON.stringify(previous)) throw new SinglesError("PRODUCT_IDENTITY_CONFLICT", "The reserved card now refers to a different Shopify inventory item. Keep its receipt for owner review.", false, true);
    return current;
  }
  async resolve(row: PlannedSingle, context: SinglesContext, previous?: SingleProduct): Promise<SingleProduct> {
    const existing = await this.catalogProduct(row.catalogId);
    if (existing) return this.verify(existing, row, previous);
    if (previous) throw new SinglesError("PRODUCT_MISSING", "The reserved card product was removed. Keep its receipt for owner review.", false, true);
    const escapedSku = row.sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const matches = await this.graphql<{ productVariants: { nodes: { id: string; sku: string }[]; pageInfo: { hasNextPage: boolean } } }>(`query SinglesSku($query: String!) {
      productVariants(first: 100, query: $query) { nodes { id sku } pageInfo { hasNextPage } }
    }`, { query: `sku:"${escapedSku}"` });
    if (matches.productVariants.pageInfo.hasNextPage || matches.productVariants.nodes.some(variant => variant.sku === row.sku)) throw new SinglesError("SKU_CONFLICT", "This SKU already exists outside the singles catalog. Resolve its identity before receiving.", false, true);
    const card = row.card;
    const title = `${card.name} — ${card.setName}${card.number ? ` #${card.number}` : ""} — ${card.finish} — ${row.condition} (English)`;
    const file = card.imageUrl && /^https:\/\/(?:product-images|tcgplayer-cdn)\.tcgplayer\.com\//.test(card.imageUrl) ? { originalSource: card.imageUrl, contentType: "IMAGE", alt: title } : null;
    const data = await this.graphql<{ productSet: Payload & { product: { id: string } | null } }>(`mutation SinglesCreate($input: ProductSetInput!, $identifier: ProductSetIdentifiers!) {
      productSet(input: $input, identifier: $identifier, synchronous: true) { product { id } userErrors { code message } }
    }`, { identifier: { customId: { namespace: context.receivingNamespace, key: "catalog_id", value: row.catalogId } }, input: {
      title, status: "DRAFT", vendor: "Riot Games", productType: "Single", tags: ["Riftbound", "Singles", "English", card.setName, card.finish, row.condition],
      descriptionHtml: `<p>${html(card.name)} · ${html(card.setName)}${card.number ? ` · ${html(card.number)}` : ""}</p><p>Finish: ${html(card.finish)}<br>Condition: ${html(row.condition)}<br>Language: English</p>`,
      ...(file ? { files: [file] } : {}), productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
      variants: [{ sku: row.sku, barcode: row.sku, price: money(row.priceCents), inventoryPolicy: "DENY", inventoryItem: { tracked: true, cost: money(row.costCents) },
        optionValues: [{ optionName: "Title", name: "Default Title" }], ...(file ? { file } : {}),
        metafields: [ { namespace: context.receivingNamespace, key: "game", type: "single_line_text_field", value: "Riftbound" }, { namespace: context.receivingNamespace, key: "unit", type: "single_line_text_field", value: "Single" } ] }],
    } });
    check(data.productSet, "Creating the singles draft");
    const created = await this.catalogProduct(row.catalogId);
    if (!created) throw new SinglesError("PRODUCT_UNCERTAIN", "The created card could not be confirmed. Retry the same receipt.", true, true);
    return this.verify(created, row);
  }
  async metadata(row: PlannedSingle, item: SingleProduct) {
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
    if (row.priceCents <= 0 || context.publicationIds.length !== 2 || !row.adjustmentId) throw new SinglesError("PUBLISH_BLOCKED", "Confirm stock, a positive sale price, and both sales channels before publishing.");
    const current = await this.catalogProduct(row.catalogId);
    if (!current) throw new SinglesError("PRODUCT_MISSING", "The received card is missing. Review its receipt before publishing.", false, true);
    this.verify(current, row, row.product);
    if (!(Number(current.variants.nodes[0].price) > 0)) throw new SinglesError("PRICE_REQUIRED", "The Shopify card's current sale price must be greater than zero before publishing.");
    const active = await this.graphql<{ productUpdate: Payload & { product: { id: string } | null } }>(`mutation SinglesMakeActive($product: ProductUpdateInput!) {
      productUpdate(product: $product) { product { id } userErrors { message } }
    }`, { product: { id: row.product!.productId, status: "ACTIVE" } });
    check(active.productUpdate, "Activating the single for sale");
    const published = await this.graphql<{ publishablePublish: Payload }>(`mutation SinglesPublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { message } }
    }`, { id: row.product!.productId, input: context.publicationIds.map(publicationId => ({ publicationId })) });
    check(published.publishablePublish, "Publishing to Online Store and Point of Sale");
    const verified = await this.graphql<{ product: { status: string; online: boolean; pos: boolean } | null }>(`query SinglesPublished($id: ID!, $online: ID!, $pos: ID!) {
      product(id: $id) { status online: publishedOnPublication(publicationId: $online) pos: publishedOnPublication(publicationId: $pos) }
    }`, { id: row.product!.productId, online: context.publicationIds[0], pos: context.publicationIds[1] });
    if (verified.product?.status !== "ACTIVE" || !verified.product.online || !verified.product.pos) throw new SinglesError("PUBLICATION_UNCERTAIN", "Stock was received, but both sales channels have not confirmed publication. Retry the same receipt.", true, true);
  }
}

export async function createSinglesAdapter(): Promise<ShopifySinglesAdapter> {
  const settings = config();
  const client = await transport(settings);
  return new ShopifySinglesAdapter(client.graphql, settings, client.clock);
}
export async function getSinglesConnectionStatus(): Promise<SinglesConnectionStatus> {
  try { return (await (await createSinglesAdapter()).inspect()).status; }
  catch (error) {
    const message = error instanceof SinglesError ? error.message : "Shopify connection could not be checked.";
    return { configured: Boolean(process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET && process.env.SHOPIFY_LOCATION_ID), ready: false, shop: process.env.SHOPIFY_SHOP_DOMAIN ?? "", locationId: process.env.SHOPIFY_LOCATION_ID ?? "", locationName: "", currencyCode: "USD", canPublish: false, blockers: [message], publicationBlockers: [] };
  }
}
