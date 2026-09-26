import assert from 'node:assert/strict';
import test from 'node:test';
import {CheckoutService, type CheckoutInput} from '../extensions/receiving/src/receiving-checkout.ts';
import {barcodeKey, ReceivingError, stableJson} from '../extensions/receiving/src/receiving-validation.ts';
import type {GraphQL} from '../extensions/receiving/src/shopify-receiving-adapter.ts';

type Json = Record<string, any>;
const input: CheckoutInput = {requestId: 'checkout-000000000001', productId: 'gid://shopify/Product/1', variantId: 'gid://shopify/ProductVariant/2', sku: 'DEFY-S-000001', barcode: '0196214150478'};
const pos = 'gid://shopify/Publication/3';
const connection = (ids: string[] = []) => ({nodes: ids.map(id => ({publication: {id}})), pageInfo: {hasNextPage: false}});
function fixture() {
  const parent: Json = {id: input.productId, title: 'Perfect Order Booster Bundle', status: 'DRAFT', productType: 'Pokémon Sealed', pos: false,
    catalogId: {value: 'scrydex:pokemon:me3-s9'}, variants: {nodes: [{id: input.variantId}], pageInfo: {hasNextPage: false}},
    appChannels: connection(), marketChannels: connection(), companyChannels: connection(), noCatalogChannels: connection()};
  const node: Json = {id: input.variantId, sku: input.sku, barcode: input.barcode, title: 'Default Title', price: '34.99', pos: false,
    inventoryItem: {id: 'gid://shopify/InventoryItem/4', tracked: true}, unit: {value: 'Booster bundle'}, game: {value: 'Pokémon'}, barcodeId: {value: barcodeKey(input.barcode)}, product: parent};
  const calls: {query: string; variables: Json}[] = [];
  const fields = new Map<string, {value: string; compareDigest: string}>();
  const options = {scopes: ['write_products', 'write_publications'], publications: [{id: pos, name: 'Point of Sale'}], publicationsMore: false,
    barcodeMatches: [{id: input.variantId, barcode: input.barcode}], barcodesMore: false, pendingReceiving: null as Json | null,
    priceFailure: '' as '' | 'before' | 'after', publishFailure: '' as '' | 'product-after' | 'variant-before' | 'no-effect',
    casFailure: '' as '' | 'claim-after' | 'confirm-before', afterPrice: null as null | (() => void)};
  let revision = 0;
  const graphql: GraphQL = async <T>(query: string, variables: Json = {}): Promise<T> => {
    calls.push({query, variables: structuredClone(variables)});
    let result: Json;
    if (query.includes('query ReceivingCheckoutScopes')) result = {currentAppInstallation: {accessScopes: options.scopes.map(handle => ({handle}))}, shop: {receiving: {value: stableJson({version: 1, nextSequence: 2, pending: options.pendingReceiving})}}};
    else if (query.includes('query ReceivingCheckoutPublications')) result = {publications: {nodes: options.publications, pageInfo: {hasNextPage: options.publicationsMore}}};
    else if (query.includes('query ReceivingCheckoutVariant')) result = {productVariant: {...node, checkoutPrice: fields.get(variables.key) || null, activeCheckoutPrice: fields.get('checkout_price_attempt') || null}};
    else if (query.includes('query ReceivingCheckoutBarcodes')) {
      assert.equal(variables.query, 'barcode:"0196214150478" OR barcode:"196214150478"');
      assert.doesNotMatch(query, /barcodes\(/, 'receiving uses the pinned 2026-07 API');
      result = {productVariants: {nodes: options.barcodeMatches, pageInfo: {hasNextPage: options.barcodesMore}}};
    } else if (query.includes('mutation ReceivingCheckoutPriceCAS')) {
      assert.equal(variables.metafields.length, 2);
      for (const field of variables.metafields) {
        assert.equal(field.ownerId, input.variantId);
        assert.equal(field.namespace, '$app:receiving');
        assert.match(field.key, /^checkout_price_/);
        if (field.compareDigest !== (fields.get(field.key)?.compareDigest || null)) return {metafieldsSet: {metafields: [], userErrors: [{code: 'INVALID_COMPARE_DIGEST', message: 'Stale'}]}} as T;
      }
      const phase = JSON.parse(variables.metafields[0].value).phase;
      if (options.casFailure === 'confirm-before' && phase === 'applied') { options.casFailure = ''; throw new Error('Lost confirmation save'); }
      for (const field of variables.metafields) fields.set(field.key, {value: field.value, compareDigest: String(++revision)});
      if (options.casFailure === 'claim-after' && phase === 'pending') { options.casFailure = ''; throw new Error('Lost claim response'); }
      result = {metafieldsSet: {metafields: variables.metafields.map((field: Json) => ({id: `gid://shopify/Metafield/${field.key}`, compareDigest: fields.get(field.key)!.compareDigest})), userErrors: []}};
    } else if (query.includes('mutation ReceivingCheckoutPrice(')) {
      const pending = JSON.parse(fields.get('checkout_price_attempt')!.value);
      assert.equal(pending.phase, 'pending');
      assert.deepEqual(variables, {productId: input.productId, variants: [{id: input.variantId, price: pending.request.storePrice}]});
      const failure = options.priceFailure; options.priceFailure = '';
      if (failure === 'before') throw new Error('Lost connection before price');
      node.price = variables.variants[0].price;
      options.afterPrice?.();
      if (failure === 'after') throw new Error('Lost price response');
      result = {productVariantsBulkUpdate: {productVariants: [{id: node.id, price: node.price}], userErrors: []}};
    } else if (query.includes('mutation ReceivingCheckoutActivate')) {
      assert.deepEqual(variables, {product: {id: input.productId, status: 'ACTIVE'}});
      assert.ok(Number(node.price) > 0);
      parent.status = 'ACTIVE'; result = {productUpdate: {product: {id: parent.id, status: parent.status}, userErrors: []}};
    } else if (query.includes('mutation ReceivingCheckoutPublish')) {
      assert.deepEqual(variables.input, [{publicationId: pos}]);
      assert.ok([input.productId, input.variantId].includes(variables.id));
      if (variables.id === input.variantId && options.publishFailure === 'variant-before') { options.publishFailure = ''; throw new Error('Variant publication failed'); }
      if (options.publishFailure !== 'no-effect') {
        if (variables.id === input.productId) parent.pos = true;
        else node.pos = true;
      }
      if (variables.id === input.productId && options.publishFailure === 'product-after') { options.publishFailure = ''; throw new Error('Lost parent publication response'); }
      result = {publishablePublish: {userErrors: []}};
    } else throw new Error(`Unexpected GraphQL operation ${query}`);
    return structuredClone(result) as T;
  };
  return {service: new CheckoutService(graphql), calls, node, parent, fields, options,
    mutations: () => calls.filter(call => call.query.includes('mutation ')), priceWrites: () => calls.filter(call => call.query.includes('mutation ReceivingCheckoutPrice('))};
}

test('explicit checkout action activates only its received draft and publishes product and variant to POS', async () => {
  const f = fixture();
  // Variants can default to other channel memberships without being visible
  // there; it is the parent's memberships that gate safe draft activation.
  f.node.appChannels = connection(['gid://shopify/Publication/90']);
  const result = await f.service.prepare(input);
  assert.equal(result.product.status, 'ACTIVE');
  assert.equal(result.product.price, '34.99');
  assert.equal(result.product.barcode, input.barcode);
  assert.equal(result.publicationId, pos);
  assert.deepEqual(f.mutations().map(call => call.variables), [{product: {id: input.productId, status: 'ACTIVE'}}, {id: input.productId, input: [{publicationId: pos}]}, {id: input.variantId, input: [{publicationId: pos}]}]);
  assert.doesNotMatch(JSON.stringify(f.mutations()), /inventoryAdjust|inventoryActivate|inventoryQuantities|unitCost|metaobjectCreate|receiving_applied|receiving_intent/);
  const count = f.mutations().length;
  await f.service.prepare(input);
  assert.equal(f.mutations().length, count, 'ready products are read-only on retry');
});

test('Gundam sealed catalog drafts become checkout-ready without weakening source game and product type checks', async () => {
  const gundam = () => {
    const f = fixture();
    f.parent.title = 'Newtype Rising Booster Display';
    f.parent.productType = 'Gundam Sealed';
    f.parent.catalogId.value = 'scrydex:gundam:gd01-booster-display';
    f.node.game.value = 'Gundam';
    f.node.unit.value = 'Display';
    return f;
  };
  const f = gundam();
  const result = await f.service.prepare(input);
  assert.equal(result.product.game, 'Gundam');
  assert.equal(result.product.catalogId, 'scrydex:gundam:gd01-booster-display');
  assert.equal(result.product.status, 'ACTIVE');
  assert.equal(f.parent.pos, true);
  assert.equal(f.node.pos, true);
  assert.equal(f.priceWrites().length, 0);
  const manual = gundam();
  manual.parent.catalogId.value = barcodeKey(input.barcode);
  manual.parent.productType = '';
  assert.equal((await manual.service.prepare(input)).product.game, 'Gundam');
  assert.equal(manual.parent.pos, true);
  assert.equal(manual.node.pos, true);
  for (const change of [
    (item: ReturnType<typeof fixture>) => { item.node.game.value = 'Riftbound'; },
    (item: ReturnType<typeof fixture>) => { item.parent.productType = 'Gundam Single'; },
    (item: ReturnType<typeof fixture>) => { item.parent.catalogId.value = 'scrydex:unsupported:gd01-booster-display'; },
    (item: ReturnType<typeof fixture>) => { item.parent.catalogId.value = 'scrydex:gundam:../gd01'; },
  ]) {
    const invalid = gundam(); change(invalid);
    await assert.rejects(invalid.service.prepare(input), (error: ReceivingError) => error.code === 'CHECKOUT_DRAFT_REVIEW');
    assert.equal(invalid.mutations().length, 0);
  }
});

test('positive explicit store price repairs an old zero-priced item without receiving stock or rewriting its barcode', async () => {
  const f = fixture(); f.node.price = '0.00';
  const result = await f.service.prepare({...input, storePrice: ' 39.5 '});
  assert.equal(result.product.price, '39.50');
  assert.equal(f.priceWrites().length, 1);
  assert.equal(JSON.parse(f.fields.get('checkout_price_attempt')!.value).phase, 'applied');
  assert.doesNotMatch(JSON.stringify(f.mutations()), /"barcode"\s*:\s*"019/); // Only frozen journal JSON carries identity.
  assert.equal(f.node.barcode, input.barcode);
});

test('blank price requires a current positive selling price; zero, negative, and invalid entered prices fail before writes', async () => {
  const f = fixture(); f.node.price = '0.00';
  await assert.rejects(f.service.prepare(input), (error: ReceivingError) => error.code === 'CHECKOUT_PRICE_REQUIRED');
  for (const storePrice of ['0', '-1', '2.999', '1000000.01']) await assert.rejects(f.service.prepare({...input, storePrice}), /Store price/);
  assert.equal(f.mutations().length, 0);
});

test('scope, ambiguous POS publication, archived and unsupported registered identities stop before writes', async () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.options.scopes = ['write_products']; },
    (f: ReturnType<typeof fixture>) => { f.options.publications.push({id: 'gid://shopify/Publication/5', name: 'Point of Sale'}); },
    (f: ReturnType<typeof fixture>) => { f.options.publicationsMore = true; },
    (f: ReturnType<typeof fixture>) => { f.parent.status = 'ARCHIVED'; },
    (f: ReturnType<typeof fixture>) => { f.node.id = 'gid://shopify/ProductVariant/8'; },
    (f: ReturnType<typeof fixture>) => { f.parent.id = 'gid://shopify/Product/8'; },
    (f: ReturnType<typeof fixture>) => { f.node.sku = 'OTHER'; },
    (f: ReturnType<typeof fixture>) => { f.node.barcode = '036000291452'; },
    (f: ReturnType<typeof fixture>) => { f.node.barcodeId.value = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.parent.catalogId.value = 'defy:single:1'; },
    (f: ReturnType<typeof fixture>) => { f.node.inventoryItem.tracked = false; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(f.service.prepare({...input, storePrice: '39.99'}));
    assert.equal(f.mutations().length, 0);
  }
});

