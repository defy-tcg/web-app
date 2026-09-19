import assert from 'node:assert/strict';
import test from 'node:test';
import {amountToCents, createPricingController, createScanGate, parseQuote, PRICING_URL, QUOTE_PROPERTY, type CartLine, type PosAdapter, type PricingState, type Quote} from '../extensions/defy-pricing/src/controller.ts';

const quote: Quote = {variantId: 123, productId: 'gid://shopify/Product/456', sku: 'RFT-001-NM', title: 'Blazing Scorcher', priceCents: 1100, currency: 'USD', scrydexId: 'ogn-001'};

function fixture(overrides: Partial<PosAdapter> = {}) {
  const lines: CartLine[] = [];
  const removed: string[] = [];
  const states: PricingState[] = [];
  const requests: {url: string; options?: RequestInit}[] = [];
  let now = 1000;
  let adds = 0;
  const adapter: PosAdapter = {
    currency: () => 'USD',
    getToken: async () => 'session-token',
    request: async (url, options) => { requests.push({url: String(url), options}); return Response.json(quote); },
    getVariant: async () => ({id: quote.variantId, price: '11.00', sku: quote.sku}),
    cart: () => ({lineItems: lines, editable: true}),
    add: async (id, properties) => { adds++; lines.push({uuid: 'new-line', variantId: id, price: 11, quantity: 1, properties}); return 'new-line'; },
    remove: async (uuid) => { removed.push(uuid); const index = lines.findIndex((line) => line.uuid === uuid); if (index >= 0) lines.splice(index, 1); },
    pause: async (ms) => { now += ms; },
    now: () => now,
    uniqueId: () => 'operation-1',
    ...overrides,
  };
  const controller = createPricingController(adapter, (state) => states.push(state));
  return {adapter, controller, lines, removed, states, requests, added: () => adds, advance: (ms: number) => { now += ms; }};
}

test('scan gate ignores replayed or repeated values and explicitly rearms', () => {
  const gate = createScanGate('old');
  assert.equal(gate.accept('old'), false);
  assert.equal(gate.accept('new'), true);
  assert.equal(gate.accept(' new '), false);
  assert.equal(gate.accept(undefined), false);
  gate.reset();
  assert.equal(gate.accept('new'), true);
});

test('price parsing rejects invalid currency/amounts and never rounds fractional cents', () => {
  assert.equal(amountToCents('11.00'), 1100);
  assert.equal(amountToCents(0.29), 29);
  for (const value of [NaN, Infinity, -1, 0, '1.001', '1e3', '$11', '']) assert.equal(amountToCents(value), undefined);
  assert.throws(() => parseQuote({...quote, currency: 'CAD'}));
  assert.throws(() => parseQuote({...quote, priceCents: 11.2}));
  assert.throws(() => parseQuote({...quote, variantId: Number.MAX_SAFE_INTEGER + 1}));
});

test('lookup authenticates exact backend request and requires explicit add', async () => {
  let tokens = 0;
  const f = fixture({getToken: async () => `token-${++tokens}`});
  await f.controller.lookup(' RFT-001-NM ');
  assert.equal(f.controller.getState().kind, 'quoted');
  assert.equal(f.added(), 0);
  assert.equal(f.requests[0].url, PRICING_URL);
  assert.equal(f.requests[0].options?.body, JSON.stringify({code: quote.sku}));
  assert.equal(new Headers(f.requests[0].options?.headers).get('Authorization'), 'Bearer token-1');
  await f.controller.lookup('RFT-002-NM');
  assert.equal(tokens, 2);
});

test('barcode-only variants with no SKU still receive valid pricing', async () => {
  const f = fixture({request: async () => Response.json({...quote, sku: ''})});
  await f.controller.lookup('123456789012');
  assert.equal(f.controller.getState().kind, 'quoted');
  await f.controller.add();
  assert.equal(f.controller.getState().kind, 'added');
});

test('non-USD POS and missing app permission never call backend', async () => {
  for (const adapter of [{currency: () => 'CAD'}, {getToken: async () => undefined}]) {
    const f = fixture(adapter);
    await f.controller.lookup(quote.sku);
    assert.equal(f.controller.getState().kind, 'error');
    assert.equal(f.requests.length, 0);
  }
});

test('API unavailable or ambiguous match displays server error and cannot add', async () => {
  const f = fixture({request: async () => Response.json({error: 'More than one variant has this SKU.', code: 'ambiguous_sku'}, {status: 409})});
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.match((f.controller.getState() as {message: string}).message, /More than one/);
  assert.equal(f.added(), 0);
});

test('verified catalog quote adds inventory-linked variant at matching price', async () => {
  const f = fixture();
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.equal(f.controller.getState().kind, 'added');
  assert.equal(f.lines[0].variantId, quote.variantId);
  assert.equal(f.lines[0].price, 11);
  assert.equal(f.lines[0].properties?.[QUOTE_PROPERTY], 'operation-1');
  assert.deepEqual(f.removed, []);
});

