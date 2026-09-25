import assert from 'node:assert/strict';
import test from 'node:test';
import {assertState, normalizeRequest, ReceivingService, type Adjustment, type JournalState, type Plan, type Product, type ReceiptInput, type ReceivingAdapter, type Rejected, type StateSnapshot, type TerminalRecord} from '../extensions/receiving/src/receiving-service.ts';
import {barcodeKey, ReceivingError, stableJson} from '../extensions/receiving/src/receiving-validation.ts';
import {ShopifyReceivingAdapter, type GraphQL} from '../extensions/receiving/src/shopify-receiving-adapter.ts';

const input: ReceiptInput = {requestId: 'stock-count-000000001', barcode: '0196214150478', sku: 'DEFY-S-000001', name: 'Perfect Order Booster Bundle', game: 'Pokémon', unit: 'Booster bundle',
  quantity: 12, unitCost: '21.50', supplier: '', notes: '', receivedDate: '2026-09-25', inventoryMode: 'set', expectedAvailableQuantity: 8};
const request = (changes: Partial<ReceiptInput> = {}) => normalizeRequest({...input, ...changes}, 123);
const item = (changes: Partial<Product> = {}): Product => ({sku: 'DEFY-S-000001', barcode: input.barcode, name: input.name, game: input.game, unit: input.unit,
  productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/2', inventoryItemId: 'gid://shopify/InventoryItem/3', tracked: true,
  status: 'ACTIVE', barcodeNeedsReview: false, price: '29.99', ...changes});
type Json = Record<string, any>;

class StockAdapter implements ReceivingAdapter {
  state: JournalState = {version: 1, nextSequence: 2, pending: null};
  revision = 0;
  records = new Map<string, Plan | TerminalRecord>();
  products = [item()];
  available = 8;
  baselineReads = 0;
  now = Date.parse('2026-09-25T12:00:00.000Z');
  attempts: {query: string; variables: Json}[] = [];
  results = new Map<string, Adjustment>();
  priceWrites = 0;
  beforeAdjust?: () => void;
  failInventoryClaim = false;
  failAfterAdjust = false;
  failBeforeAdjust = false;
  failRejectionSave = false;
  failRejectionRecord = false;
  failUnlock = false;
  missingConfirmation = false;
  inventoryAdapter = new ShopifyReceivingAdapter((async <T>(query: string, variables: Json = {}): Promise<T> => {
    assert.match(query, /mutation SetReceivingInventory/);
    assert.equal(this.state.pending?.phase, 'inventory_pending');
    this.attempts.push({query, variables: structuredClone(variables)});
    this.beforeAdjust?.();
    if (this.failBeforeAdjust) { this.failBeforeAdjust = false; throw new Error('Connection lost before response'); }
    const quantity = variables.input.quantities[0];
    let adjustment = this.results.get(variables.idempotencyKey);
    if (!adjustment && quantity.changeFromQuantity !== this.available) {
      return {inventorySetQuantities: {inventoryAdjustmentGroup: null, userErrors: [{code: 'CHANGE_FROM_QUANTITY_STALE', message: 'Stock changed'}]}} as T;
    }
    if (!adjustment) {
      adjustment = {id: `gid://shopify/InventoryAdjustmentGroup/${this.results.size + 1}`, createdAt: new Date(this.now).toISOString(), referenceDocumentUri: variables.input.referenceDocumentUri};
      this.results.set(variables.idempotencyKey, adjustment);
      this.available = quantity.quantity;
    }
    if (this.failAfterAdjust) { this.failAfterAdjust = false; throw new Error('Lost response after inventory committed'); }
    return {inventorySetQuantities: {inventoryAdjustmentGroup: this.missingConfirmation ? null : adjustment, userErrors: []}} as T;
  }) as GraphQL);
  async serverNow() { return this.now; }
  async readState(): Promise<StateSnapshot> { return {shopId: 'gid://shopify/Shop/1', currencyCode: 'USD', digest: String(this.revision), state: structuredClone(this.state)}; }
  async compareAndSet(snapshot: StateSnapshot, state: JournalState) {
    if (snapshot.digest !== String(this.revision)) return false;
    if (state.pending?.phase === 'inventory_rejected' && this.failRejectionSave) { this.failRejectionSave = false; throw new Error('Lost rejection journal save'); }
    this.revision++; this.state = structuredClone(state);
    if (state.pending?.phase === 'inventory_pending' && this.failInventoryClaim) { this.failInventoryClaim = false; throw new Error('Lost inventory claim response'); }
    if (!state.pending && this.failUnlock) { this.failUnlock = false; throw new Error('Lost unlock response'); }
    return true;
  }
  async readRecord(kind: 'intent' | 'applied', id: string) { return structuredClone(this.records.get(`${kind}:${id}`) || null); }
  async createRecord(kind: 'intent' | 'applied', id: string, value: Plan | TerminalRecord) {
    const key = `${kind}:${id}`;
    const previous = this.records.get(key);
    if (previous) assert.equal(stableJson(previous), stableJson(value));
    else this.records.set(key, structuredClone(value));
    if ('status' in value && value.status === 'rejected' && this.failRejectionRecord) { this.failRejectionRecord = false; throw new Error('Lost rejected record response'); }
  }
  async location(id: string) { return {id, name: 'Shop', active: true}; }
  async findByBarcode(barcode: string) { return structuredClone(this.products.filter(product => barcodeKey(product.barcode) === barcodeKey(barcode))); }
  async findBySku(sku: string) { return structuredClone(this.products.filter(product => product.sku === sku)); }
  async findByCatalog() { return null; }
  async search() { return {products: structuredClone(this.products), hasMore: false}; }
  async resolveProduct(plan: Plan) {
    if (plan.before) return structuredClone(plan.before);
    const product = item({sku: plan.plannedSku, status: 'DRAFT', price: '0.00'});
    this.products.push(product); return structuredClone(product);
  }
  async applyStorePrice(product: Product, plan: Plan) { this.priceWrites++; this.products[0].price = plan.request.storePrice; return {...product, price: plan.request.storePrice}; }
  async confirmStorePrice(product: Product, plan: Plan) { assert.equal(this.products[0].price, plan.request.storePrice); return {...product, price: plan.request.storePrice}; }
  async readAvailable() { this.baselineReads++; return this.available; }
  async ensureActive() {}
  async adjust(product: Product, plan: Plan) { return this.inventoryAdapter.adjust(product, plan); }
}