test('every draft parent catalog membership and truncated list is reviewed before price or activation', async () => {
  for (const alias of ['appChannels', 'marketChannels', 'companyChannels', 'noCatalogChannels']) for (const truncated of [false, true]) {
    const f = fixture();
    if (truncated) f.parent[alias].pageInfo.hasNextPage = true;
    else f.parent[alias] = connection(['gid://shopify/Publication/99']);
    await assert.rejects(f.service.prepare({...input, storePrice: '39.99'}), (error: ReceivingError) => error.code === 'CHECKOUT_CHANNEL_REVIEW');
    assert.equal(f.mutations().length, 0);
  }
});

test('draft or unpublished multi-variant parents require Admin review; a POS parent can enable only the selected variant', async () => {
  for (const status of ['DRAFT', 'ACTIVE']) {
    const f = fixture(); f.parent.status = status; f.parent.variants.nodes.push({id: 'gid://shopify/ProductVariant/8'});
    await assert.rejects(f.service.prepare(input), /other variants|other variants at checkout/);
    assert.equal(f.mutations().length, 0);
  }
  const f = fixture(); f.parent.status = 'ACTIVE'; f.parent.pos = true; f.parent.variants.nodes.push({id: 'gid://shopify/ProductVariant/8'});
  await f.service.prepare(input);
  assert.deepEqual(f.mutations().map(call => call.variables), [{id: input.variantId, input: [{publicationId: pos}]}]);
});

