import assert from 'node:assert/strict';
import test from 'node:test';
import {createSealedPricingClient, parseSealedQuote, SEALED_PRICING_URL, SealedPricingError, type PokemonProduct, type ScanResult, type SealedQuote} from '../extensions/pokemon-sealed/src/client.ts';
import {createSealedPricingController, createSealedScanGate, type SealedPricingState} from '../extensions/pokemon-sealed/src/controller.ts';
import type {CatalogProduct} from '../extensions/receiving/src/catalog-client.ts';

const CODE = '0820650855931';
const product = (id = 'sv8-elite-trainer-box'): PokemonProduct => ({id, game: 'pokemon', name: 'Surging Sparks Elite Trainer Box', setName: 'Surging Sparks',
  language: 'English', unit: 'Elite Trainer Box', imageUrl: 'https://images.scrydex.com/pokemon/sv8-etb.jpg', marketCents: 8999});
const quote = (code = CODE, id?: string, mappingSource: SealedQuote['mappingSource'] = 'saved'): SealedQuote => ({code, product: product(id), currency: 'USD', fetchedAt: '2026-09-24T01:00:00.000Z', mappingSource});
const quoted = (code = CODE, id?: string): ScanResult => ({status: 'quoted', quote: quote(code, id)});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('sealed requests send fresh POS tokens and preserve manufacturer leading zeros', async () => {
  let tokens = 0;
  const calls: {url: string; input: RequestInit}[] = [];
  const client = createSealedPricingClient({getToken: async () => `session-${++tokens}`, request: async (url, input) => {
    calls.push({url: String(url), input: input!});
    return Response.json(quoted());
  }});
  assert.equal((await client.scan(` ${CODE} `)).status, 'quoted');
  assert.equal((await client.link(CODE, product().id, null)).product.id, product().id);
  await client.link(CODE, product().id, 'previous-product');
  assert.deepEqual(calls.map(call => call.url), [SEALED_PRICING_URL, SEALED_PRICING_URL, SEALED_PRICING_URL]);
  assert.deepEqual(calls.map(call => JSON.parse(String(call.input.body))), [
    {action: 'scan', code: CODE},
    {action: 'link', code: CODE, id: product().id, expectedId: null},
    {action: 'link', code: CODE, id: product().id, expectedId: 'previous-product'},
  ]);
  calls.forEach((call, index) => {
    assert.equal(call.input.method, 'POST');
    assert.equal(new Headers(call.input.headers).get('Authorization'), `Bearer session-${index + 1}`);
    assert.ok(call.input.signal);
  });
});

test('unmapped scan requires matching code; links require exact selected product', async () => {
  let body: unknown = {status: 'unmapped', code: CODE, suggestedQuery: 'Surging Sparks Elite Trainer'};
  const client = createSealedPricingClient({getToken: async () => 'token', request: async () => Response.json(body)});
  assert.deepEqual(await client.scan(CODE), body);
  await assert.rejects(client.link(CODE, product().id, null), /incomplete details/);
  for (const invalid of [{status: 'unmapped', code: 'another'}, {status: 'unmapped', code: CODE, suggestedQuery: 'x'.repeat(101)}, {status: 'unknown', code: CODE}]) {
    body = invalid;
    await assert.rejects(client.scan(CODE), /incomplete details/);
  }
  body = quoted();
  await assert.rejects(client.link(CODE, 'different-package', null), /incomplete details/);
});

test('sealed quote parsing validates exact Pokémon English package, price, image and timestamp', () => {
  assert.deepEqual(parseSealedQuote(quote(), CODE), quote());
  assert.equal(parseSealedQuote({...quote(), product: {...product(), marketCents: null, imageUrl: null}}, CODE).product.marketCents, null);
  for (const patch of [
    {code: 'another'}, {currency: 'CAD'}, {mappingSource: 'guessed'}, {mappingSource: ['saved']}, {fetchedAt: 'yesterday'}, {fetchedAt: '2026-13-55T01:00:00Z'},
    {product: null}, {product: {...product(), game: 'riftbound'}}, {product: {...product(), language: 'Japanese'}},
    {product: {...product(), marketCents: 0}}, {product: {...product(), marketCents: 1.2}}, {product: {...product(), marketCents: 100000001}},
    {product: {...product(), marketCents: undefined}}, {product: {...product(), setName: ''}}, {product: {...product(), name: 'x'.repeat(301)}},
    {product: {...product(), id: 'bad.id'}}, {product: {...product(), unit: '\nETB'}},
    {product: {...product(), imageUrl: 'https://example.com/product.jpg'}}, {product: {...product(), imageUrl: 'http://images.scrydex.com/product.jpg'}},
    {product: {...product(), imageUrl: 'https://account@images.scrydex.com/product.jpg'}},
  ]) assert.throws(() => parseSealedQuote({...quote(), ...patch}, CODE), /incomplete details/);
});

