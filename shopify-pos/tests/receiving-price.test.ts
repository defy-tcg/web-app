import assert from 'node:assert/strict';
import test from 'node:test';
import {assertState, normalizeRequest, ReceivingService, type Adjustment, type Applied, type JournalState, type Plan, type Product, type ReceiptInput, type ReceivingAdapter, type StateSnapshot} from '../extensions/receiving/src/receiving-service.ts';
import {barcodeKey, ReceivingError, stableJson} from '../extensions/receiving/src/receiving-validation.ts';
import {ShopifyReceivingAdapter, type GraphQL} from '../extensions/receiving/src/shopify-receiving-adapter.ts';

const input: ReceiptInput = {requestId: 'receipt-price-000001', barcode: '0196214150478', name: 'Perfect Order Booster Bundle', game: 'Pokémon', unit: 'Booster bundle',
  quantity: 2, unitCost: '21.50', supplier: 'Supplier', notes: '', receivedDate: '2026-09-25'};
const request = (changes: Partial<ReceiptInput> = {}) => normalizeRequest({...input, ...changes}, 123);
const item = (changes: Partial<Product> = {}): Product => ({sku: 'DEFY-S-000001', barcode: input.barcode, name: input.name, game: input.game, unit: input.unit,
  productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/2', inventoryItemId: 'gid://shopify/InventoryItem/3', tracked: true,
  status: 'ACTIVE', barcodeNeedsReview: false, price: '29.99', ...changes});
type Json = Record<string, any>;

class MemoryAdapter implements ReceivingAdapter {
  state: JournalState = {version: 1, nextSequence: 1, pending: null};
  revision = 0;
  records = new Map<string, Plan | Applied>();
  products: Product[] = [];
  adjustments = new Map<string, Adjustment>();
  adjustedQuantity = 0;
  calls: {query: string; variables: Json}[] = [];
  priceFailure: 'before' | 'after' | 'changed-after' | 'invalid-response' | null = null;
  failAfterAdjust = false;
  failPriceSave = false;
  failPriceClaim = false;
  beforePriceWrite?: () => Promise<void>;
  beforePriceRead?: () => void;
  priceAdapter = new ShopifyReceivingAdapter((async <T>(query: string, variables: Json = {}): Promise<T> => {
    this.calls.push({query, variables: structuredClone(variables)});
    const current = this.products[0];
    if (query.includes('query ReceivingVariant(')) {
      this.beforePriceRead?.();
      return {productVariant: {id: current.variantId, sku: current.sku, barcode: current.barcode, title: 'Default Title', price: current.price,
        inventoryItem: {id: current.inventoryItemId, tracked: current.tracked}, unit: {value: current.unit}, game: {value: current.game},
        product: {id: current.productId, title: current.name, status: current.status}}} as T;
    }
    assert.match(query, /mutation SetReceivingStorePrice/);
    assert.equal(this.state.pending?.phase, 'price_pending', 'price intent must be durable before the mutation');
    assert.equal(this.adjustedQuantity, 0, 'price must precede stock adjustment');
    assert.deepEqual(variables, {productId: current.productId, variants: [{id: current.variantId, price: this.state.pending!.request.storePrice}]});
    await this.beforePriceWrite?.();
    const failure = this.priceFailure;
    this.priceFailure = null;
    if (failure === 'before') throw new Error('Connection lost before Shopify committed');
    current.price = variables.variants[0].price;
    if (failure === 'after') throw new Error('Lost response after Shopify committed');
    const updated = {id: current.variantId, price: current.price};
    if (failure === 'changed-after') current.price = '45.00';
    return {productVariantsBulkUpdate: {productVariants: failure === 'invalid-response' ? [] : [updated], userErrors: []}} as T;
  }) as GraphQL);
  get priceWrites() { return this.calls.filter(call => call.query.includes('mutation SetReceivingStorePrice')); }
  async serverNow() { return Date.parse('2026-09-25T12:00:00.000Z'); }
  async readState(): Promise<StateSnapshot> { return {shopId: 'gid://shopify/Shop/1', currencyCode: 'USD', digest: String(this.revision), state: structuredClone(this.state)}; }
  async compareAndSet(snapshot: StateSnapshot, state: JournalState) {
    if (snapshot.digest !== String(this.revision)) return false;
    if (state.pending?.phase === 'price_applied' && this.failPriceSave) { this.failPriceSave = false; throw new Error('Price confirmation journal save lost'); }
    this.revision++; this.state = structuredClone(state);
    if (state.pending?.phase === 'price_pending' && this.failPriceClaim) { this.failPriceClaim = false; throw new Error('Price intent save response lost'); }
    return true;
  }
  async readRecord(kind: 'intent' | 'applied', id: string) { return structuredClone(this.records.get(`${kind}:${id}`) || null); }
  async createRecord(kind: 'intent' | 'applied', id: string, value: Plan | Applied) {
    const key = `${kind}:${id}`;
    const existing = this.records.get(key);
    if (existing) assert.equal(stableJson(existing), stableJson(value));
    else this.records.set(key, structuredClone(value));
  }
  async location(id: string) { return {id, name: 'Shop', active: true}; }
  async findByBarcode(barcode: string) { return structuredClone(this.products.filter(product => barcodeKey(product.barcode) === barcodeKey(barcode))); }
  async findBySku(sku: string) { return structuredClone(this.products.filter(product => product.sku === sku)); }
  async findByCatalog() { return null; }
  async search() { return {products: structuredClone(this.products), hasMore: false}; }
  async resolveProduct(p: Plan) {
    if (p.before) return structuredClone(p.before);
    const product = item({sku: p.plannedSku, barcode: p.request.barcode, price: '0.00', status: 'DRAFT'});
    this.products.push(product); return structuredClone(product);
  }
  async applyStorePrice(product: Product, plan: Plan) { return this.priceAdapter.applyStorePrice(product, plan); }
  async confirmStorePrice(product: Product, plan: Plan) { return this.priceAdapter.confirmStorePrice(product, plan); }
  async ensureActive() {}
  async adjust(_product: Product, p: Plan) {
    if (p.request.storePrice !== undefined) assert.equal(p.product?.price, p.request.storePrice, 'inventory requires durable price confirmation');
    let adjustment = this.adjustments.get(p.request.requestId);
    if (!adjustment) {
      adjustment = {id: `gid://shopify/InventoryAdjustmentGroup/${this.adjustments.size + 1}`, createdAt: '2026-09-25T12:00:00.000Z', referenceDocumentUri: `gid://defy-receiving/Receipt/${p.request.requestId}`};
      this.adjustments.set(p.request.requestId, adjustment); this.adjustedQuantity += p.request.quantity;
    }
    if (this.failAfterAdjust) { this.failAfterAdjust = false; throw new Error('Lost inventory response'); }
    return adjustment;
  }
}

