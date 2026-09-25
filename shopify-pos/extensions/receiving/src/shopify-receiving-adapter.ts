import {RECEIVING, type Adjustment, type TerminalRecord, type JournalState, type Plan, type Product, type ReceivingAdapter, type StateSnapshot, validateExisting} from './receiving-service.ts';
import {barcodeAliases, barcodeKey, money, ReceivingError, stableJson, validBarcode} from './receiving-validation.ts';
import {receivingCardMetadata, receivingCatalogKey, RECEIVING_CATALOG_GAMES, type CatalogReference} from './receiving-catalog.ts';

type Json = Record<string, any>;
export type GraphQL = <T = Json>(query: string, variables?: Json) => Promise<T>;

export const directGraphQL: GraphQL = async <T = Json>(query: string, variables: Json = {}): Promise<T> => {
  const response = await fetch(`shopify:admin/api/${RECEIVING.apiVersion}/graphql.json`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query, variables}),
  });
  if (!response.ok) throw new ReceivingError('SHOPIFY_UNAVAILABLE', `Shopify returned HTTP ${response.status}. Retry the same receipt.`, true, true);
  const body = await response.json();
  if (body.errors?.length) {
    const code = body.errors[0]?.extensions?.code || 'GRAPHQL_ERROR';
    const mismatch = code === 'IDEMPOTENCY_KEY_PARAMETER_MISMATCH';
    throw new ReceivingError(code, body.errors.map((e: Json) => e.message).join('; '), !mismatch, true);
  }
  if (!body.data) throw new ReceivingError('SHOPIFY_UNAVAILABLE', 'Shopify did not return a complete response. Retry the same receipt.', true, true);
  return body.data as T;
};

const variantFields = () => `
  id sku barcode title price
  inventoryItem { id tracked }
  unit: metafield(namespace: "${RECEIVING.namespace}", key: "${RECEIVING.unitKey}") { value compareDigest }
  game: metafield(namespace: "${RECEIVING.namespace}", key: "${RECEIVING.gameKey}") { value compareDigest }
  barcodeId: metafield(namespace: "${RECEIVING.namespace}", key: "${RECEIVING.barcodeIdKey}") { value compareDigest }
  product { id title status catalogId: metafield(namespace: "${RECEIVING.namespace}", key: "${RECEIVING.catalogIdKey}") { value } }
`;

function product(node: Json): Product {
  if (!node?.id || !node.inventoryItem?.id || !node.product?.id) throw new ReceivingError('CATALOG_INVALID', 'Shopify returned an incomplete product identity.');
  const barcode = node.barcode || '';
  return {
    variantId: node.id, productId: node.product.id, inventoryItemId: node.inventoryItem.id,
    sku: node.sku || '', barcode, name: node.title && node.title !== 'Default Title' ? `${node.product.title} — ${node.title}` : node.product.title,
    game: node.game?.value || '', unit: node.unit?.value || '', tracked: node.inventoryItem.tracked,
    status: node.product.status, catalogId: node.product.catalogId?.value || '', barcodeId: node.barcodeId?.value || '',
    barcodeNeedsReview: Boolean(barcode && !validBarcode(barcode)),
    ...(typeof node.price === 'string' ? {price: money(node.price, 'Store price')} : {}),
  };
}