test('invalid codes, link identities and missing token fail before network access', async () => {
  let calls = 0;
  const client = createSealedPricingClient({getToken: async () => undefined, request: async () => { calls++; return Response.json(quoted()); }});
  for (const code of ['', ' '.repeat(3), 'x'.repeat(129), 'invalid\nbarcode']) await assert.rejects(client.scan(code), /manufacturer SKU/);
  await assert.rejects(client.link(CODE, '../invalid', null), /incomplete details/);
  await assert.rejects(client.link(CODE, product().id, ''), /incomplete details/);
  await assert.rejects(client.scan(CODE), /Sign in to Shopify POS/);
  assert.equal(calls, 0);
});

test('authorization and safe service errors remain actionable; malformed and oversized responses fail closed', async () => {
  let response = new Response('not json', {status: 401});
  const client = createSealedPricingClient({getToken: async () => 'token', request: async () => response});
  await assert.rejects(client.scan(CODE), /session could not access/);
  response = Response.json({error: 'This barcode match changed. Scan again before confirming.'}, {status: 409});
  await assert.rejects(client.link(CODE, product().id, 'old'), /match changed/);
  response = Response.json({error: 'x'.repeat(601)}, {status: 503});
  await assert.rejects(client.scan(CODE), /Live sealed pricing is unavailable/);
  for (const invalid of [new Response('invalid JSON'), new Response(' '.repeat(32001)), new Response('{}', {headers: {'Content-Length': '32001'}})]) {
    response = invalid;
    await assert.rejects(client.scan(CODE), /incomplete details/);
  }
  response = Response.json(quoted('wrong-code'));
  await assert.rejects(client.scan(CODE), /incomplete details/);
});

test('only a validated saved match is retained on an unavailable quote error', async () => {
  let match: unknown = {id: 'deleted-product', source: 'saved'};
  const client = createSealedPricingClient({getToken: async () => 'token', request: async () => Response.json({error: 'This product has no current price.', match}, {status: 422})});
  await assert.rejects(client.scan(CODE), error => {
    assert.ok(error instanceof SealedPricingError);
    assert.deepEqual(error.match, match);
    return true;
  });
  for (const value of [null, [], {id: '../invalid', source: 'saved'}, {id: 'product', source: 'guessed'}, {id: 'product', source: 'shopify'}]) {
    match = value;
    await assert.rejects(client.scan(CODE), /incomplete details/);
  }
});

test('deadline covers token acquisition and prevents a late token from starting a request', async (context) => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const token = deferred<string>();
  let requests = 0;
  const client = createSealedPricingClient({getToken: () => token.promise, request: async () => { requests++; return Response.json(quoted()); }});
  const pending = client.scan(CODE);
  const rejected = assert.rejects(pending, /timed out/);
  context.mock.timers.tick(30001);
  await rejected;
  token.resolve('late-token');
  await settle();
  assert.equal(requests, 0);
});

test('deadline bounds stalled response bodies and cancellation releases the reader', async (context) => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let canceled = false;
  const stream = new ReadableStream({start() {}, cancel() { canceled = true; }});
  const client = createSealedPricingClient({getToken: async () => 'token', request: async () => new Response(stream)});
  const pending = client.scan(CODE);
  const rejected = assert.rejects(pending, /timed out/);
  await settle();
  context.mock.timers.tick(30001);
  await rejected;
  assert.equal(canceled, true);
});