test('stock count normalization allows zero and signed baselines, removes acquisition cost, and leaves legacy fingerprints unchanged', () => {
  for (const quantity of [0, '0', 12, 2147483647]) {
    const normalized = request({quantity, unitCost: ''});
    assert.equal(normalized.quantity, Number(quantity));
    assert.equal(normalized.unitCost, '0.00');
  }
  assert.equal(request({expectedAvailableQuantity: -2147483648}).expectedAvailableQuantity, -2147483648);
  for (const expectedAvailableQuantity of [undefined, null, '8', 1.5, NaN, Infinity, -2147483649, 2147483648]) {
    assert.throws(() => request({expectedAvailableQuantity: expectedAvailableQuantity as number}), /Refresh the current/);
  }
  for (const quantity of [-1, '-1', '', 0.5, '1e2', 2147483648]) assert.throws(() => request({quantity}), /Quantity/);
  assert.throws(() => request({inventoryMode: 'add' as 'set'}), /Choose receiving/);
  assert.throws(() => request({inventoryMode: undefined}), /Refresh the current/);
  const legacy = request({inventoryMode: undefined, expectedAvailableQuantity: undefined});
  assert.equal(Object.hasOwn(legacy, 'inventoryMode'), false);
  assert.equal(Object.hasOwn(legacy, 'expectedAvailableQuantity'), false);
  assert.equal(legacy.unitCost, '21.50');
  assert.throws(() => request({inventoryMode: undefined, expectedAvailableQuantity: undefined, quantity: 0}), /positive whole number/);
});

test('set total writes an absolute quantity once with the pinned comparison and no acquisition cost', async () => {
  const adapter = new StockAdapter();
  const service = new ReceivingService(adapter);
  const result = await service.receive(request({storePrice: '34.99'}));
  assert.equal(adapter.available, 12);
  assert.equal(adapter.priceWrites, 1);
  assert.equal(adapter.products[0].price, '34.99');
  assert.equal(result.receipt.quantity, 12);
  assert.equal(result.receipt.unitCost, '0.00');
  assert.equal(result.receipt.expectedAvailableQuantity, 8);
  assert.equal(result.receipt.inventoryMode, 'set');
  assert.equal(adapter.state.pending, null);
  assert.deepEqual(adapter.attempts[0].variables, {input: {name: 'available', reason: 'correction', referenceDocumentUri: `gid://defy-receiving/Receipt/${input.requestId}`,
    quantities: [{inventoryItemId: item().inventoryItemId, locationId: 'gid://shopify/Location/123', quantity: 12, changeFromQuantity: 8}]}, idempotencyKey: `set-stock-${input.requestId}`});
  assert.match(adapter.attempts[0].query, /@idempotent/);
  adapter.available = 10;
  adapter.products[0].price = '45.00';
  assert.equal((await service.receive(request({storePrice: '34.99'}))).duplicate, true);
  assert.equal(adapter.available, 10, 'completed replay must not erase later sales');
  assert.equal(adapter.products[0].price, '45.00');
  assert.equal(adapter.attempts.length, 1);
});

