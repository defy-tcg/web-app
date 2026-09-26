import assert from 'node:assert/strict';
import test from 'node:test';
import {CATALOG_GAMES, SEALED_CATALOG_URL, catalogIdentity, createSealedCatalogClient, type CatalogProduct} from '../extensions/receiving/src/catalog-client.ts';
import {createCatalogController, type CatalogState} from '../extensions/receiving/src/catalog-controller.ts';
import type {Product} from '../extensions/receiving/src/receiving-service.ts';

const catalogProduct = (): CatalogProduct => ({id: 'ogb-1', game: 'riftbound', name: 'Origins Booster Display', setName: 'Origins', language: 'English', unit: 'Display', imageUrl: 'https://images.scrydex.com/origins.jpg', marketCents: 15000});
const shopifyProduct = (): Product => ({sku: 'DEFY-000045', barcode: '', name: 'Origins Booster Display', game: 'Riftbound', unit: 'Display', variantId: 'gid://shopify/ProductVariant/1', productId: 'gid://shopify/Product/1', inventoryItemId: 'gid://shopify/InventoryItem/1', barcodeNeedsReview: false, tracked: true, status: 'DRAFT'});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {promise, resolve};
}

test('catalog requests use a fresh POS session bearer and exact bounded search/detail bodies', async () => {
  let tokens = 0;
  const calls: {url: string; input: RequestInit}[] = [];
  const client = createSealedCatalogClient({getToken: async () => `session-${++tokens}`, request: async (url, input) => {
    calls.push({url: String(url), input: input!});
    return calls.length === 1 ? json({products: [catalogProduct()], hasMore: false}) : json({product: catalogProduct()});
  }});
  const search = await client.search('riftbound', '  Origins Booster  ');
  assert.equal(search.products[0].id, 'ogb-1');
  assert.equal((await client.detail('riftbound', 'ogb-1')).name, 'Origins Booster Display');
  assert.deepEqual(calls.map(call => call.url), [SEALED_CATALOG_URL, SEALED_CATALOG_URL]);
  assert.deepEqual(calls.map(call => JSON.parse(String(call.input.body))), [{game: 'riftbound', query: 'Origins Booster'}, {game: 'riftbound', id: 'ogb-1'}]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.input.method, 'POST');
    assert.equal(new Headers(call.input.headers).get('Authorization'), `Bearer session-${index + 1}`);
    assert.ok(call.input.signal);
  }
});

test('Gundam catalog search and exact selection preserve game identity through the scanner registration flow', async () => {
  const gundam: CatalogProduct = {id: 'gd01-booster-display', game: 'gundam', name: 'Newtype Rising Booster Display', setName: 'Newtype Rising',
    language: 'English', unit: 'Display', imageUrl: null, marketCents: null};
  const requests: unknown[] = [];
  const client = createSealedCatalogClient({getToken: async () => 'gundam-session', request: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer gundam-session');
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return json('query' in body ? {products: [gundam], hasMore: false} : {product: gundam});
  }});
  const controller = createCatalogController({client,
    findCatalogProduct: async reference => {
      assert.deepEqual(reference, {game: 'gundam', id: gundam.id});
      return {ok: true, found: false, product: null};
    },
    searchProducts: async ({query}) => { assert.equal(query, gundam.name); return {ok: true, products: [], hasMore: false}; },
  }, () => {});
  await controller.search('gundam', '  Newtype Rising  ');
  assert.equal(controller.getState().kind, 'results');
  await controller.select('gundam', gundam.id);
  assert.deepEqual(requests, [{game: 'gundam', query: 'Newtype Rising'}, {game: 'gundam', id: gundam.id}]);
  const selected = controller.getState();
  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.canRegister, true);
  assert.equal(CATALOG_GAMES[selected.product.game], 'Gundam');
  assert.deepEqual(catalogIdentity(selected.product), {game: 'gundam', id: gundam.id, name: gundam.name, setName: gundam.setName, language: 'English'});
  const mismatch = createSealedCatalogClient({getToken: async () => 'session', request: async () => json({product: {...gundam, game: 'riftbound'}})});
  await assert.rejects(mismatch.detail('gundam', gundam.id), /incomplete/);
});