function fixture() {
  const updates: SealedPricingState[] = [];
  const scans: string[] = [];
  const links: {code: string; id: string; expectedId: string | null}[] = [];
  const searches: {game: string; query: string}[] = [];
  const details: {game: string; id: string}[] = [];
  const dependencies = {
    pricing: {
      scan: async (code: string, _signal?: AbortSignal): Promise<ScanResult> => { scans.push(code); return {status: 'unmapped', code}; },
      link: async (code: string, id: string, expectedId: string | null, _signal?: AbortSignal) => {
        links.push({code, id, expectedId});
        return quote(code, id, 'confirmed');
      },
    },
    catalog: {
      search: async (game: string, query: string): Promise<{products: CatalogProduct[]; hasMore: boolean}> => { searches.push({game, query}); return {products: [product()], hasMore: false}; },
      detail: async (game: string, id: string): Promise<CatalogProduct> => { details.push({game, id}); return product(id); },
    },
  };
  const controller = createSealedPricingController(dependencies, state => updates.push(state));
  const selected = () => {
    const state = controller.getState();
    assert.equal(state.kind, 'matching');
    if (state.kind !== 'matching' || state.catalog.kind !== 'selected') throw new Error('Expected selected product');
    return state.catalog;
  };
  async function select() {
    controller.editQuery('Surging Sparks Elite Trainer');
    await controller.search();
    await controller.select(product().id);
    return selected();
  }
  return {updates, scans, links, searches, details, dependencies, controller, select, selected};
}

test('unknown manufacturer codes require search, exact detail and explicit package confirmation before saving', async () => {
  const f = fixture();
  await f.controller.lookup(CODE);
  const selected = await f.select();
  assert.deepEqual(f.searches, [{game: 'pokemon', query: 'Surging Sparks Elite Trainer'}]);
  assert.deepEqual(f.details, [{game: 'pokemon', id: product().id}]);
  await f.controller.confirm(selected.selectionKey);
  assert.deepEqual(f.links, [], 'a result selection never saves a match by itself');
  f.controller.confirmPackage(selected.selectionKey, true);
  await Promise.all([f.controller.confirm(selected.selectionKey), f.controller.confirm(selected.selectionKey)]);
  assert.deepEqual(f.links, [{code: CODE, id: product().id, expectedId: null}]);
  assert.equal(f.controller.getState().kind, 'quoted');
});

test('new scan supersedes an in-flight scan, ignores late success/error and debounces an in-flight identical lookup', async () => {
  const f = fixture();
  const old = deferred<ScanResult>();
  f.dependencies.pricing.scan = async (code) => { f.scans.push(code); return code === CODE ? old.promise : quoted(code, 'new-product'); };
  const pending = f.controller.lookup(CODE);
  await f.controller.lookup(CODE);
  await f.controller.lookup('NEW-SKU');
  old.resolve(quoted());
  await pending;
  assert.deepEqual(f.scans, [CODE, 'NEW-SKU']);
  const current = f.controller.getState();
  assert.equal(current.kind, 'quoted');
  if (current.kind === 'quoted') assert.equal(current.quote.code, 'NEW-SKU');

  const lateError = deferred<ScanResult>();
  f.dependencies.pricing.scan = async () => lateError.promise;
  const failing = f.controller.lookup('OLD-SKU');
  f.controller.editCode('MANUAL-EDIT');
  lateError.reject(new Error('stale failure'));
  await failing;
  assert.deepEqual(f.controller.getState(), {kind: 'idle', code: 'MANUAL-EDIT'});
});

test('editing a query or barcode clears selection and rejects stale confirmations', async () => {
  const f = fixture();
  await f.controller.lookup(CODE);
  const first = await f.select();
  f.controller.confirmPackage(first.selectionKey, true);
  f.controller.editQuery('Another package');
  await f.controller.confirm(first.selectionKey);
  assert.deepEqual(f.links, []);
  const second = await f.select();
  f.controller.confirmPackage(first.selectionKey, true);
  assert.equal(f.selected().packageConfirmed, false, 'old checkbox events cannot confirm a new selection');
  f.controller.confirmPackage(second.selectionKey, true);
  await f.controller.confirm(first.selectionKey);
  assert.deepEqual(f.links, []);
  f.controller.editCode('NEW-CODE');
  await f.controller.confirm(second.selectionKey);
  assert.deepEqual(f.links, []);
  assert.deepEqual(f.controller.getState(), {kind: 'idle', code: 'NEW-CODE'});
});

test('late search and detail responses cannot repopulate an edited barcode or query', async () => {
  const f = fixture();
  await f.controller.lookup(CODE);
  const search = deferred<{products: CatalogProduct[]; hasMore: boolean}>();
  f.dependencies.catalog.search = async () => search.promise;
  f.controller.editQuery('First query');
  const pendingSearch = f.controller.search();
  f.controller.editCode('NEW-CODE');
  search.resolve({products: [product()], hasMore: false});
  await pendingSearch;
  assert.deepEqual(f.controller.getState(), {kind: 'idle', code: 'NEW-CODE'});

  await f.controller.lookup(CODE);
  f.controller.editQuery('Surging Sparks');
  await f.controller.search();
  const detail = deferred<CatalogProduct>();
  f.dependencies.catalog.detail = async () => detail.promise;
  const pendingDetail = f.controller.select(product().id);
  f.controller.editQuery('New query');
  detail.resolve(product());
  await pendingDetail;
  const state = f.controller.getState();
  assert.equal(state.kind, 'matching');
  if (state.kind === 'matching') {
    assert.deepEqual(state.catalog, {kind: 'idle'});
    assert.equal(state.query, 'New query');
  }
});