test('barcode aliases collide exactly and incomplete barcode search fails closed', async () => {
  for (const truncated of [false, true]) {
    const f = fixture();
    if (truncated) f.options.barcodesMore = true;
    else f.options.barcodeMatches.push({id: 'gid://shopify/ProductVariant/8', barcode: '196214150478'});
    await assert.rejects(f.service.prepare({...input, storePrice: '39.99'}), /barcode/);
    assert.equal(f.mutations().length, 0);
  }
  const f = fixture();
  f.options.barcodeMatches.push({id: 'gid://shopify/ProductVariant/8', barcode: '036000291452'});
  await assert.rejects(f.service.prepare(input), /more than one Shopify variant/);
  assert.equal(f.mutations().length, 0, 'a search result matching an unexposed additional barcode must not be discarded');
});

test('unfinished receiving for this package blocks checkout without changing receipt or inventory', async () => {
  const f = fixture(); f.options.pendingReceiving = {plannedSku: input.sku, request: {barcode: input.barcode}};
  await assert.rejects(f.service.prepare(input), (error: ReceivingError) => error.code === 'CHECKOUT_RECEIVING_PENDING');
  assert.equal(f.mutations().length, 0);
});

test('partial product or variant publication retries verify existing price without another price write', async () => {
  for (const stage of ['product-after', 'variant-before'] as const) {
    const f = fixture(); f.options.publishFailure = stage;
    const request = {...input, storePrice: '39.99'};
    await assert.rejects(f.service.prepare(request), (error: ReceivingError) => error.committedPossible);
    const result = await f.service.prepare(request);
    assert.equal(result.product.status, 'ACTIVE');
    assert.equal(f.node.pos, true);
    assert.equal(f.parent.pos, true);
    assert.equal(f.priceWrites().length, 1);
  }
});