test('optional store price normalizes decimal cents and omits blanks without changing historical fingerprints', () => {
  const legacy = request();
  for (const storePrice of [undefined, '', '   ']) {
    const normalized = request({storePrice});
    assert.equal(Object.hasOwn(normalized, 'storePrice'), false);
    assert.equal(stableJson(normalized), stableJson(legacy));
  }
  for (const [entered, expected] of [['0', '0.00'], [' 0034.5 ', '34.50'], ['34.99', '34.99'], ['1000000', '1000000.00']]) {
    assert.equal(request({storePrice: entered}).storePrice, expected);
  }
  for (const storePrice of [null, 34, false, {}, '-1', 'NaN', 'Infinity', '1e2', '$34.99', '1,000.00', '2.001', '1000000.01', '90071992547410.00']) {
    assert.throws(() => request({storePrice: storePrice as string}), (error: ReceivingError) => error.code === 'VALIDATION' && /Store price/.test(error.message));
  }
});

test('new and existing products receive the entered Shopify selling price before stock, keeping receipt cost and product status', async () => {
  for (const existing of [false, true]) {
    const adapter = new MemoryAdapter();
    if (existing) adapter.products = [item()];
    const result = await new ReceivingService(adapter).receive(request({storePrice: '34.9'}));
    assert.equal(result.createdProduct, !existing);
    assert.equal(result.product.price, '34.90');
    assert.equal(result.receipt.storePrice, '34.90');
    assert.equal(result.receipt.unitCost, '21.50');
    assert.equal(result.staged, !existing);
    assert.equal(result.product.status, existing ? 'ACTIVE' : 'DRAFT');
    assert.equal(adapter.adjustedQuantity, 2);
    assert.equal(adapter.priceWrites.length, 1);
    assert.equal(adapter.state.pending, null);
    assert.equal((adapter.records.get(`intent:${input.requestId}`) as Plan).request.storePrice, '34.90');
    assert.doesNotMatch(JSON.stringify(adapter.priceWrites), /"cost"|"unitCost"|compareAtPrice|inventoryQuantities|publish|"status"|inventoryAdjust/);
  }
});