test('catalog propagation waits for correct price but does not add stale price', async () => {
  let reads = 0;
  const f = fixture({getVariant: async () => ({id: quote.variantId, price: ++reads >= 3 ? '11.00' : '10.00'})});
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.equal(reads, 3);
  assert.equal(f.controller.getState().kind, 'added');
  const stale = fixture({getVariant: async () => ({id: quote.variantId, price: '10.00'})});
  await stale.controller.lookup(quote.sku);
  await stale.controller.add();
  assert.equal(stale.added(), 0);
  assert.match((stale.controller.getState() as {message: string}).message, /still syncing/);
});

test('old quote and currency changes are rechecked before adding', async () => {
  const old = fixture();
  await old.controller.lookup(quote.sku);
  old.advance(60_001);
  await old.controller.add();
  assert.equal(old.added(), 0);
  const switched = fixture();
  await switched.controller.lookup(quote.sku);
  switched.adapter.currency = () => 'EUR';
  await switched.controller.add();
  assert.equal(switched.added(), 0);
});

test('already present SKU blocks fetch and matching variant blocks add after quote', async () => {
  const f = fixture();
  f.lines.push({uuid: 'existing', sku: quote.sku, variantId: quote.variantId, price: 10, quantity: 2});
  await f.controller.lookup(quote.sku);
  assert.equal(f.requests.length, 0);
  f.lines.length = 0;
  await f.controller.lookup(quote.sku);
  f.lines.push({uuid: 'existing', variantId: quote.variantId, price: 10, quantity: 2});
  await f.controller.add();
  assert.equal(f.added(), 0);
  assert.deepEqual(f.removed, []);
});

test('mismatched cart price rolls back only the new line, preserving existing items', async () => {
  const f = fixture();
  f.lines.push({uuid: 'existing', variantId: 999, price: 7, quantity: 2});
  f.adapter.add = async (id, properties) => { f.lines.push({uuid: 'new-line', variantId: id, price: 10, quantity: 1, properties}); return 'new-line'; };
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.deepEqual(f.removed, ['new-line']);
  assert.deepEqual(f.lines.map((line) => line.uuid), ['existing']);
  assert.match((f.controller.getState() as {message: string}).message, /new line was removed/);
});

test('SDK returning an old uuid must never remove that existing line', async () => {
  const f = fixture();
  f.lines.push({uuid: 'existing', variantId: 999, price: 9, quantity: 1});
  f.adapter.add = async (id, properties) => { Object.assign(f.lines[0], {variantId: id, properties, price: 11}); return 'existing'; };
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.equal(f.controller.getState().kind, 'error');
  assert.deepEqual(f.removed, []);
  assert.equal(f.lines[0].uuid, 'existing');
});

test('an add rejection after creating a line rolls back the owned line', async () => {
  const f = fixture();
  f.adapter.add = async (id, properties) => { f.lines.push({uuid: 'new-line', variantId: id, price: 10, quantity: 1, properties}); throw new Error('POS could not confirm the add.'); };
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.deepEqual(f.removed, ['new-line']);
  assert.equal(f.lines.length, 0);
});

test('rejected add recovers an owned line that only appears later in the cart signal', async () => {
  const f = fixture();
  let lateLine: CartLine | undefined;
  f.adapter.add = async (id, properties) => {
    lateLine = {uuid: 'late-line', variantId: id, price: 10, quantity: 1, properties};
    throw new Error('POS could not confirm the add.');
  };
  f.adapter.pause = async () => { if (lateLine) { f.lines.push(lateLine); lateLine = undefined; } };
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.deepEqual(f.removed, ['late-line']);
  assert.equal(f.lines.length, 0);
});

test('closing modal while a native add is in flight rolls back its new line', async () => {
  const f = fixture();
  f.adapter.add = async (id, properties) => {
    f.controller.dispose();
    f.lines.push({uuid: 'new-line', variantId: id, price: 11, quantity: 1, properties});
    return 'new-line';
  };
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.deepEqual(f.removed, ['new-line']);
  assert.equal(f.lines.length, 0);
});

test('failed rollback tells staff to fix the cart before checkout', async () => {
  const f = fixture();
  f.adapter.add = async (id, properties) => { f.lines.push({uuid: 'new-line', variantId: id, price: 10, quantity: 1, properties}); return 'new-line'; };
  f.adapter.remove = async () => { throw new Error('Offline'); };
  await f.controller.lookup(quote.sku);
  await f.controller.add();
  assert.match((f.controller.getState() as {message: string}).message, /before checkout/);
});

test('concurrent lookups and duplicate add taps are serialized', async () => {
  let release!: () => void;
  const f = fixture({getToken: () => new Promise((resolve) => { release = () => resolve('token'); })});
  const first = f.controller.lookup(quote.sku);
  await f.controller.lookup('other');
  release();
  await first;
  assert.equal(f.requests.length, 1);
  await Promise.all([f.controller.add(), f.controller.add()]);
  assert.equal(f.added(), 1);
});

test('closing modal before quote finishes cannot add or update UI', async () => {
  let release!: () => void;
  const f = fixture({getToken: () => new Promise((resolve) => { release = () => resolve('token'); })});
  const work = f.controller.lookup(quote.sku);
  f.controller.dispose();
  release();
  await work;
  assert.equal(f.requests.length, 0);
  assert.equal(f.states.length, 1);
  await f.controller.add();
  assert.equal(f.added(), 0);
});