test('price timeout and confirmation-save timeout recover read-only from the same or reopened request', async () => {
  for (const failure of ['after', 'confirm-before'] as const) for (const reopened of [false, true]) {
    const f = fixture();
    if (failure === 'after') f.options.priceFailure = failure;
    else f.options.casFailure = failure;
    const request = {...input, storePrice: '39.99'};
    await assert.rejects(f.service.prepare(request));
    await f.service.prepare(reopened ? {...input, requestId: 'checkout-000000000002'} : request);
    assert.equal(f.priceWrites().length, 1);
    assert.equal(JSON.parse(f.fields.get(`checkout_price_${input.requestId}`)!.value).phase, 'applied');
  }
});

test('uncertain old price never overwrites a later price after retry or modal reopening with a new request ID', async () => {
  const f = fixture(); f.options.priceFailure = 'after';
  const request = {...input, storePrice: '39.99'};
  await assert.rejects(f.service.prepare(request));
  f.node.price = '49.99';
  for (const next of [request, {...request, requestId: 'checkout-000000000002'}, {...input, requestId: 'checkout-000000000003'}]) {
    await assert.rejects(f.service.prepare(next), /different price|39.99/);
  }
  assert.equal(f.priceWrites().length, 1);
  assert.equal(f.node.price, '49.99');
  assert.equal(f.parent.status, 'DRAFT');
  f.node.price = '39.99'; // Owner reconciliation enables read-only recovery.
  await f.service.prepare({...input, requestId: 'checkout-000000000004'});
  assert.equal(f.priceWrites().length, 1);
});