test('blank store price preserves existing prices and legacy new-product behavior without price calls', async () => {
  for (const existing of [false, true]) {
    const adapter = new MemoryAdapter();
    if (existing) adapter.products = [item()];
    const service = new ReceivingService(adapter);
    const result = await service.receive(request({storePrice: ''}));
    assert.equal(Object.hasOwn(result.receipt, 'storePrice'), false);
    assert.equal(adapter.products[0].price, existing ? '29.99' : '0.00');
    assert.equal(adapter.calls.length, 0);
    assert.equal((await service.receive(request())).duplicate, true);
    assert.equal(adapter.adjustedQuantity, 2);
  }
});

test('zero and an already-matching store price are confirmed without unnecessary writes', async () => {
  for (const price of ['0.00', '29.99']) {
    const adapter = new MemoryAdapter(); adapter.products = [item({price})];
    const result = await new ReceivingService(adapter).receive(request({storePrice: price}));
    assert.equal(result.receipt.storePrice, price);
    assert.equal(adapter.priceWrites.length, 0);
    assert.equal(adapter.adjustedQuantity, 2);
  }
});

test('lost price response, missing mutation result, or lost confirmation save recovers by reading without a second price write', async () => {
  for (const failure of ['after', 'invalid-response', 'save'] as const) {
    const adapter = new MemoryAdapter(); adapter.products = [item()];
    if (failure === 'save') adapter.failPriceSave = true;
    else adapter.priceFailure = failure;
    const service = new ReceivingService(adapter);
    const receipt = request({storePrice: '34.99'});
    await assert.rejects(service.receive(receipt), (error: ReceivingError) => error.committedPossible);
    assert.equal(adapter.state.pending?.phase, 'price_pending');
    assert.equal(adapter.products[0].price, '34.99');
    assert.equal(adapter.adjustedQuantity, 0);
    const recovered = await service.receive(receipt);
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.receipt.storePrice, '34.99');
    assert.equal(adapter.priceWrites.length, 1);
    assert.equal(adapter.adjustedQuantity, 2);
  }
});

test('uncertain price attempts never overwrite a different current price, even when it is the original price', async () => {
  for (const nextPrice of ['45.00', '29.99']) {
    const adapter = new MemoryAdapter(); adapter.products = [item()]; adapter.priceFailure = 'after';
    const service = new ReceivingService(adapter);
    const receipt = request({storePrice: '34.99'});
    await assert.rejects(service.receive(receipt));
    adapter.products[0].price = nextPrice;
    await assert.rejects(service.receive(receipt), (error: ReceivingError) => error.code === 'STORE_PRICE_UNCERTAIN' && error.committedPossible && !error.retryable);
    assert.equal(adapter.products[0].price, nextPrice);
    assert.equal(adapter.priceWrites.length, 1);
    assert.equal(adapter.adjustedQuantity, 0);
  }
});

test('a response lost before sending or committing the price mutation requires review instead of guessing', async () => {
  for (const claim of [false, true]) {
    const adapter = new MemoryAdapter(); adapter.products = [item()];
    if (claim) adapter.failPriceClaim = true;
    else adapter.priceFailure = 'before';
    const service = new ReceivingService(adapter);
    const receipt = request({storePrice: '34.99'});
    await assert.rejects(service.receive(receipt));
    assert.equal(adapter.state.pending?.phase, 'price_pending');
    await assert.rejects(service.receive(receipt), (error: ReceivingError) => error.code === 'STORE_PRICE_UNCERTAIN');
    assert.equal(adapter.priceWrites.length, claim ? 0 : 1);
    assert.equal(adapter.products[0].price, '29.99');
    assert.equal(adapter.adjustedQuantity, 0);
  }
});

test('read-back detects a price changed after the write and blocks stock without overwriting it', async () => {
  const adapter = new MemoryAdapter(); adapter.products = [item()]; adapter.priceFailure = 'changed-after';
  const service = new ReceivingService(adapter);
  const receipt = request({storePrice: '34.99'});
  await assert.rejects(service.receive(receipt), (error: ReceivingError) => error.code === 'STORE_PRICE_UNCERTAIN');
  await assert.rejects(service.receive(receipt));
  assert.equal(adapter.products[0].price, '45.00');
  assert.equal(adapter.priceWrites.length, 1);
  assert.equal(adapter.adjustedQuantity, 0);
});

