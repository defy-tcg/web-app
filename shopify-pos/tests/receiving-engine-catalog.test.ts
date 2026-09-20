import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeReceiptCatalog, receivingCardMetadata, receivingCatalogKey, type CatalogReference, type ReceiptCatalog} from '../extensions/receiving/src/receiving-catalog.ts';
import {normalizeRequest, ReceivingService, type Adjustment, type Applied, type JournalState, type Plan, type Product, type ReceiptInput, type ReceivingAdapter, type StateSnapshot} from '../extensions/receiving/src/receiving-service.ts';
import {barcodeKey, ReceivingError, stableJson} from '../extensions/receiving/src/receiving-validation.ts';
import {ShopifyReceivingAdapter, type GraphQL} from '../extensions/receiving/src/shopify-receiving-adapter.ts';

const catalog: ReceiptCatalog = {game: 'pokemon', id: 'me3-s9', name: 'Perfect Order Booster Bundle', setName: 'Perfect Order', language: 'English'};
const input: ReceiptInput = {requestId: 'receipt-catalog-000001', barcode: '0196214150478', name: catalog.name, game: 'Pokémon', unit: 'Booster bundle',
  quantity: 2, unitCost: '21.50', supplier: 'Supplier', notes: '', receivedDate: '2026-09-19'};
const request = (changes: Partial<ReceiptInput> = {}) => normalizeRequest({...input, catalog, ...changes}, 123);
const item = (changes: Partial<Product> = {}): Product => ({sku: 'DEFY-S-000001', barcode: input.barcode, name: input.name, game: input.game, unit: input.unit,
  productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/2', inventoryItemId: 'gid://shopify/InventoryItem/3', tracked: true,
  status: 'DRAFT', barcodeNeedsReview: false, catalogId: receivingCatalogKey(catalog), barcodeId: barcodeKey(input.barcode), ...changes});
const plan = (changes: Partial<ReceiptInput> = {}): Plan => {
  const normalized = request(changes);
  return {version: 1, request: normalized, fingerprint: stableJson(normalized), startedAt: '2026-09-19T12:00:00.000Z',
    plannedSku: 'DEFY-S-000001', createdProduct: true, before: null, locationName: 'Shop', currencyCode: 'USD', phase: 'planned'};
};

test('old receipts omit catalog entirely and retain their exact historical fingerprint', () => {
  const normalized = normalizeRequest({...input, catalog: undefined}, 123);
  assert.equal(Object.hasOwn(normalized, 'catalog'), false);
  assert.equal(stableJson(normalized), '{"barcode":"0196214150478","game":"Pokémon","locationId":"gid://shopify/Location/123","name":"Perfect Order Booster Bundle","notes":"","quantity":2,"receivedDate":"2026-09-19","replaceInvalidBarcode":false,"requestId":"receipt-catalog-000001","sku":"","supplier":"Supplier","unit":"Booster bundle","unitCost":"21.50"}');
});

test('catalog identity is bounded and exact; receipt prices and mismatched identity are rejected', () => {
  assert.deepEqual(request({game: 'Pokemon', catalog: {...catalog, id: ' me3-s9 '}}).catalog, catalog);
  assert.equal(request({game: 'Pokemon'}).game, 'Pokémon');
  const invalid: unknown[] = [null, [], {...catalog, game: 'magic'}, {...catalog, id: '../me3'}, {...catalog, id: 'me3.s9'}, {...catalog, id: 'a'.repeat(101)},
    {...catalog, name: 'a'.repeat(301)}, {...catalog, setName: ''}, {...catalog, setName: 'a'.repeat(301)}, {...catalog, setName: 'A\nB'},
    {...catalog, language: 'Japanese'}, {...catalog, marketCents: 3638}];
  for (const value of invalid) assert.throws(() => normalizeReceiptCatalog(value, input.name, input.game), ReceivingError);
  assert.throws(() => request({name: 'Another bundle'}), /must match/);
  assert.throws(() => request({game: 'One Piece'}), /must match/);
  assert.equal(receivingCatalogKey({...catalog, game: 'onepiece'}), 'scrydex:onepiece:me3-s9');
  assert.equal(receivingCatalogKey({...catalog, game: 'riftbound'}), 'scrydex:riftbound:me3-s9');
});