test('change matched product preserves saved match precondition through searches and edits', async () => {
  for (const source of ['saved', 'confirmed', 'shopify'] as const) {
    const f = fixture();
    f.dependencies.pricing.scan = async code => ({status: 'quoted', quote: quote(code, 'previous-product', source)});
    await f.controller.lookup(CODE);
    f.controller.changeMatch();
    const selected = await f.select();
    f.controller.confirmPackage(selected.selectionKey, true);
    await f.controller.confirm(selected.selectionKey);
    assert.deepEqual(f.links, [{code: CODE, id: product().id, expectedId: source === 'shopify' ? null : 'previous-product'}]);
  }
});

test('refresh obtains a fresh quote; any latest failure removes the old price', async () => {
  const f = fixture();
  let count = 0;
  f.dependencies.pricing.scan = async code => {
    count++;
    return {status: 'quoted', quote: {...quote(code), product: {...product(), marketCents: count === 1 ? 8999 : 9999}}};
  };
  await f.controller.lookup(CODE);
  await f.controller.refresh();
  assert.equal(count, 2);
  const state = f.controller.getState();
  if (state.kind !== 'quoted') throw new Error('Expected updated quote');
  assert.equal(state.quote.product.marketCents, 9999);
  f.dependencies.pricing.scan = async () => { throw new Error('Scrydex is unavailable'); };
  await f.controller.refresh();
  assert.deepEqual(f.controller.getState(), {kind: 'error', code: CODE, message: 'Scrydex is unavailable'});
  assert.equal('quote' in f.controller.getState(), false);
});

test('an unavailable saved quote can be remapped without restoring stale prices', async () => {
  const f = fixture();
  f.dependencies.pricing.scan = async () => { throw new SealedPricingError('This product has no current price.', {id: 'deleted-product', source: 'saved'}); };
  await f.controller.lookup(CODE);
  assert.equal('quote' in f.controller.getState(), false);
  f.controller.changeMatch();
  const selected = await f.select();
  f.controller.confirmPackage(selected.selectionKey, true);
  await f.controller.confirm(selected.selectionKey);
  assert.deepEqual(f.links, [{code: CODE, id: product().id, expectedId: 'deleted-product'}]);

  f.dependencies.pricing.scan = async () => { throw new Error('Network failure'); };
  await f.controller.lookup('NEXT');
  f.controller.changeMatch();
  assert.deepEqual(f.controller.getState(), {kind: 'error', code: 'NEXT', message: 'Network failure'});
});

test('new scan or disposal hides the completion of an already confirmed match', async () => {
  const f = fixture();
  await f.controller.lookup(CODE);
  const selected = await f.select();
  f.controller.confirmPackage(selected.selectionKey, true);
  const link = deferred<SealedQuote>();
  f.dependencies.pricing.link = async () => link.promise;
  const pending = f.controller.confirm(selected.selectionKey);
  await f.controller.lookup('NEXT-CODE');
  link.resolve(quote());
  await pending;
  assert.equal(f.controller.getState().code, 'NEXT-CODE');

  const scan = deferred<ScanResult>();
  f.dependencies.pricing.scan = async () => scan.promise;
  const last = f.controller.lookup('CLOSING');
  const updates = f.updates.length;
  f.controller.dispose();
  scan.resolve(quoted('CLOSING'));
  await last;
  assert.equal(f.updates.length, updates);
});

test('scanner ignores initial replay and rapid duplicate camera/hardware scans, then rearms', () => {
  let now = 1000;
  const gate = createSealedScanGate(CODE, () => now);
  assert.equal(gate.accept(CODE), false);
  assert.equal(gate.accept(` ${CODE} `), true);
  assert.equal(gate.accept(CODE), false);
  assert.equal(gate.accept('ANOTHER-CODE'), true);
  assert.equal(gate.accept(undefined), false);
  assert.equal(gate.accept(''), false);
  now += 750;
  assert.equal(gate.accept('ANOTHER-CODE'), true);
  gate.reset();
  assert.equal(gate.accept('ANOTHER-CODE'), true);
});