test('a price changed before the first mutation is left intact for owner review', async () => {
  const adapter = new MemoryAdapter(); adapter.products = [item()];
  adapter.beforePriceRead = () => { adapter.products[0].price = '45.00'; };
  await assert.rejects(new ReceivingService(adapter).receive(request({storePrice: '34.99'})), (error: ReceivingError) => error.code === 'STORE_PRICE_CHANGED');
  assert.equal(adapter.priceWrites.length, 0);
  assert.equal(adapter.products[0].price, '45.00');
  assert.equal(adapter.adjustedQuantity, 0);
});

test('price confirmation preserves the reserved variant identity before any write', async () => {
  for (const change of [{sku: 'OTHER'}, {inventoryItemId: 'gid://shopify/InventoryItem/9'}, {productId: 'gid://shopify/Product/9'}, {barcode: '036000291452'}, {unit: 'Case'}]) {
    const adapter = new MemoryAdapter(); adapter.products = [item()];
    adapter.beforePriceRead = () => { Object.assign(adapter.products[0], change); };
    await assert.rejects(new ReceivingService(adapter).receive(request({storePrice: '34.99'})), (error: ReceivingError) => error.code === 'PRODUCT_IDENTITY_CONFLICT');
    assert.equal(adapter.priceWrites.length, 0);
    assert.equal(adapter.adjustedQuantity, 0);
  }
});

test('inventory retries and completed receipt replays never change a later merchant price', async () => {
  const adapter = new MemoryAdapter(); adapter.products = [item()]; adapter.failAfterAdjust = true;
  const service = new ReceivingService(adapter);
  const receipt = request({storePrice: '34.99'});
  await assert.rejects(service.receive(receipt));
  assert.equal(adapter.state.pending?.phase, 'inventory_pending');
  adapter.products[0].price = '45.00';
  const result = await service.receive(receipt);
  assert.equal(result.receipt.storePrice, '34.99');
  assert.equal((await service.receive(receipt)).duplicate, true);
  assert.equal(adapter.products[0].price, '45.00');
  assert.equal(adapter.priceWrites.length, 1);
  assert.equal(adapter.adjustedQuantity, 2);
});

test('changing or removing the frozen store price conflicts with both pending and completed receipt IDs', async () => {
  const adapter = new MemoryAdapter(); adapter.products = [item()]; adapter.priceFailure = 'after';
  const service = new ReceivingService(adapter);
  const original = request({storePrice: '34.99'});
  await assert.rejects(service.receive(original));
  for (const storePrice of ['35.00', undefined]) await assert.rejects(service.receive(request({storePrice})), (error: ReceivingError) => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal((await service.pending())?.storePrice, '34.99');
  await service.receive(original);
  for (const storePrice of ['35.00', undefined]) await assert.rejects(service.receive(request({storePrice})), (error: ReceivingError) => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(adapter.priceWrites.length, 1);
  assert.equal(adapter.adjustedQuantity, 2);
});

test('another device can only confirm a pending price attempt while the CAS winner is writing', async () => {
  const adapter = new MemoryAdapter(); adapter.products = [item()];
  let release!: () => void;
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  adapter.beforePriceWrite = async () => { started(); await paused; };
  const receipt = request({storePrice: '34.99'});
  const first = new ReceivingService(adapter).receive(receipt);
  await writing;
  await assert.rejects(new ReceivingService(adapter).receive(receipt), (error: ReceivingError) => error.code === 'STORE_PRICE_UNCERTAIN');
  assert.equal(adapter.priceWrites.length, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal(adapter.adjustedQuantity, 2);
  assert.equal(adapter.priceWrites.length, 1);
});

test('journal validation rejects incomplete price phases without relaxing historical phases', async () => {
  const adapter = new MemoryAdapter(); adapter.products = [item()]; adapter.priceFailure = 'after';
  await assert.rejects(new ReceivingService(adapter).receive(request({storePrice: '34.99'})));
  const snapshot = await adapter.readState();
  assert.equal(assertState(snapshot).pending?.phase, 'price_pending');
  const missing = structuredClone(snapshot);
  delete missing.state!.pending!.product!.price;
  assert.throws(() => assertState(missing), /store price is incomplete/);
  const mismatch = structuredClone(snapshot);
  mismatch.state!.pending!.phase = 'price_applied';
  assert.throws(() => assertState(mismatch), /price confirmation/);
});