class MemoryAdapter implements ReceivingAdapter {
  state: JournalState = {version: 1, nextSequence: 1, pending: null};
  revision = 0;
  records = new Map<string, Plan | Applied>();
  products: Product[] = [];
  adjustments = new Map<string, Adjustment>();
  adjustedQuantity = 0;
  catalogReads = 0;
  resolutions = 0;
  failAfterAdjust = false;
  async serverNow() { return Date.parse('2026-09-19T12:00:00.000Z'); }
  async readState(): Promise<StateSnapshot> { return {shopId: 'gid://shopify/Shop/1', currencyCode: 'USD', digest: String(this.revision), state: structuredClone(this.state)}; }
  async compareAndSet(snapshot: StateSnapshot, state: JournalState) {
    if (snapshot.digest !== String(this.revision)) return false;
    this.revision++; this.state = structuredClone(state); return true;
  }
  async readRecord(kind: 'intent' | 'applied', id: string) { return structuredClone(this.records.get(`${kind}:${id}`) || null); }
  async createRecord(kind: 'intent' | 'applied', id: string, value: Plan | Applied) {
    const key = `${kind}:${id}`;
    const existing = this.records.get(key);
    if (existing) assert.equal(stableJson(existing), stableJson(value));
    else this.records.set(key, structuredClone(value));
  }
  async location(id: string) { return {id, name: 'Shop', active: true}; }
  async findByBarcode(barcode: string) { return this.products.filter(product => barcodeKey(product.barcode) === barcodeKey(barcode)); }
  async findBySku(sku: string) { return this.products.filter(product => product.sku === sku); }
  async findByCatalog(source: CatalogReference) { this.catalogReads++; return this.products.find(product => product.catalogId === receivingCatalogKey(source)) || null; }
  async search() { return {products: this.products, hasMore: false}; }
  async resolveProduct(p: Plan) {
    this.resolutions++;
    if (p.before) return p.before;
    const product = item({sku: p.plannedSku, barcode: p.request.barcode, catalogId: p.request.catalog ? receivingCatalogKey(p.request.catalog) : barcodeKey(p.request.barcode)});
    this.products.push(product); return product;
  }
  async ensureActive() {}
  async adjust(_product: Product, p: Plan) {
    let adjustment = this.adjustments.get(p.request.requestId);
    if (!adjustment) {
      adjustment = {id: `gid://shopify/InventoryAdjustmentGroup/${this.adjustments.size + 1}`, createdAt: '2026-09-19T12:00:00.000Z', referenceDocumentUri: `gid://defy-receiving/Receipt/${p.request.requestId}`};
      this.adjustments.set(p.request.requestId, adjustment); this.adjustedQuantity += p.request.quantity;
    }
    if (this.failAfterAdjust) { this.failAfterAdjust = false; throw new Error('Lost response after Shopify committed'); }
    return adjustment;
  }
}