test('catalog refuses invalid inputs and absent POS authentication before any request', async () => {
  let requests = 0;
  const client = createSealedCatalogClient({getToken: async () => undefined, request: async () => { requests++; return json({}); }});
  await assert.rejects(client.search('pokemon', 'ab'), /3 and 100/);
  await assert.rejects(client.search('pokemon', 'a'.repeat(101)), /3 and 100/);
  await assert.rejects(client.detail('pokemon', 'unexpected.id'), /incomplete/);
  await assert.rejects(client.search('pokemon', 'Booster'), /Sign in to Shopify POS/);
  assert.equal(requests, 0);
});

test('catalog bounds response records and bytes and validates exact English game/id and safe images', async () => {
  let response: Response;
  const client = createSealedCatalogClient({getToken: async () => 'session', request: async () => response});
  for (const patch of [
    {game: 'pokemon'}, {language: 'Japanese'}, {marketCents: 0}, {marketCents: 100000001}, {marketCents: 1.5},
    {imageUrl: 'https://example.com/image.jpg'}, {imageUrl: 'http://images.scrydex.com/image.jpg'}, {name: 'n'.repeat(301)},
    {setName: ''}, {marketCents: undefined}, {imageUrl: undefined},
  ]) {
    response = json({product: {...catalogProduct(), ...patch}});
    await assert.rejects(client.detail('riftbound', 'ogb-1'), /incomplete/);
  }
  response = json({product: {...catalogProduct(), id: 'different'}});
  await assert.rejects(client.detail('riftbound', 'ogb-1'), /incomplete/);
  response = json({products: [catalogProduct(), catalogProduct()], hasMore: false});
  await assert.rejects(client.search('riftbound', 'Origins'), /incomplete/);
  response = json({products: Array.from({length: 21}, (_, n) => ({...catalogProduct(), id: `product-${n}`})), hasMore: true});
  await assert.rejects(client.search('riftbound', 'Origins'), /incomplete/);
  response = new Response(' '.repeat(128001));
  await assert.rejects(client.search('riftbound', 'Origins'), /incomplete/);
  response = json({product: {...catalogProduct(), imageUrl: null, marketCents: null}});
  assert.equal((await client.detail('riftbound', 'ogb-1')).marketCents, null);
});

test('catalog exposes actionable authorization/upstream failures without accepting partial records', async () => {
  let response = new Response('not JSON', {status: 401});
  const client = createSealedCatalogClient({getToken: async () => 'session', request: async () => response});
  await assert.rejects(client.search('riftbound', 'Origins'), /session could not access/);
  response = json({error: 'Catalog temporarily unavailable.'}, 503);
  await assert.rejects(client.search('riftbound', 'Origins'), /Catalog temporarily unavailable/);
  response = json({products: [catalogProduct()]});
  await assert.rejects(client.search('riftbound', 'Origins'), /incomplete/);
});

function controllerFixture() {
  const calls: string[] = [];
  const updates: CatalogState[] = [];
  const dependencies = {
    client: {
      search: async (_game: string, query: string) => { calls.push(`search:${query}`); return {products: [catalogProduct()], hasMore: false}; },
      detail: async (_game: string, id: string) => { calls.push(`detail:${id}`); return catalogProduct(); },
    },
    findCatalogProduct: async (_input: {game: string; id: string}): Promise<{ok: true; found: boolean; product: Product | null} | {ok: false; error: {message: string}}> => {
      calls.push('mapping'); return {ok: true, found: false, product: null};
    },
    searchProducts: async ({query}: {query: string}): Promise<{ok: true; products: Product[]; hasMore: boolean} | {ok: false; error: {message: string}}> => {
      calls.push(`shopify:${query}`); return {ok: true, products: [], hasMore: false};
    },
  };
  const controller = createCatalogController(dependencies, state => updates.push(state));
  return {calls, updates, dependencies, controller};
}