test('lost initial CAS response never permits a guessed price write on retry', async () => {
  const f = fixture(); f.options.casFailure = 'claim-after';
  const request = {...input, storePrice: '39.99'};
  await assert.rejects(f.service.prepare(request));
  await assert.rejects(f.service.prepare(request), /different price/);
  assert.equal(f.priceWrites().length, 0);
});

test('price details remain immutable and completed requests never overwrite a newer explicit price', async () => {
  const f = fixture(); const original = {...input, storePrice: '39.99'};
  await f.service.prepare(original);
  await assert.rejects(f.service.prepare({...original, storePrice: '49.99'}), /different or damaged price details/);
  await assert.rejects(f.service.prepare(input), /different or damaged price details/);
  await f.service.prepare({...input, requestId: 'checkout-000000000002', storePrice: '49.99'});
  await assert.rejects(f.service.prepare(original), (error: ReceivingError) => error.code === 'CHECKOUT_PRICE_REVIEW' && error.committedPossible);
  assert.equal(f.node.price, '49.99');
  assert.equal(f.priceWrites().length, 2);
});

test('a late price writer cannot overwrite a newer pending request marker after a peer confirmed its request', async () => {
  const f = fixture();
  const nextRequest = {...input, requestId: 'checkout-000000000002', storePrice: '49.99'};
  f.options.afterPrice = () => {
    const oldKey = `checkout_price_${input.requestId}`;
    const old = JSON.parse(f.fields.get(oldKey)!.value);
    f.fields.set(oldKey, {value: stableJson({...old, phase: 'applied'}), compareDigest: 'peer-confirmed'});
    const next = {...old, request: nextRequest, fingerprint: stableJson(nextRequest), before: '39.99', phase: 'pending'};
    f.fields.set('checkout_price_attempt', {value: stableJson(next), compareDigest: 'new-pending'});
  };
  await assert.rejects(f.service.prepare({...input, storePrice: '39.99'}), /still unconfirmed/);
  assert.equal(JSON.parse(f.fields.get('checkout_price_attempt')!.value).request.requestId, nextRequest.requestId);
  assert.equal(JSON.parse(f.fields.get('checkout_price_attempt')!.value).phase, 'pending');
});

test('a publication response without confirmed visibility never reports checkout success', async () => {
  const f = fixture(); f.options.publishFailure = 'no-effect';
  await assert.rejects(f.service.prepare(input), (error: ReceivingError) => error.code === 'CHECKOUT_UNCERTAIN' && error.committedPossible);
});