function userErrors(payload: Json, action: string): void {
  if (!payload) throw new ReceivingError('SHOPIFY_UNAVAILABLE', `${action} returned no result. Keep the same receipt.`, true, true);
  if (payload.userErrors?.length) throw new ReceivingError('SHOPIFY_REJECTED', `${action}: ${payload.userErrors.map((e: Json) => e.message).join('; ')}`, false, false);
}
function searchQuote(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

export class ShopifyReceivingAdapter implements ReceivingAdapter {
  private shopId = '';
  private writeNamespace = '';
  readonly graphql: GraphQL;
  constructor(graphql: GraphQL = directGraphQL) { this.graphql = graphql; }

  async readState(): Promise<StateSnapshot> {
    const data = await this.graphql(`query ReceivingState {
      shop { id currencyCode metafield(namespace: "${RECEIVING.namespace}", key: "${RECEIVING.stateKey}") { value compareDigest namespace } }
    }`);
    this.shopId = data.shop.id;
    const field = data.shop.metafield;
    if (/^app--\d+--receiving$/.test(field?.namespace || '')) this.writeNamespace = field.namespace;
    let state: JournalState | null = null;
    try { state = field ? JSON.parse(field.value) : null; } catch { throw new ReceivingError('STATE_INVALID', 'The receiving transaction journal is damaged. Do not reset it.', false, true); }
    return {shopId: data.shop.id, currencyCode: data.shop.currencyCode, digest: field?.compareDigest || null, state};
  }

  async compareAndSet(snapshot: StateSnapshot, state: JournalState): Promise<boolean> {
    const data = await this.graphql(`mutation ReceivingCAS($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { compareDigest } userErrors { code field message } }
    }`, {metafields: [{ownerId: snapshot.shopId, namespace: RECEIVING.namespace, key: RECEIVING.stateKey,
      type: 'json', value: stableJson(state), compareDigest: snapshot.digest}]});
    const errors = data.metafieldsSet?.userErrors || [];
    if (errors.length && errors.every((e: Json) => ['INVALID_COMPARE_DIGEST', 'STALE_OBJECT', 'TAKEN'].includes(e.code))) return false;
    userErrors(data.metafieldsSet, 'Saving the receipt transaction');
    if (!data.metafieldsSet.metafields?.length) throw new ReceivingError('CAS_UNCERTAIN', 'The transaction save could not be confirmed.', true, true);
    return true;
  }

  async serverNow(): Promise<number> {
    if (!this.shopId) await this.readState();
    // Shopify's server timestamp, not a potentially incorrect iPad clock, gates retries.
    const data = await this.graphql(`mutation ReceivingClock($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { updatedAt } userErrors { code field message } }
    }`, {metafields: [{ownerId: this.shopId, namespace: RECEIVING.namespace, key: RECEIVING.clockKey,
      type: 'single_line_text_field', value: `${Date.now()}-${Math.random().toString(36).slice(2)}`} ]});
    userErrors(data.metafieldsSet, 'Checking the Shopify server clock');
    const time = Date.parse(data.metafieldsSet.metafields?.[0]?.updatedAt || '');
    if (!Number.isFinite(time)) throw new ReceivingError('CLOCK_UNAVAILABLE', 'Shopify server time could not be verified. Keep this receipt pending.', true, true);
    return time;
  }

  async readRecord(kind: 'intent' | 'applied', requestId: string): Promise<Plan | TerminalRecord | null> {
    const type = kind === 'intent' ? RECEIVING.intentType : RECEIVING.appliedType;
    const data = await this.graphql(`query ReceivingRecord($handle: MetaobjectHandleInput!) {
      metaobjectByHandle(handle: $handle) { id field(key: "payload") { value } }
    }`, {handle: {type, handle: requestId}});
    if (!data.metaobjectByHandle) return null;
    try {
      const value = JSON.parse(data.metaobjectByHandle.field?.value || '');
      if (!value || value.version !== 1) throw new Error('version');
      return value;
    } catch { throw new ReceivingError('RECEIPT_INVALID', 'The saved receipt record is incomplete or damaged. Keep its request ID for owner review.', false, true); }
  }

  async createRecord(kind: 'intent' | 'applied', requestId: string, value: Plan | TerminalRecord): Promise<void> {
    const existing = await this.readRecord(kind, requestId);
    if (existing) {
      if (stableJson(existing) !== stableJson(value)) throw new ReceivingError('RECEIPT_CONFLICT', 'The immutable receipt record differs from this transaction. Keep the request ID for review.', false, true);
      return;
    }
    const data = await this.graphql(`mutation CreateReceivingRecord($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) { metaobject { id } userErrors { code field message } }
    }`, {metaobject: {type: kind === 'intent' ? RECEIVING.intentType : RECEIVING.appliedType, handle: requestId,
      fields: [{key: 'payload', value: stableJson(value)}]}});
    if (data.metaobjectCreate?.userErrors?.length) {
      // Another device may have created the exact immutable handle concurrently.
      const raced = await this.readRecord(kind, requestId);
      if (raced && stableJson(raced) === stableJson(value)) return;
    }
    userErrors(data.metaobjectCreate, 'Recording the receipt');
    if (!data.metaobjectCreate.metaobject?.id) throw new ReceivingError('RECEIPT_UNCERTAIN', 'The receipt record could not be confirmed.', true, true);
  }

  async location(id: string) {
    const data = await this.graphql(`query ReceivingLocation($id: ID!) { location(id: $id) { id name isActive } }`, {id});
    if (!data.location) throw new ReceivingError('LOCATION_INVALID', 'The saved POS location was not found.');
    return {id: data.location.id, name: data.location.name, active: data.location.isActive};
  }

  private async variants(query: string, limit = 100): Promise<{products: Product[]; hasMore: boolean}> {
    const data = await this.graphql(`query ReceivingVariants($query: String!, $first: Int!) {
      productVariants(first: $first, query: $query) { nodes { ${variantFields()} } pageInfo { hasNextPage } }
    }`, {query, first: limit});
    return {products: data.productVariants.nodes.map(product), hasMore: data.productVariants.pageInfo.hasNextPage};
  }

  async findByBarcode(barcode: string): Promise<Product[]> {
    const key = barcodeKey(barcode);
    const direct = await this.graphql(`query ReceivingBarcodeId($identifier: ProductVariantIdentifierInput!) {
      productVariantByIdentifier(identifier: $identifier) { ${variantFields()} }
    }`, {identifier: {customId: {namespace: RECEIVING.namespace, key: RECEIVING.barcodeIdKey, value: key}}});
    const matched = direct.productVariantByIdentifier ? product(direct.productVariantByIdentifier) : null;
    if (matched && validBarcode(matched.barcode) && barcodeKey(matched.barcode) !== key) throw new ReceivingError('BARCODE_ID_CONFLICT', 'The registered barcode points to a changed Shopify barcode. Ask the owner to review the identity.', false, true);
    const result = await this.variants(barcodeAliases(barcode).map(value => `barcode:${searchQuote(value)}`).join(' OR '));
    if (result.hasMore) throw new ReceivingError('AMBIGUOUS_CATALOG', 'Too many variants match this barcode. Resolve the catalog before receiving.');
    const found = result.products.filter(p => validBarcode(p.barcode) && barcodeKey(p.barcode) === key);
    if (matched && !found.some(p => p.variantId === matched.variantId)) found.push(matched);
    return found;
  }

  async findBySku(sku: string): Promise<Product[]> {
    const result = await this.variants(`sku:${searchQuote(sku)}`);
    if (result.hasMore) throw new ReceivingError('AMBIGUOUS_CATALOG', 'Too many variants match this SKU. Resolve the catalog before receiving.');
    return result.products.filter(p => p.sku === sku);
  }

  async search(query: string) {
    // Shopify's default full-text search spans product/variant fields. Exact SKU is explicit.
    const result = await this.variants(`${searchQuote(query)} OR sku:${searchQuote(query)}`, 21);
    return {products: result.products.slice(0, 20), hasMore: result.hasMore || result.products.length > 20};
  }

  private async variant(id: string): Promise<{product: Product; node: Json}> {
    const data = await this.graphql(`query ReceivingVariant($id: ID!) { productVariant(id: $id) { ${variantFields()} } }`, {id});
    if (!data.productVariant) throw new ReceivingError('PRODUCT_MISSING', 'The reserved Shopify variant was removed. Ask the owner to review the pending receipt.', false, true);
    return {product: product(data.productVariant), node: data.productVariant};
  }

  async stockProduct(variantId: string): Promise<Product> { return (await this.variant(variantId)).product; }

  async readAvailable(item: Product, locationId: string): Promise<number> {
    const data = await this.graphql(`query ReceivingAvailable($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) { id tracked inventoryLevel(locationId: $locationId) { id quantities(names: ["available"]) { name quantity } } }
    }`, {id: item.inventoryItemId, locationId});
    const current = data.inventoryItem;
    if (!current || current.id !== item.inventoryItemId || current.tracked !== true || !Object.hasOwn(current, 'inventoryLevel')) throw new ReceivingError('STOCK_UNAVAILABLE', 'Shopify could not confirm this product’s tracked inventory. Refresh its stock before saving.');
    // An existing tracked item not yet stocked at this location starts at zero.
    // A missing item, missing field, or malformed quantity must never become zero.
    if (current.inventoryLevel === null) return 0;
    const level = current.inventoryLevel;
    const values = level?.quantities;
    if (!level?.id || !Array.isArray(values) || values.length !== 1 || values[0]?.name !== 'available' || !Number.isSafeInteger(values[0].quantity) || values[0].quantity < -2147483648 || values[0].quantity > 2147483647) throw new ReceivingError('STOCK_UNAVAILABLE', 'Shopify did not return a valid available count. Refresh its stock before saving.');
    return values[0].quantity;
  }

  async findByCatalog(catalog: CatalogReference): Promise<Product | null> {
    return this.catalogProduct(receivingCatalogKey(catalog));
  }

  private async catalogProduct(catalogId: string, draftPlan?: Plan): Promise<Product | null> {
    const expectedCatalog = draftPlan?.request.catalog;
    const cardFields = expectedCatalog ? `productType ${Object.keys(receivingCardMetadata(expectedCatalog)).map(key => `card_${key}: metafield(namespace: "card", key: "${key}") { value compareDigest }`).join(' ')}` : '';
    const query = `query ReceivingCatalogId($identifier: ProductIdentifierInput!) {
      productByIdentifier(identifier: $identifier) { id ${cardFields} variants(first: 2) { nodes { ${variantFields()} } pageInfo { hasNextPage } } }
    }`;
    const variables = {identifier: {customId: {namespace: RECEIVING.namespace, key: RECEIVING.catalogIdKey, value: catalogId}}};
    let item = (await this.graphql(query, variables)).productByIdentifier;
    if (!item) return null;
    const verifyIdentity = (node: Json): Product => {
      if (!node || node.variants.nodes.length !== 1 || node.variants.pageInfo.hasNextPage) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'This receiving catalog ID belongs to a product with a changed variant structure.', false, true);
      const current = product(node.variants.nodes[0]);
      if (draftPlan && (current.catalogId !== catalogId || current.sku !== draftPlan.plannedSku ||
        !validBarcode(current.barcode) || barcodeKey(current.barcode) !== barcodeKey(draftPlan.request.barcode) ||
        current.barcodeId !== barcodeKey(draftPlan.request.barcode) || current.unit !== draftPlan.request.unit ||
        current.game !== draftPlan.request.game || current.name !== draftPlan.request.name || !current.tracked || current.status !== 'DRAFT')) {
        throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The existing draft does not match this reserved SKU and receipt. No identity was overwritten.', false, true);
      }
      if (expectedCatalog && node.productType !== `${RECEIVING_CATALOG_GAMES[expectedCatalog.game]} Sealed`) {
        throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The saved catalog product type changed. Keep this receipt for review.', false, true);
      }
      return current;
    };
    const current = verifyIdentity(item);
    if (!expectedCatalog) return current;
    const expected = Object.entries(receivingCardMetadata(expectedCatalog));
    const missing: Json[] = [];
    for (const [key, value] of expected) {
      const field = item[`card_${key}`];
      if (field && field.value !== value) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The saved catalog metadata changed. Keep this receipt for review; no existing metadata was overwritten.', false, true);
      if (!field) missing.push({ownerId: current.productId, namespace: 'card', key, type: 'single_line_text_field', value, compareDigest: null});
    }
    if (!missing.length) return current;
    // productSet creates the custom ID itself. Complete descriptive metadata in
    // a separate resumable step: only this reserved draft, only absent fields.
    const completed = await this.graphql(`mutation CompleteReceivingCatalogMetadata($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { code field message } }
    }`, {metafields: missing});
    userErrors(completed.metafieldsSet, 'Saving the sealed product details');
    item = (await this.graphql(query, variables)).productByIdentifier;
    const verified = verifyIdentity(item);
    if (verified.productId !== current.productId || verified.variantId !== current.variantId ||
      expected.some(([key, value]) => item[`card_${key}`]?.value !== value)) {
      throw new ReceivingError('PRODUCT_UNCERTAIN', 'The sealed product details could not be confirmed. Retry this same receipt.', true, true);
    }
    return verified;
  }

  async resolveProduct(plan: Plan): Promise<Product> {
    const request = plan.request;
    if (plan.before) {
      const current = await this.variant(plan.before.variantId);
      if (current.product.sku !== plan.plannedSku || current.product.productId !== plan.before.productId || current.product.inventoryItemId !== plan.before.inventoryItemId) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The reserved Shopify product identity changed. No substitute variant was used.', false, true);
      if (request.catalog && current.product.catalogId !== receivingCatalogKey(request.catalog)) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The selected catalog mapping changed. No source identity was overwritten.', false, true);
      validateExisting(current.product, request);
      const matches = await this.findByBarcode(request.barcode);
      if (matches.some(p => p.variantId !== current.product.variantId)) throw new ReceivingError('BARCODE_CONFLICT', 'Another Shopify variant now owns this barcode.', false, true);
      const metafields: Json[] = [];
      if (current.product.barcodeId && current.product.barcodeId !== barcodeKey(request.barcode)) throw new ReceivingError('BARCODE_ID_CONFLICT', 'This variant is registered to another canonical barcode.', false, true);
      if (!current.product.barcodeId) metafields.push({ownerId: current.product.variantId, namespace: RECEIVING.namespace,
        key: RECEIVING.barcodeIdKey, type: 'id', value: barcodeKey(request.barcode), compareDigest: current.node.barcodeId?.compareDigest || null});
      for (const key of ['unit', 'game'] as const) {
        if (!current.product[key]) metafields.push({ownerId: current.product.variantId, namespace: RECEIVING.namespace,
          key: RECEIVING[key === 'unit' ? 'unitKey' : 'gameKey'], type: 'single_line_text_field', value: request[key], compareDigest: current.node[key]?.compareDigest || null});
      }
      if (metafields.length) {
        const data = await this.graphql(`mutation ConfirmReceivingUnit($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { metafields { id } userErrors { code field message } }
        }`, {metafields});
        userErrors(data.metafieldsSet, 'Confirming the package unit');
      }
      // Claim the unique direct-lookup ID before binding the native barcode. If
      // this write times out, another device can resolve the claim immediately.
      if (!current.product.barcode || !validBarcode(current.product.barcode)) {
        const data = await this.graphql(`mutation BindReceivingBarcode($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { code field message } }
        }`, {productId: current.product.productId, variants: [{id: current.product.variantId, barcode: request.barcode}]});
        userErrors(data.productVariantsBulkUpdate, 'Registering the verified barcode');
      }
      const verified = (await this.variant(current.product.variantId)).product;
      if (verified.barcodeId !== barcodeKey(request.barcode)) throw new ReceivingError('BARCODE_ID_CONFLICT', 'The verified barcode registration could not be confirmed.', false, true);
      return verified;
    }

    const barcodeId = barcodeKey(request.barcode);
    const catalogId = request.catalog ? receivingCatalogKey(request.catalog) : barcodeId;
    const existing = await this.catalogProduct(catalogId, plan);
    if (existing) {
      // Recovery can finish absent metadata on this reserved draft, never replace it.
      if (existing.sku !== plan.plannedSku || barcodeKey(existing.barcode) !== barcodeId || existing.barcodeId !== barcodeId || existing.unit !== request.unit || existing.game !== request.game || existing.name !== request.name) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The existing product does not match this reserved SKU and receipt. No identity was overwritten.', false, true);
      return existing;
    }
    if ((await this.findByBarcode(request.barcode)).length || (await this.findBySku(plan.plannedSku)).length) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The reserved barcode or SKU was assigned outside this pending transaction. Ask the owner to review it.', false, true);
    // Resolve the actual app namespace. Let productSet create its custom ID;
    // sending product metafields here triggers Shopify's customId mismatch check.
    if (!this.writeNamespace) await this.readState();
    if (!this.writeNamespace) throw new ReceivingError('SETUP_REQUIRED', 'The app-owned receiving namespace could not be resolved.', false, true);
    const namespace = this.writeNamespace;
    const input = {
      title: request.name, status: 'DRAFT',
      ...(request.catalog ? {productType: `${RECEIVING_CATALOG_GAMES[request.catalog.game]} Sealed`} : {}),
      productOptions: [{name: 'Title', values: [{name: 'Default Title'}]}],
      variants: [{sku: plan.plannedSku, barcode: request.barcode,
        optionValues: [{optionName: 'Title', name: 'Default Title'}], inventoryItem: {tracked: true}, inventoryPolicy: 'DENY',
        metafields: [
          {namespace, key: RECEIVING.barcodeIdKey, type: 'id', value: barcodeId},
          {namespace, key: RECEIVING.unitKey, type: 'single_line_text_field', value: request.unit},
          {namespace, key: RECEIVING.gameKey, type: 'single_line_text_field', value: request.game},
        ]}],
    };
    const data = await this.graphql(`mutation CreateReceivingDraft($input: ProductSetInput!, $identifier: ProductSetIdentifiers!) {
      productSet(input: $input, identifier: $identifier, synchronous: true) {
        product { id } userErrors { code field message }
      }
    }`, {input, identifier: {customId: {namespace, key: RECEIVING.catalogIdKey, value: catalogId}}});
    userErrors(data.productSet, 'Creating the draft sealed product');
    const created = await this.catalogProduct(catalogId, plan);
    if (!created) throw new ReceivingError('PRODUCT_UNCERTAIN', 'The new product could not be confirmed. Retry this same receipt.', true, true);
    if (created.sku !== plan.plannedSku || barcodeKey(created.barcode) !== barcodeId || created.barcodeId !== barcodeId || created.unit !== request.unit || created.game !== request.game || created.name !== request.name || !created.tracked || created.status !== 'DRAFT') {
      throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The created Shopify draft does not match its reserved identity. Keep this receipt pending for review.', false, true);
    }
    return created;
  }

  private async priceProduct(item: Product, plan: Plan): Promise<Product> {
    const current = (await this.variant(item.variantId)).product;
    if (current.productId !== item.productId || current.inventoryItemId !== item.inventoryItemId || current.sku !== plan.plannedSku ||
      current.unit !== plan.request.unit || !validBarcode(current.barcode) || barcodeKey(current.barcode) !== barcodeKey(plan.request.barcode) ||
      (plan.request.catalog && current.catalogId !== receivingCatalogKey(plan.request.catalog))) {
      throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The reserved Shopify variant changed before its store price was confirmed. Keep this receipt pending.', false, true);
    }
    validateExisting(current, plan.request);
    if (current.price === undefined || plan.request.storePrice === undefined) throw new ReceivingError('STORE_PRICE_UNAVAILABLE', 'The current store price could not be verified. Keep this receipt pending.', false, true);
    return current;
  }

  async applyStorePrice(item: Product, plan: Plan): Promise<Product> {
    const current = await this.priceProduct(item, plan);
    const price = plan.request.storePrice!;
    if (current.price === price) return current;
    if (item.price === undefined || current.price !== item.price) throw new ReceivingError('STORE_PRICE_CHANGED', 'The Shopify store price changed while receiving. Ask the owner to review this receipt before continuing.', false, true);
    // Send only the absolute selling price. Costs, compare-at prices, inventory,
    // product status, and publication settings are outside this mutation.
    const data = await this.graphql(`mutation SetReceivingStorePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { code field message } }
    }`, {productId: current.productId, variants: [{id: current.variantId, price}]});
    userErrors(data.productVariantsBulkUpdate, 'Saving the store price');
    const updated = data.productVariantsBulkUpdate.productVariants?.find((variant: Json) => variant.id === current.variantId);
    if (typeof updated?.price !== 'string' || money(updated.price, 'Store price') !== price) throw new ReceivingError('STORE_PRICE_UNCERTAIN', 'The store price result could not be confirmed. Retry the same receipt to check Shopify.', true, true);
    return this.confirmStorePrice(item, plan);
  }

  async confirmStorePrice(item: Product, plan: Plan): Promise<Product> {
    const current = await this.priceProduct(item, plan);
    // A timeout may have occurred after Shopify committed, followed by an owner
    // edit. Never repeat the mutation, even if the price equals its old value.
    if (current.price !== plan.request.storePrice) throw new ReceivingError('STORE_PRICE_UNCERTAIN', 'An earlier store price update may have completed, but Shopify now shows a different price. Ask the owner to review this receipt; retrying will not overwrite the current price.', false, true);
    return current;
  }

  async ensureActive(item: Product, plan: Plan): Promise<void> {
    const current = (await this.variant(item.variantId)).product;
    if (current.sku !== plan.plannedSku || current.inventoryItemId !== item.inventoryItemId || !current.tracked) throw new ReceivingError('PRODUCT_IDENTITY_CONFLICT', 'The tracked inventory identity changed. Keep the receipt pending.', false, true);
    const data = await this.graphql(`query ReceivingInventoryLevel($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) { id inventoryLevel(locationId: $locationId) { id } }
    }`, {id: item.inventoryItemId, locationId: plan.request.locationId});
    if (data.inventoryItem?.inventoryLevel?.id) return;
    // Query-before-retry does not reset quantity; an old missing activation needs review.
    if (await this.serverNow() - Date.parse(plan.startedAt) >= RECEIVING.retryWindowMs) throw new ReceivingError('ACTIVATION_REVIEW', 'This old receipt has no active inventory level. Ask the owner to review it before retrying.', false, true);
    const result = await this.graphql(`mutation ActivateReceivingInventory($inventoryItemId: ID!, $locationId: ID!, $idempotencyKey: String!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) @idempotent(key: $idempotencyKey) {
        inventoryLevel { id } userErrors { field message }
      }
    }`, {inventoryItemId: item.inventoryItemId, locationId: plan.request.locationId, idempotencyKey: `activate-${plan.request.requestId}`});
    userErrors(result.inventoryActivate, 'Activating stock at the saved location');
    if (!result.inventoryActivate.inventoryLevel?.id) throw new ReceivingError('ACTIVATION_UNCERTAIN', 'The location activation could not be confirmed.', true, true);
  }

  async adjust(item: Product, plan: Plan): Promise<Adjustment> {
    const referenceDocumentUri = `gid://defy-receiving/Receipt/${plan.request.requestId}`;
    if (plan.request.inventoryMode === 'set') {
      const input = {name: 'available', reason: 'correction', referenceDocumentUri,
        quantities: [{inventoryItemId: item.inventoryItemId, locationId: plan.request.locationId, quantity: plan.request.quantity, changeFromQuantity: plan.request.expectedAvailableQuantity}]};
      const data = await this.graphql(`mutation SetReceivingInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          inventoryAdjustmentGroup { id createdAt referenceDocumentUri } userErrors { code field message }
        }
      }`, {input, idempotencyKey: `set-stock-${plan.request.requestId}`});
      const payload = data.inventorySetQuantities;
      // A stale CAS on a known first attempt is a definite no-write. The service
      // persists that rejection before unlocking; on retries it stays uncertain.
      if (!payload?.inventoryAdjustmentGroup && payload?.userErrors?.length && payload.userErrors.every((error: Json) => error.code === 'CHANGE_FROM_QUANTITY_STALE')) throw new ReceivingError('STOCK_CHANGED', 'Shopify availability changed before the stock total was saved.');
      userErrors(payload, 'Setting the available stock total');
      return payload.inventoryAdjustmentGroup;
    }
    const input = {name: 'available', reason: 'received', referenceDocumentUri,
      // This is a delivery delta, not a stock snapshot. Concurrent POS sales must
      // remain intact. Native idempotency protects the exact one-time increment.
      changes: [{inventoryItemId: item.inventoryItemId, locationId: plan.request.locationId, delta: plan.request.quantity, changeFromQuantity: null}]};
    const data = await this.graphql(`mutation ReceiveInventory($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup { id createdAt referenceDocumentUri } userErrors { field message }
      }
    }`, {input, idempotencyKey: `receive-${plan.request.requestId}`});
    userErrors(data.inventoryAdjustQuantities, 'Receiving inventory');
    return data.inventoryAdjustQuantities.inventoryAdjustmentGroup;
  }
}