test('zero, same-value totals, and a newly registered zero-stock product require real Shopify confirmation', async () => {
  for (const [before, quantity, newProduct] of [[8, 0, false], [8, 8, false], [0, 0, true]] as const) {
    const adapter = new StockAdapter(); adapter.available = before;
    if (newProduct) adapter.products = [];
    const result = await new ReceivingService(adapter).receive(request({sku: newProduct ? '' : input.sku, quantity, expectedAvailableQuantity: before}));
    assert.equal(adapter.available, quantity);
    assert.equal(result.createdProduct, newProduct);
    assert.equal(result.receipt.quantity, quantity);
    assert.match(result.receipt.adjustmentGroupId, /^gid:\/\/shopify\/InventoryAdjustmentGroup\//);
    assert.equal(adapter.attempts.length, 1);
  }
  const adapter = new StockAdapter(); adapter.missingConfirmation = true;
  await assert.rejects(new ReceivingService(adapter).receive(request({quantity: 8})), (error: ReceivingError) => error.committedPossible);
  assert.equal(adapter.state.pending?.phase, 'inventory_pending');
  assert.equal(adapter.records.has(`applied:${input.requestId}`), false);
});

test('preflight rejects a stale baseline or newly registered product before reserving or changing anything', async () => {
  for (const changes of [{expectedAvailableQuantity: 9}, {sku: '', expectedAvailableQuantity: 0}]) {
    const adapter = new StockAdapter();
    await assert.rejects(new ReceivingService(adapter).receive(request(changes)), (error: ReceivingError) => error.code === 'STOCK_CHANGED' && !error.committedPossible && !error.stockRejected);
    assert.equal(adapter.revision, 0);
    assert.equal(adapter.records.size, 0);
    assert.equal(adapter.attempts.length, 0);
    assert.equal(adapter.available, 8);
  }
});

test('a sale between preflight and mutation durably rejects the count and unlocks the journal', async () => {
  const adapter = new StockAdapter(); adapter.beforeAdjust = () => { adapter.available = 7; };
  const service = new ReceivingService(adapter);
  const original = request({storePrice: '34.99'});
  await assert.rejects(service.receive(original), (error: ReceivingError) => error.stockRejected && !error.committedPossible && /store price was already saved/.test(error.message));
  assert.equal(adapter.state.pending, null);
  const record = adapter.records.get(`applied:${input.requestId}`) as Rejected;
  assert.equal(record.status, 'rejected');
  assert.equal(record.error.code, 'STOCK_CHANGED');
  assert.equal(record.request.expectedAvailableQuantity, 8);
  assert.equal('receipt' in record, false);
  assert.equal(adapter.available, 7);
  assert.equal(adapter.products[0].price, '34.99');
  adapter.beforeAdjust = undefined;
  await assert.rejects(service.receive(original), (error: ReceivingError) => error.stockRejected);
  assert.equal(adapter.attempts.length, 1, 'rejected IDs never mutate later');
  await assert.rejects(service.receive(request({storePrice: '34.99', expectedAvailableQuantity: 7})), (error: ReceivingError) => error.code === 'IDEMPOTENCY_CONFLICT');
  const fresh = await service.receive(request({requestId: 'stock-count-000000002', expectedAvailableQuantity: 7}));
  assert.equal(fresh.receipt.quantity, 12);
  assert.equal(adapter.available, 12);
});

test('lost rejected record or unlock response recovers its immutable rejection without another mutation', async () => {
  for (const failure of ['failRejectionRecord', 'failUnlock'] as const) {
    const adapter = new StockAdapter(); adapter[failure] = true; adapter.beforeAdjust = () => { adapter.available = 7; };
    const service = new ReceivingService(adapter);
    await assert.rejects(service.receive(request()), (error: ReceivingError) => error.committedPossible && !error.stockRejected);
    await assert.rejects(service.receive(request()), (error: ReceivingError) => error.stockRejected && !error.committedPossible);
    assert.equal(adapter.state.pending, null);
    assert.equal(adapter.attempts.length, 1);
  }
});

test('a lost inventory response retries its exact baseline and key without overwriting later sales', async () => {
  const adapter = new StockAdapter(); adapter.failAfterAdjust = true;
  const service = new ReceivingService(adapter);
  await assert.rejects(service.receive(request()), (error: ReceivingError) => error.committedPossible);
  assert.equal(adapter.available, 12);
  adapter.available = 11;
  const recovered = await service.receive(request());
  assert.equal(recovered.duplicate, true);
  assert.equal(adapter.available, 11);
  assert.equal(adapter.baselineReads, 1);
  assert.equal(adapter.attempts.length, 2);
  assert.deepEqual(adapter.attempts[1], adapter.attempts[0]);
});

test('uncertain first attempt, claim response, or rejection save never turns a later stale response into proof of no write', async () => {
  for (const failure of ['failBeforeAdjust', 'failInventoryClaim', 'failRejectionSave'] as const) {
    const adapter = new StockAdapter(); adapter[failure] = true;
    if (failure === 'failRejectionSave') adapter.beforeAdjust = () => { adapter.available = 7; };
    const service = new ReceivingService(adapter);
    await assert.rejects(service.receive(request()), (error: ReceivingError) => error.committedPossible);
    adapter.available = 7;
    await assert.rejects(service.receive(request()), (error: ReceivingError) => error.committedPossible && !error.stockRejected);
    assert.equal(adapter.state.pending?.phase, 'inventory_pending');
    assert.equal(adapter.records.has(`applied:${input.requestId}`), false);
    assert.equal(adapter.available, 7);
  }
});

test('pending counts freeze mode, quantity, location, baseline and the retry deadline', async () => {
  const adapter = new StockAdapter(); adapter.failAfterAdjust = true;
  const service = new ReceivingService(adapter);
  await assert.rejects(service.receive(request()));
  for (const changes of [{quantity: 13}, {expectedAvailableQuantity: 12}, {locationId: 124}, {inventoryMode: undefined, expectedAvailableQuantity: undefined}]) {
    await assert.rejects(service.receive(request(changes)), (error: ReceivingError) => error.code === 'IDEMPOTENCY_CONFLICT');
  }
  adapter.now += 23 * 60 * 60 * 1000;
  await assert.rejects(service.receive(request()), (error: ReceivingError) => error.code === 'RETRY_WINDOW_EXPIRED');
  assert.equal(adapter.attempts.length, 1);
});

test('damaged count comparisons and rejected phases cannot resume stock operations', async () => {
  const adapter = new StockAdapter(); adapter.failAfterAdjust = true;
  await assert.rejects(new ReceivingService(adapter).receive(request()));
  for (const change of [{expectedAvailableQuantity: undefined}, {expectedAvailableQuantity: 2147483648}, {quantity: -1}, {unitCost: '1.00'}]) {
    const snapshot = await adapter.readState();
    Object.assign(snapshot.state!.pending!.request, change);
    snapshot.state!.pending!.fingerprint = stableJson(snapshot.state!.pending!.request);
    assert.throws(() => assertState(snapshot), /comparison is invalid/);
  }
  const snapshot = await adapter.readState(); snapshot.state!.pending!.phase = 'inventory_rejected';
  assert.throws(() => assertState(snapshot), /rejected stock request/);
});

test('availability reads accept tracked unstocked items as zero, but never invent a count for missing or malformed Shopify data', async () => {
  const product = item();
  const read = (inventoryItem: unknown) => new ShopifyReceivingAdapter((async <T>(query: string, variables: Json): Promise<T> => {
    assert.match(query, /quantities\(names: \["available"\]\)/);
    assert.deepEqual(variables, {id: product.inventoryItemId, locationId: 'gid://shopify/Location/123'});
    return {inventoryItem} as T;
  }) as GraphQL).readAvailable(product, 'gid://shopify/Location/123');
  assert.equal(await read({id: product.inventoryItemId, tracked: true, inventoryLevel: null}), 0);
  for (const quantity of [-5, 0, 8]) assert.equal(await read({id: product.inventoryItemId, tracked: true, inventoryLevel: {id: 'level', quantities: [{name: 'available', quantity}]}}), quantity);
  for (const inventoryItem of [null, undefined, {}, {id: product.inventoryItemId, tracked: true}, {id: product.inventoryItemId, tracked: false, inventoryLevel: null},
    {id: 'other-item', tracked: true, inventoryLevel: null}, ...[undefined, [], [{name: 'on_hand', quantity: 8}], [{name: 'available', quantity: '8'}], [{name: 'available', quantity: 2147483648}]].map(quantities => ({id: product.inventoryItemId, tracked: true, inventoryLevel: {id: 'level', quantities}}))]) {
    await assert.rejects(read(inventoryItem), (error: ReceivingError) => error.code === 'STOCK_UNAVAILABLE');
  }
});