test('catalog receipt survives uncertain adjustment and replays once using the frozen source identity', async () => {
  const adapter = new MemoryAdapter();
  const service = new ReceivingService(adapter);
  adapter.failAfterAdjust = true;
  await assert.rejects(service.receive(request()), (error: ReceivingError) => error.code === 'CONNECTION_UNCERTAIN' && error.committedPossible);
  assert.equal(adapter.adjustedQuantity, 2);
  assert.equal(adapter.state.pending?.phase, 'inventory_pending');
  const result = await service.receive(request());
  assert.equal(result.duplicate, true);
  assert.equal(result.createdProduct, true);
  assert.equal(result.staged, true);
  assert.deepEqual(result.receipt.catalog, catalog);
  assert.equal(result.receipt.unitCost, '21.50');
  assert.equal(adapter.state.pending, null);
  assert.equal(adapter.state.nextSequence, 2);
  assert.equal(adapter.catalogReads, 1);
  assert.equal(adapter.resolutions, 1);
  assert.equal(adapter.adjustedQuantity, 2);
  assert.equal((await service.receive(request())).duplicate, true);
  assert.equal(adapter.adjustedQuantity, 2);
  await assert.rejects(service.receive(request({catalog: {...catalog, id: 'me3-s8'}})), (error: ReceivingError) => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('mapped source is reused for alias barcode without allocating another SKU', async () => {
  const adapter = new MemoryAdapter();
  adapter.products = [item({status: 'ACTIVE'})];
  const result = await new ReceivingService(adapter).receive(request({barcode: '196214150478'}));
  assert.equal(result.createdProduct, false);
  assert.equal(result.staged, false);
  assert.equal(result.product.sku, 'DEFY-S-000001');
  assert.equal(adapter.state.nextSequence, 1);
  assert.equal(adapter.products.length, 1);
});

test('source conflicts and legacy barcode ownership reject before journal writes', async () => {
  for (const products of [
    [item({barcode: '036000291452', barcodeId: 'upc:036000291452'})],
    [item({catalogId: 'upc:196214150478'})],
    [item({barcode: '036000291452'}), item({variantId: 'gid://shopify/ProductVariant/8', catalogId: 'legacy-other', sku: 'OTHER'})],
  ]) {
    const adapter = new MemoryAdapter(); adapter.products = products;
    await assert.rejects(new ReceivingService(adapter).receive(request()), (error: ReceivingError) => error.code === 'VALIDATION' && !error.committedPossible);
    assert.equal(adapter.revision, 0);
    assert.equal(adapter.adjustedQuantity, 0);
    assert.equal(adapter.records.size, 0);
  }
});

test('legacy receipt replay and receiving paths never perform source lookups', async () => {
  const adapter = new MemoryAdapter();
  const legacy = request({catalog: undefined});
  const service = new ReceivingService(adapter);
  const first = await service.receive(legacy);
  assert.equal(Object.hasOwn(first.receipt, 'catalog'), false);
  assert.equal((await service.receive(legacy)).duplicate, true);
  assert.equal(adapter.catalogReads, 0);
  assert.equal(adapter.adjustedQuantity, 2);
});

type Json = Record<string, any>;
function shopifyFixture() {
  const calls: {query: string; variables: Json}[] = [];
  const failures = {creation: false, metadata: false};
  let saved: Json | null = null;
  const graphql: GraphQL = async <T>(query: string, variables: Json = {}): Promise<T> => {
    calls.push({query, variables: structuredClone(variables)});
    let result: Json;
    if (query.includes('query ReceivingCatalogId')) result = {productByIdentifier: saved && saved.catalogKey === variables.identifier.customId.value ? saved : null};
    else if (query.includes('query ReceivingVariant(')) result = {productVariant: saved?.variants.nodes[0] || null};
    else if (query.includes('query ReceivingBarcodeId')) result = {productVariantByIdentifier: null};
    else if (query.includes('query ReceivingVariants')) result = {productVariants: {nodes: [], pageInfo: {hasNextPage: false}}};
    else if (query.includes('query ReceivingState')) result = {shop: {id: 'gid://shopify/Shop/1', currencyCode: 'USD', metafield: {namespace: 'app--123--receiving', value: '{"version":1,"nextSequence":1,"pending":null}', compareDigest: 'digest'}}};
    else if (query.includes('mutation CreateReceivingDraft')) {
      const draft = variables.input;
      // Reproduce the production incompatibility instead of accepting this input in a mock.
      if (Object.hasOwn(draft, 'metafields')) return {productSet: {product: null, userErrors: [{code: 'METAFIELD_MISMATCH', field: ['input'], message: 'The input argument metafields (if present) must contain the customId value.'}]}} as T;
      assert.equal(saved, null, 'a retry must recover the existing reserved draft instead of upserting it');
      const variant = draft.variants[0];
      const field = (key: string) => ({value: variant.metafields.find((meta: Json) => meta.key === key)?.value});
      const node = {id: 'gid://shopify/ProductVariant/2', sku: variant.sku, barcode: variant.barcode, title: 'Default Title', inventoryItem: {id: 'gid://shopify/InventoryItem/3', tracked: true},
        game: field('game'), unit: field('unit'), barcodeId: field('barcode_id'), product: {id: 'gid://shopify/Product/1', title: draft.title, status: draft.status, catalogId: {value: variables.identifier.customId.value}}};
      saved = {id: node.product.id, catalogKey: variables.identifier.customId.value, productType: draft.productType, variants: {nodes: [node], pageInfo: {hasNextPage: false}}};
      if (failures.creation) { failures.creation = false; throw new Error('Lost response after draft creation'); }
      result = {productSet: {product: {id: node.product.id}, userErrors: []}};
    } else if (query.includes('mutation CompleteReceivingCatalogMetadata')) {
      assert.ok(saved);
      for (const field of variables.metafields) {
        assert.equal(field.ownerId, saved.id);
        assert.equal(field.namespace, 'card');
        assert.equal(field.compareDigest, null, 'only absent fields may be created');
        assert.equal(saved[`card_${field.key}`], undefined, 'existing merchant metadata must not be overwritten');
      }
      for (const field of variables.metafields) saved[`card_${field.key}`] = {value: field.value, compareDigest: `digest-${field.key}`};
      if (failures.metadata) { failures.metadata = false; throw new Error('Lost response after metadata completion'); }
      result = {metafieldsSet: {metafields: variables.metafields.map((field: Json) => ({id: `gid://shopify/Metafield/${field.key}`})), userErrors: []}};
    } else throw new Error(`Unexpected operation ${query}`);
    return result as T;
  };
  return {adapter: new ShopifyReceivingAdapter(graphql), calls, failures, saved: () => saved!};
}

test('new catalog drafts persist canonical source/card metadata and barcode claim without price, cost, stock or publication writes', async () => {
  const fixture = shopifyFixture();
  const created = await fixture.adapter.resolveProduct(plan());
  assert.equal(created.catalogId, 'scrydex:pokemon:me3-s9');
  assert.equal(created.barcodeId, 'upc:196214150478');
  const writes = fixture.calls.filter(call => call.query.includes('mutation '));
  assert.equal(writes.length, 2);
  const {input: draft, identifier} = writes[0].variables;
  assert.deepEqual(identifier, {customId: {namespace: 'app--123--receiving', key: 'catalog_id', value: 'scrydex:pokemon:me3-s9'}});
  assert.equal(draft.productType, 'Pokémon Sealed');
  assert.equal(draft.status, 'DRAFT');
  assert.equal(Object.hasOwn(draft, 'metafields'), false, 'productSet must let its identifier create the source metafield');
  assert.match(writes[1].query, /mutation CompleteReceivingCatalogMetadata/);
  assert.deepEqual(writes[1].variables.metafields, Object.entries(receivingCardMetadata(catalog)).map(([key, value]) => ({ownerId: created.productId, namespace: 'card', key, type: 'single_line_text_field', value, compareDigest: null})));
  assert.ok(fixture.calls.some(call => call.query.includes('ReceivingCatalogId') && /card_name:[^}]*compareDigest/.test(call.query)));
  assert.equal(draft.variants[0].metafields[0].value, 'upc:196214150478');
  assert.deepEqual(draft.variants[0].inventoryItem, {tracked: true});
  assert.doesNotMatch(JSON.stringify(writes), /"price"|"cost"|"unitCost"|inventoryQuantities|publish|inventoryAdjust/);
  const callCount = fixture.calls.length;
  assert.deepEqual(await fixture.adapter.resolveProduct(plan()), created);
  assert.equal(fixture.calls.slice(callCount).filter(call => call.query.includes('mutation ')).length, 0);
});

test('lost draft or metadata responses recover the same reservation before inventory changes and never duplicate stock', async () => {
  for (const stage of ['creation', 'metadata'] as const) {
    const fixture = shopifyFixture();
    fixture.failures[stage] = true;
    const journal = new MemoryAdapter();
    journal.resolveProduct = savedPlan => fixture.adapter.resolveProduct(savedPlan);
    const service = new ReceivingService(journal);
    await assert.rejects(service.receive(request()), (error: ReceivingError) => error.code === 'CONNECTION_UNCERTAIN' && error.committedPossible);
    assert.ok(fixture.saved());
    assert.equal(journal.state.pending?.phase, 'planned');
    assert.equal(journal.adjustedQuantity, 0);
    assert.equal(journal.state.nextSequence, 2);
    const result = await service.receive(request());
    assert.equal(result.product.sku, 'DEFY-S-000001');
    assert.equal(result.duplicate, true);
    assert.equal(journal.adjustedQuantity, 2);
    assert.equal(journal.state.pending, null);
    assert.equal(fixture.calls.filter(call => call.query.includes('mutation CreateReceivingDraft')).length, 1);
    assert.equal(fixture.calls.filter(call => call.query.includes('mutation CompleteReceivingCatalogMetadata')).length, 1);
    assert.equal((await service.receive(request())).duplicate, true);
    assert.equal(journal.adjustedQuantity, 2);
    assert.equal(journal.adjustments.size, 1);
  }
});

test('partial catalog metadata preserves exact matches and only fills missing fields with compare-and-set', async () => {
  const fixture = shopifyFixture();
  fixture.failures.creation = true;
  await assert.rejects(fixture.adapter.resolveProduct(plan()), /Lost response/);
  const matching = {value: catalog.name, compareDigest: 'merchant-existing-digest'};
  fixture.saved().card_name = matching;
  await fixture.adapter.resolveProduct(plan());
  assert.equal(fixture.saved().card_name, matching);
  const completion = fixture.calls.find(call => call.query.includes('mutation CompleteReceivingCatalogMetadata'))!;
  assert.equal(completion.variables.metafields.length, Object.keys(receivingCardMetadata(catalog)).length - 1);
  assert.equal(completion.variables.metafields.some((field: Json) => field.key === 'name'), false);
});

test('draft recovery verifies every reserved identity field before adding missing catalog metadata', async () => {
  const changes: ((saved: Json) => void)[] = [
    saved => { saved.variants.nodes[0].sku = 'OTHER'; },
    saved => { saved.variants.nodes[0].barcode = '036000291452'; },
    saved => { saved.variants.nodes[0].barcodeId.value = 'upc:036000291452'; },
    saved => { saved.variants.nodes[0].unit.value = 'Case'; },
    saved => { saved.variants.nodes[0].game.value = 'Riftbound'; },
    saved => { saved.variants.nodes[0].product.title = 'Another package'; },
    saved => { saved.variants.nodes[0].product.status = 'ACTIVE'; },
    saved => { saved.variants.nodes[0].inventoryItem.tracked = false; },
    saved => { saved.productType = 'Pokémon Single'; },
    saved => { saved.variants.nodes[0].product.catalogId.value = 'legacy-other'; },
    saved => { saved.card_set = {value: 'Different set', compareDigest: 'merchant-digest'}; },
  ];
  for (const change of changes) {
    const fixture = shopifyFixture();
    fixture.failures.creation = true;
    await assert.rejects(fixture.adapter.resolveProduct(plan()), /Lost response/);
    change(fixture.saved());
    const before = structuredClone(fixture.saved());
    const callCount = fixture.calls.length;
    await assert.rejects(fixture.adapter.resolveProduct(plan()), (error: ReceivingError) => error.code === 'PRODUCT_IDENTITY_CONFLICT');
    assert.equal(fixture.calls.slice(callCount).some(call => call.query.includes('mutation ')), false);
    assert.deepEqual(fixture.saved(), before);
  }
});

test('source recovery rejects changed card metadata without overwriting it', async () => {
  const fixture = shopifyFixture();
  await fixture.adapter.resolveProduct(plan());
  fixture.saved().card_set.value = 'Changed externally';
  const callCount = fixture.calls.length;
  await assert.rejects(fixture.adapter.resolveProduct(plan()), (error: ReceivingError) => error.code === 'PRODUCT_IDENTITY_CONFLICT');
  assert.equal(fixture.calls.slice(callCount).some(call => call.query.includes('mutation ')), false);
  assert.equal(fixture.saved().card_set.value, 'Changed externally');
});

test('existing mapped products retain owner metadata and reject removed source mappings', async () => {
  const fixture = shopifyFixture();
  const created = await fixture.adapter.resolveProduct(plan());
  const existingPlan = {...plan(), before: created, createdProduct: false};
  fixture.saved().card_set.value = 'Owner-managed set';
  fixture.saved().productType = 'Owner-managed type';
  const callCount = fixture.calls.length;
  assert.deepEqual(await fixture.adapter.resolveProduct(existingPlan), created);
  assert.equal(fixture.calls.slice(callCount).some(call => call.query.includes('mutation ')), false);
  fixture.saved().variants.nodes[0].product.catalogId.value = 'legacy-other';
  await assert.rejects(fixture.adapter.resolveProduct(existingPlan), /mapping changed/);
  assert.equal(fixture.calls.slice(callCount).some(call => call.query.includes('mutation ')), false);
});

test('source lookup is an exact custom-ID query; old draft payload omits card metadata', async () => {
  const fixture = shopifyFixture();
  assert.equal(await fixture.adapter.findByCatalog(catalog), null);
  assert.deepEqual(fixture.calls[0].variables.identifier.customId, {namespace: '$app:receiving', key: 'catalog_id', value: 'scrydex:pokemon:me3-s9'});
  assert.equal(fixture.calls[0].query.includes('mutation '), false);
  await fixture.adapter.resolveProduct(plan({catalog: undefined}));
  const write = fixture.calls.find(call => call.query.includes('mutation CreateReceivingDraft'))!;
  assert.equal(Object.hasOwn(write.variables.input, 'productType'), false);
  assert.equal(Object.hasOwn(write.variables.input, 'metafields'), false);
  assert.equal(write.variables.identifier.customId.value, 'upc:196214150478');
  assert.equal(write.variables.input.variants[0].metafields[0].value, 'upc:196214150478');
});