test('selection re-fetches exact detail and checks both Shopify identity and full name before offering registration', async () => {
  const f = controllerFixture();
  await f.controller.search('riftbound', 'Origins');
  await f.controller.select('riftbound', 'ogb-1');
  assert.deepEqual(f.calls, ['search:Origins', 'detail:ogb-1', 'mapping', 'shopify:Origins Booster Display']);
  const selected = f.controller.getState();
  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.canRegister, true);
  assert.deepEqual(catalogIdentity(selected.product), {game: 'riftbound', id: 'ogb-1', name: 'Origins Booster Display', setName: 'Origins', language: 'English'});
  assert.equal(CATALOG_GAMES[selected.product.game], 'Riftbound');
  assert.equal('marketCents' in catalogIdentity(selected.product), false, 'market price must never become receiving cost');
  f.controller.reset();
  assert.deepEqual(f.controller.getState(), {kind: 'idle'});
});

test('existing catalog mapping preserves its SKU and a truncated Shopify search never permits registration', async () => {
  const f = controllerFixture();
  f.dependencies.findCatalogProduct = async () => ({ok: true, found: true, product: shopifyProduct()});
  f.dependencies.searchProducts = async () => ({ok: true, products: [shopifyProduct()], hasMore: false});
  await f.controller.select('riftbound', 'ogb-1');
  let selected = f.controller.getState();
  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.existing.length, 1);
  assert.equal(selected.existing[0].sku, 'DEFY-000045');
  assert.equal(selected.canRegister, false);
  assert.equal(selected.mapped, true);
  f.dependencies.findCatalogProduct = async () => ({ok: true, found: false, product: null});
  f.dependencies.searchProducts = async () => ({ok: true, products: [], hasMore: true});
  await f.controller.select('riftbound', 'ogb-1');
  selected = f.controller.getState();
  assert.equal(selected.kind, 'selected');
  if (selected.kind !== 'selected') return;
  assert.equal(selected.hasMoreExisting, true);
  assert.equal(selected.canRegister, false);
});

test('failed existing-product checks never produce a registerable selection', async () => {
  const f = controllerFixture();
  f.dependencies.findCatalogProduct = async () => ({ok: false, error: {message: 'Duplicate catalog mapping needs review.'}});
  await f.controller.select('riftbound', 'ogb-1');
  assert.deepEqual(f.controller.getState(), {kind: 'error', message: 'Duplicate catalog mapping needs review.'});
  f.dependencies.findCatalogProduct = async () => ({ok: true, found: false, product: null});
  f.dependencies.searchProducts = async () => ({ok: false, error: {message: 'Shopify search unavailable.'}});
  await f.controller.select('riftbound', 'ogb-1');
  assert.deepEqual(f.controller.getState(), {kind: 'error', message: 'Shopify search unavailable.'});
});

test('reset for a new barcode suppresses stale detail, stale Shopify matches and concurrent selection', async () => {
  const f = controllerFixture();
  const detail = deferred<CatalogProduct>();
  f.dependencies.client.detail = async () => detail.promise;
  const selection = f.controller.select('riftbound', 'ogb-1');
  assert.equal(f.controller.isBusy(), true);
  await f.controller.search('pokemon', 'Booster');
  assert.deepEqual(f.calls, [], 'busy controller must not start another search');
  f.controller.reset();
  detail.resolve(catalogProduct());
  await selection;
  assert.deepEqual(f.controller.getState(), {kind: 'idle'});
  assert.deepEqual(f.calls, [], 'stale detail must not trigger Shopify lookups');

  f.dependencies.client.detail = async () => catalogProduct();
  const mapping = deferred<{ok: true; found: boolean; product: Product | null}>();
  f.dependencies.findCatalogProduct = async () => mapping.promise;
  const second = f.controller.select('riftbound', 'ogb-1');
  await new Promise(resolve => setImmediate(resolve));
  f.controller.reset();
  await f.controller.search('riftbound', 'New package');
  mapping.resolve({ok: true, found: true, product: shopifyProduct()});
  await second;
  assert.equal(f.controller.getState().kind, 'results');
  assert.equal(f.controller.isBusy(), false);
});

test('disposal prevents late catalog results from repopulating a closed receiver', async () => {
  const f = controllerFixture();
  const search = deferred<{products: CatalogProduct[]; hasMore: boolean}>();
  f.dependencies.client.search = async () => search.promise;
  const pending = f.controller.search('riftbound', 'Origins');
  f.controller.dispose();
  search.resolve({products: [catalogProduct()], hasMore: false});
  await pending;
  assert.deepEqual(f.updates, [{kind: 'searching'}]);
});
