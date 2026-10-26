import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// This release's explicitly approved validation branch. Do not relax this guard
// to point at production; a later test branch needs its own reviewed constants.
// In the managed workspace use NODE_USE_ENV_PROXY=1 with Node 24, the existing
// .env.local, and scripts/native-warehouse-test-resolver.mjs (NATIVE_SOURCE_ROOT).
const TEST_BRANCH = 'br-broad-sky-afc4v1ft';
const TEST_HOST = 'ep-damp-base-affgvlby-pooler.c-2.us-west-2.aws.neon.tech';
if (process.env.BULK_TEST_BRANCH_ID !== TEST_BRANCH || process.env.BULK_TEST_EXPECTED_DB_HOST !== TEST_HOST) {
  throw new Error('The explicitly approved isolated Bulk Warehouse test branch is required.');
}
let connection;
try { connection = new URL(process.env.DATABASE_URL || ''); }
catch { throw new Error('The isolated test database is not configured.'); }
if (connection.hostname !== TEST_HOST || connection.hostname !== process.env.BULK_TEST_EXPECTED_DB_HOST ||
  !['postgres:', 'postgresql:'].includes(connection.protocol)) {
  throw new Error('DATABASE_URL does not match the approved isolated branch endpoint.');
}

const { neon } = await import('@neondatabase/serverless');
const { BulkError, digest, parseCommand, parseNativeOrderSale, parseSync } = await import('../lib/bulk-warehouse/model.ts');
const { inventoryQuery, queueBulkCommand, readBulkInventory, readBulkSales, readNativeOrderForSale, recordNativeOrderSale, syncBulkWarehouse } = await import('../lib/bulk-warehouse/store.ts');
const sql = neon(process.env.DATABASE_URL);
const owner = `bulk-test-owner-${randomUUID()}`;
const actor = `bulk-test-actor-${randomUUID()}`;
const tag = `bulk-test-${randomUUID()}`;
const warehouses = [randomUUID(), randomUUID(), randomUUID()];
const warehouseId = warehouses[0];
const name = `${tag} RFB`;
const baseCopy = (id, changes = {}) => {
  const data = { masterId: `printing-${id}`, serial: `${tag}-${id}`, name: `${name} card ${id}`, setName: 'Origins', cardNumber: id,
    rarity: 'Common', sku: `${tag}-SKU-${id}`, condition: 'Near Mint', finish: 'Nonfoil', language: 'EN', status: 'available',
    available: true, location: 'Test box / row 1', tcgplayerUrl: 'https://www.tcgplayer.com/product/12345',
    imageUrl: 'https://example.test/fixture-card.png', costCents: 20, listPriceCents: 200, ...changes };
  delete data.fingerprint;
  return { ...data, fingerprint: digest(data) };
};
const copies = new Map(Array.from({ length: 112 }, (_, index) => {
  const id = `copy-${String(index).padStart(3, '0')}`;
  return [id, baseCopy(id, index === 1 || index === 7 ? { costCents: null }
    : index === 2 || index === 3 ? { costCents: 2_000_000_000 }
    : index === 5 ? { name: `${name} literal_%\\card` }
    : index === 8 ? { available: false, status: 'quarantine' } : {})];
}));
const id = number => `copy-${String(number).padStart(3, '0')}`;
let ack = 0;
let currentCase = 'schema baseline';
let passed = 0;
let failed = false;
let fixturesMayExist = false;
const check = async (label, run) => { currentCase = label; await run(); passed++; process.stdout.write(`PASS ${label}\n`); };
const expectStatus = (run, status) => assert.rejects(run, error => error instanceof BulkError && error.status === status);
const payload = (events = [], receipts = [], overrides = {}) => parseSync({ protocol: 1, warehouseId, workspace: 'riftbound', name: `${tag} Mac`, after: ack, events, receipts, ...overrides });
async function sync(input, principal = owner) {
  const result = await syncBulkWarehouse(principal, input);
  if (input.warehouseId === warehouseId) ack = result.ackSequence;
  return result;
}
const event = (number, copyId, changes) => ({ sequence: number, kind: 'copy', entityId: copyId, data: baseCopy(copyId, { ...copies.get(copyId), ...changes }) });
const deletion = (number, copyId) => ({ sequence: number, kind: 'delete', entityId: copyId, data: null });
const orderData = (copyIds, changes = {}) => {
  const data = { reference: `${tag} native fulfillment`, status: 'shipped', copyIds,
    createdAt: '2020-01-02T03:04:05.000Z', storeCommandId: null, ...changes };
  return { ...data, fingerprint: digest(data) };
};
const orderEvent = (number, orderId, data) => ({ sequence: number, kind: 'order', entityId: orderId, data });
const orderDeletion = (number, orderId) => ({ sequence: number, kind: 'order_delete', entityId: orderId, data: null });
const receipt = (commandId, appliedSequence, status = 'applied', message = 'Synthetic fixture confirmation') => ({ commandId, appliedSequence, status, message });
const command = (copyIds, changes = {}) => parseCommand({ requestId: randomUUID(), kind: 'remove', warehouseId,
  copies: copyIds.map(copyId => ({ copyId, expectedFingerprint: copies.get(copyId).fingerprint })), note: tag, sale: null, ...changes });
const saleTerms = (changes = {}) => ({ unitPriceCents: 200, unitCostCents: null, soldAt: new Date().toISOString(), channel: 'Test in-store', paymentMethod: 'Test', discountCents: 1, taxCents: 37, ...changes });
const filters = (changes = {}) => inventoryQuery(new URL(`https://example.test/api/bulk-warehouse?${new URLSearchParams({ q: name, workspace: 'riftbound', status: 'all', page: '1', ...changes })}`));
const row = async copyId => (await sql`SELECT * FROM defy_bulk.copies WHERE warehouse_id=${warehouseId}::uuid AND copy_id=${copyId}`)[0];
const commandRow = async commandId => (await sql`SELECT * FROM defy_bulk.commands WHERE warehouse_id=${warehouseId}::uuid AND id=${commandId}::uuid`)[0];
const fixtureSales = async () => (await readBulkSales()).sales.filter(sale => typeof sale.id === 'string' && sale.note === tag);
const physicalState = async () => (await sql`SELECT
  (SELECT ack_sequence::float8 FROM defy_bulk.warehouses WHERE id=${warehouseId}::uuid) AS sequence,
  (SELECT count(*)::int FROM defy_bulk.events WHERE warehouse_id=${warehouseId}::uuid) AS events,
  (SELECT count(*)::int FROM defy_bulk.holds WHERE warehouse_id=${warehouseId}::uuid) AS holds,
  (SELECT md5(string_agg(copy_id||sequence::text||deleted::text||COALESCE(data::text,''),',' ORDER BY copy_id)) FROM defy_bulk.copies WHERE warehouse_id=${warehouseId}::uuid) AS stock_hash`)[0];
const orderAmount = (orderId, data, changes = {}) => parseNativeOrderSale({ requestId: randomUUID(), warehouseId, orderId,
  expectedFingerprint: data.fingerprint, copyIds: data.copyIds, note: tag,
  sale: { subtotalCents: 1001, discountCents: 1, taxCents: 9, totalCostCents: 401, soldAt: '2026-01-03T10:00:00.000Z', channel: 'Actual native order', paymentMethod: 'Test' }, ...changes });

try {
  if (process.argv.includes('--apply-schema')) {
    currentCase = 'apply additive SQL to the guarded test branch';
    const source = await readFile(new URL('../db/bulk-warehouse.sql', import.meta.url), 'utf8');
    const statements = [];
    let start = 0;
    for (let index = 0; index < source.length; index++) {
      if (source.slice(index, index + 2) === '--') {
        const end = source.indexOf('\n', index + 2);
        index = end < 0 ? source.length : end;
      } else if (source[index] === "'" || source[index] === '"') {
        const quote = source[index++];
        for (; index < source.length; index++) {
          if (source[index] !== quote) continue;
          if (source[index + 1] === quote) { index++; continue; }
          break;
        }
      } else if (source[index] === '$') {
        const tag = /^\$[a-zA-Z0-9_]*\$/.exec(source.slice(index))?.[0];
        if (tag) {
          const end = source.indexOf(tag, index + tag.length);
          if (end < 0) throw new Error('Unterminated SQL function body.');
          index = end + tag.length - 1;
        }
      } else if (source[index] === ';') {
        const statement = source.slice(start, index + 1).trim();
        if (statement) statements.push(statement);
        start = index + 1;
      }
    }
    if (source.slice(start).trim()) throw new Error('Unexpected unterminated SQL statement.');
    await sql.transaction(statements.map(statement => sql.query(statement, [])));
    process.stdout.write('Current additive SQL applied only to the approved test branch.\n');
  }
  await check('isolated schema exists and all three workspaces register separately', async () => {
    assert.equal((await sql`SELECT to_regnamespace('defy_bulk') IS NOT NULL AS ready`)[0].ready, true);
    fixturesMayExist = true;
    for (const [index, workspace] of ['riftbound', 'mtg', 'pokemon'].entries()) {
      const result = await syncBulkWarehouse(owner, payload([], [], { warehouseId: warehouses[index], workspace, after: 0, name: `${tag} ${workspace}` }));
      assert.equal(result.ackSequence, 0);
    }
    const records = await sql`SELECT id,owner_id,workspace FROM defy_bulk.warehouses WHERE owner_id=${owner}`;
    assert.equal(records.length, 3);
    assert.deepEqual(records.map(record => record.workspace).sort(), ['mtg', 'pokemon', 'riftbound']);
  });

  const initial = payload([...copies].map(([copyId, data], index) => ({ sequence: index + 1, kind: 'copy', entityId: copyId, data })));
  await check('full initial stock arrives with exact identities and unavailable cards preserved', async () => {
    const result = await sync(initial);
    assert.equal(result.ackSequence, 112);
    const resultRows = await readBulkInventory(filters());
    assert.equal(resultRows.total, 112);
    assert.equal(resultRows.copies.length, 100);
    assert.equal((await row(id(8))).data.available, false);
    assert.equal((await row(id(1))).data.costCents, null);
  });

  await check('lost sync response replays exactly without duplicating copies or events', async () => {
    assert.equal((await sync(initial)).ackSequence, 112);
    const counts = await sql`SELECT
      (SELECT count(*)::int FROM defy_bulk.events WHERE warehouse_id=${warehouseId}::uuid) AS events,
      (SELECT count(*)::int FROM defy_bulk.copies WHERE warehouse_id=${warehouseId}::uuid) AS copies`;
    assert.deepEqual(counts[0], { events: 112, copies: 112 });
  });

  await check('conflicting replay, missing history and changed workspace fail without writes', async () => {
    const conflict = structuredClone(initial);
    conflict.events[0].data = baseCopy(id(0), { name: 'Conflicting replacement' });
    await expectStatus(() => syncBulkWarehouse(owner, conflict), 409);
    await expectStatus(() => syncBulkWarehouse(owner, payload([], [], { after: 113 })), 409);
    await expectStatus(() => syncBulkWarehouse(owner, payload([], [], { workspace: 'mtg' })), 409);
    assert.equal((await row(id(0))).data.fingerprint, copies.get(id(0)).fingerprint);
    assert.equal(Number((await sql`SELECT ack_sequence FROM defy_bulk.warehouses WHERE id=${warehouseId}::uuid`)[0].ack_sequence), 112);
  });

  await check('a second approved store actor can sync the same Mac while its original creator remains auditable', async () => {
    const otherEvent = payload([event(ack + 1, id(110), { location: 'Test box / row 2' })]);
    const result = await sync(otherEvent, actor);
    assert.equal(result.ackSequence, 113);
    assert.equal((await sql`SELECT owner_id FROM defy_bulk.warehouses WHERE id=${warehouseId}::uuid`)[0].owner_id, owner);
    assert.equal((await sql`SELECT event->>'_actorId' AS actor FROM defy_bulk.events WHERE warehouse_id=${warehouseId}::uuid AND sequence=${ack}`)[0].actor, actor);
  });

  await check('explicit deletion removes one copy and empty incremental sync never wipes remaining stock', async () => {
    const tombstone = payload([deletion(ack + 1, id(111))]);
    await sync(tombstone);
    await sync(payload());
    assert.equal((await row(id(111))).deleted, true);
    assert.equal((await readBulkInventory(filters())).total, 111);
    await sync(tombstone);
    assert.equal((await readBulkInventory(filters())).total, 111);
  });

  await check('search escapes percent underscore and backslash while filtering and paging remain exact', async () => {
    const first = await readBulkInventory(filters());
    const second = await readBulkInventory(filters({ page: '2' }));
    assert.equal(first.copies.length, 100);
    assert.equal(second.copies.length, 11);
    assert.equal(new Set([...first.copies, ...second.copies].map(copy => copy.copyId)).size, 111);
    const literal = await readBulkInventory(filters({ q: `${name} literal_%\\card` }));
    assert.equal(literal.total, 1);
    assert.equal(literal.copies[0].copyId, id(5));
    assert.equal((await readBulkInventory(filters({ workspace: 'mtg' }))).total, 0);
    assert.equal((await readBulkInventory(filters({ status: 'available' }))).total, 110);
    assert.equal((await readBulkInventory(filters({ status: 'unavailable' }))).total, 1);
  });

  let winning;
  await check('concurrent requests for one physical copy create exactly one pending hold', async () => {
    const attempts = Array.from({ length: 8 }, () => command([id(0)]));
    const results = await Promise.all(attempts.map(input => queueBulkCommand(actor, input)));
    assert.equal(results.filter(result => result.status === 'pending').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 7);
    winning = attempts[results.findIndex(result => result.status === 'pending')];
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE warehouse_id=${warehouseId}::uuid AND copy_id=${id(0)}`)[0].count, 1);
    const pending = await readBulkInventory(filters({ q: copies.get(id(0)).serial }));
    assert.equal(pending.copies[0].pending, true);
    assert.equal((await readBulkInventory(filters({ q: copies.get(id(0)).serial, status: 'available' }))).total, 0);
  });

  await check('queue retries are idempotent and request ID/body or actor collisions are rejected', async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => queueBulkCommand(actor, winning)));
    assert.ok(responses.every(result => result.id === winning.requestId && result.status === 'pending'));
    await expectStatus(() => queueBulkCommand(actor, parseCommand({ ...winning, note: 'changed body' })), 409);
    await expectStatus(() => queueBulkCommand('other-actor', winning), 409);
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.commands WHERE id=${winning.requestId}::uuid`)[0].count, 1);
  });

  await check('stale comparison rejects the complete selection without reserving its valid cards', async () => {
    const stale = command([id(1), id(4)]);
    stale.copies[1].expectedFingerprint = 'f'.repeat(64);
    const result = await queueBulkCommand(actor, parseCommand(stale));
    assert.equal(result.status, 'rejected');
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE command_id=${stale.requestId}::uuid`)[0].count, 0);
    assert.equal((await row(id(1))).data.available, true);
  });

  await check('native rejection releases a hold and repeated receipts cannot change the decision', async () => {
    const rejected = receipt(winning.requestId, ack, 'rejected', 'Card changed locally');
    await sync(payload([], [rejected]));
    assert.equal((await commandRow(winning.requestId)).status, 'rejected');
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE command_id=${winning.requestId}::uuid`)[0].count, 0);
    await sync(payload([], [rejected]));
    await expectStatus(() => syncBulkWarehouse(owner, payload([], [receipt(winning.requestId, ack)])), 409);
    assert.equal((await row(id(0))).data.available, true);
    assert.equal((await fixtureSales()).length, 0);
  });

  let saleCommand;
  let saleReceipt;
  await check('a sale receipt arriving ahead of its stock events remains pending with no revenue', async () => {
    saleCommand = command([id(0), id(1)], { kind: 'sale', sale: saleTerms() });
    assert.equal((await queueBulkCommand(actor, saleCommand)).status, 'pending');
    saleReceipt = receipt(saleCommand.requestId, ack + 2);
    const response = await sync(payload([], [saleReceipt]));
    assert.equal(response.receipts.find(item => item.commandId === saleCommand.requestId)?.status, 'pending');
    assert.equal((await commandRow(saleCommand.requestId)).status, 'pending');
    assert.equal((await fixtureSales()).length, 0);
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE command_id=${saleCommand.requestId}::uuid`)[0].count, 2);
  });

  await check('matching stock events finalize sale once with exact money and unknown-cost disclosure', async () => {
    const changes = payload([event(ack + 1, id(0), { available: false, status: 'sold' }), deletion(ack + 2, id(1))]);
    await sync(changes);
    assert.equal((await commandRow(saleCommand.requestId)).status, 'applied');
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE command_id=${saleCommand.requestId}::uuid`)[0].count, 0);
    let sales = await fixtureSales();
    assert.equal(sales.length, 1);
    const record = sales[0];
    assert.equal(record.inventorySource, 'bulk_warehouse');
    assert.equal(record.subtotalCents, 400);
    assert.equal(record.discountCents, 1);
    assert.equal(record.taxCents, 37);
    assert.equal(record.totalCents, 436);
    assert.equal(record.cogsCents, 20);
    assert.equal(record.costIncomplete, true);
    const childLines = (await readBulkSales()).saleItems.filter(item => item.saleId === record.id);
    assert.equal(childLines.length, 2);
    assert.equal(childLines.reduce((sum, item) => sum + item.discountCents, 0), 1);
    assert.equal(childLines.reduce((sum, item) => sum + item.taxCents, 0), 37);
    assert.equal(childLines.filter(item => item.costIncomplete).length, 1);
    assert.ok(childLines.every(item => item.inventorySource === 'bulk_warehouse'));
    await sync(changes);
    await sync(payload([], [saleReceipt]));
    assert.equal((await queueBulkCommand(actor, saleCommand)).status, 'applied');
    sales = await fixtureSales();
    assert.equal(sales.length, 1);
  });

  await check('an invalid receipt rolls back otherwise valid copy events and the sequence atomically', async () => {
    const before = ack;
    const invalid = payload([event(ack + 1, id(4), { available: false, status: 'removed' })], [receipt(randomUUID(), ack + 1)]);
    await expectStatus(() => syncBulkWarehouse(owner, invalid), 409);
    assert.equal(Number((await sql`SELECT ack_sequence FROM defy_bulk.warehouses WHERE id=${warehouseId}::uuid`)[0].ack_sequence), before);
    assert.equal((await row(id(4))).data.available, true);
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.events WHERE warehouse_id=${warehouseId}::uuid AND sequence=${before + 1}`)[0].count, 0);
  });

  await check('multi-copy removals wait for every confirmed stock change and do not create sales', async () => {
    const removal = command([id(4), id(5)]);
    assert.equal((await queueBulkCommand(actor, removal)).status, 'pending');
    const applied = receipt(removal.requestId, ack + 2);
    await sync(payload([deletion(ack + 1, id(4))], [applied]));
    assert.equal((await commandRow(removal.requestId)).status, 'pending');
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE command_id=${removal.requestId}::uuid`)[0].count, 2);
    await sync(payload([deletion(ack + 1, id(5))]));
    assert.equal((await commandRow(removal.requestId)).status, 'applied');
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.holds WHERE command_id=${removal.requestId}::uuid`)[0].count, 0);
    assert.equal((await fixtureSales()).length, 1);
  });

  await check('known high acquisition costs sum beyond PostgreSQL integer range without blocking sync', async () => {
    const input = command([id(2), id(3)], { kind: 'sale', sale: saleTerms({ unitPriceCents: 1, discountCents: 0, taxCents: 0 }) });
    assert.equal((await queueBulkCommand(actor, input)).status, 'pending');
    await sync(payload([deletion(ack + 1, id(2)), deletion(ack + 2, id(3))], [receipt(input.requestId, ack + 2)]));
    const record = (await fixtureSales()).find(sale => sale.id === `bulk:${input.requestId}`);
    assert.ok(record);
    assert.equal(record.cogsCents, 4_000_000_000);
    assert.equal(record.costIncomplete, false);
    assert.equal(record.totalCents, 2);
  });

  await check('explicit known zero cost differs from missing acquisition cost', async () => {
    const input = command([id(7)], { kind: 'sale', sale: saleTerms({ unitCostCents: 0, discountCents: 0, taxCents: 0 }) });
    assert.equal((await queueBulkCommand(actor, input)).status, 'pending');
    await sync(payload([deletion(ack + 1, id(7))], [receipt(input.requestId, ack + 1)]));
    const record = (await fixtureSales()).find(sale => sale.id === `bulk:${input.requestId}`);
    assert.equal(record.cogsCents, 0);
    assert.equal(record.costIncomplete, false);
    assert.equal((await readBulkSales(2)).hasMore, true);
    assert.equal((await fixtureSales()).length, 3);
  });

  await check('final stock/report read excludes tombstones and retains unsold copies', async () => {
    const inventory = await readBulkInventory(filters());
    assert.equal(inventory.total, 105);
    assert.equal((await readBulkInventory(filters({ status: 'available' }))).total, 103);
    assert.equal((await readBulkInventory(filters({ status: 'unavailable' }))).total, 2);
    assert.equal((await row(id(6))).data.available, true);
    const report = await readBulkSales();
    const selected = report.sales.filter(sale => sale.note === tag);
    assert.equal(selected.length, 3);
    for (const sale of selected) {
      const lines = report.saleItems.filter(item => item.saleId === sale.id);
      assert.equal(lines.reduce((sum, item) => sum + item.quantity, 0), sale.itemsCount);
      assert.equal(lines.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0), sale.subtotalCents);
      assert.equal(lines.reduce((sum, item) => sum + item.quantity * item.unitCostCents, 0), sale.cogsCents);
    }
  });

  const baselineUnpriced = (await readBulkSales()).unpricedNativeOrders;
  await check('order and copy IDs may collide without replacing stock or masking receipt proof', async () => {
    const removal = command([id(6)]);
    await queueBulkCommand(actor, removal);
    await sync(payload([
      event(ack + 1, id(6), { available: false, status: 'removed' }),
      orderEvent(ack + 2, id(6), orderData([id(6)], { storeCommandId: removal.requestId })),
    ], [receipt(removal.requestId, ack + 2)]));
    assert.equal((await commandRow(removal.requestId)).status, 'applied');
    assert.equal((await row(id(6))).data.available, false);
    assert.equal((await row(id(6))).data.masterId, `printing-${id(6)}`);
    assert.equal((await readBulkSales()).unpricedNativeOrders, baselineUnpriced + 1, 'a removal command is not a financial sale');
    assert.equal((await fixtureSales()).length, 3);
  });

  let nativeOrderBatch;
  let nativePendingSale;
  await check('native order links require the same warehouse, exact physical copies and an actual recorded sale', async () => {
    nativePendingSale = command([id(9)], { kind: 'sale', sale: saleTerms({ discountCents: 0, taxCents: 0 }) });
    await queueBulkCommand(actor, nativePendingSale);
    nativeOrderBatch = payload([
      orderEvent(ack + 1, 'linked-order', orderData([id(1), id(0)], { reference: 'Different human reference', storeCommandId: saleCommand.requestId })),
      orderEvent(ack + 2, 'wrong-copies-order', orderData([id(0)], { storeCommandId: saleCommand.requestId })),
      orderEvent(ack + 3, 'reference-only-order', orderData([id(0), id(1)], { reference: `BW-${saleCommand.requestId.slice(0, 8).toUpperCase()}` })),
      orderEvent(ack + 4, 'pending-sale-order', orderData([id(9)], { storeCommandId: nativePendingSale.requestId })),
    ]);
    await sync(nativeOrderBatch);
    await syncBulkWarehouse(owner, payload([
      orderEvent(1, 'foreign-command-order', orderData([id(0), id(1)], { storeCommandId: saleCommand.requestId })),
    ], [], { warehouseId: warehouses[1], workspace: 'mtg', after: 0 }));
    const inventory = await readBulkInventory(filters());
    assert.equal(inventory.unpricedOrderCount, baselineUnpriced + 5);
    assert.equal(inventory.unpricedOrders.some(order => order.warehouseId === warehouseId && order.orderId === 'linked-order'), false);
    assert.equal(inventory.unpricedOrders.find(order => order.warehouseId === warehouseId && order.orderId === 'wrong-copies-order')?.createdAt, '2020-01-02T03:04:05.000Z');
    assert.equal((await fixtureSales()).length, 3, 'fulfillment metadata must never create zero-dollar or guessed-date sales');
    assert.equal((await readBulkSales()).unpricedNativeOrders, baselineUnpriced + 5);
  });

  await check('order replay is idempotent and order tombstones/cancellations preserve stock and recorded money', async () => {
    await sync(nativeOrderBatch);
    assert.equal((await readBulkSales()).unpricedNativeOrders, baselineUnpriced + 5);
    const conflict = structuredClone(nativeOrderBatch);
    conflict.events[0].data.reference = 'Conflicting replay';
    await expectStatus(() => syncBulkWarehouse(owner, conflict), 409);
    await sync(payload([
      orderDeletion(ack + 1, id(6)), orderDeletion(ack + 2, 'wrong-copies-order'),
      orderEvent(ack + 3, 'reference-only-order', orderData([id(0), id(1)], { status: 'cancelled' })),
      orderEvent(ack + 4, 'linked-order', orderData([id(0), id(1)], { status: 'cancelled', storeCommandId: saleCommand.requestId })),
    ]));
    assert.equal((await row(id(6))).deleted, false, 'an order tombstone must not delete a copy sharing its ID');
    assert.equal((await row(id(6))).data.available, false);
    assert.equal((await fixtureSales()).length, 3, 'fulfillment cancellation alone does not prove a refund');
    assert.equal((await readBulkSales()).unpricedNativeOrders, baselineUnpriced + 2);
  });

  await check('unpriced native order disappears only when its real priced command becomes recorded', async () => {
    await sync(payload([deletion(ack + 1, id(9))], [receipt(nativePendingSale.requestId, ack + 1)]));
    assert.equal((await commandRow(nativePendingSale.requestId)).status, 'applied');
    assert.equal((await readBulkSales()).unpricedNativeOrders, baselineUnpriced + 1);
    assert.equal((await fixtureSales()).length, 4);
  });

  await check('unpriced order list is bounded to fifty while coverage counts include every shipped order', async () => {
    await sync(payload(Array.from({ length: 52 }, (_, index) => orderEvent(ack + index + 1, `unpriced-page-${index}`,
      orderData([id(10)], { createdAt: new Date(Date.now() + index * 1000).toISOString() })))));
    const inventory = await readBulkInventory(filters());
    assert.equal(inventory.unpricedOrders.length, 50);
    assert.equal(inventory.unpricedOrderCount, baselineUnpriced + 53);
    assert.equal((await readBulkSales()).unpricedNativeOrders, baselineUnpriced + 53);
    assert.equal((await fixtureSales()).length, 4);
  });

  const manualData = orderData([id(12), id(10), id(11)], { reference: 'Manual actual amount fixture' });
  const unknownData = orderData([id(13)], { reference: 'Unknown cost fixture' });
  const zeroData = orderData([id(15)], { reference: 'Explicit known zero fixture' });
  await check('native amount review exposes exact order/copy comparison and omits empty orders from pricing', async () => {
    const before = (await readBulkSales()).unpricedNativeOrders;
    await sync(payload([
      orderEvent(ack + 1, 'manual-amount-order', manualData), orderEvent(ack + 2, 'manual-unknown-order', unknownData),
      orderEvent(ack + 3, 'manual-zero-order', zeroData), orderEvent(ack + 4, 'empty-native-order', orderData([])),
    ]));
    const detail = await readNativeOrderForSale({ warehouseId, orderId: 'manual-amount-order' });
    assert.equal(detail.financialStatus, 'unpriced');
    assert.deepEqual(detail.order.copyIds, manualData.copyIds);
    assert.equal(detail.order.fingerprint, manualData.fingerprint);
    assert.equal(detail.order.createdAt, manualData.createdAt);
    assert.equal((await readNativeOrderForSale({ warehouseId, orderId: 'empty-native-order' })).financialStatus, 'ineligible');
    assert.equal((await readBulkSales()).unpricedNativeOrders, before + 3);
  });

  await check('stale order amount requests are durably rejected without changing stock or revenue', async () => {
    const before = await physicalState();
    const stale = orderAmount('manual-amount-order', manualData, { expectedFingerprint: 'f'.repeat(64) });
    assert.equal((await recordNativeOrderSale(actor, stale)).status, 'rejected');
    assert.equal((await recordNativeOrderSale(actor, stale)).status, 'rejected');
    assert.equal((await commandRow(stale.requestId)).status, 'rejected');
    const wrongCopies = orderAmount('manual-amount-order', manualData, { copyIds: [id(10)] });
    assert.equal((await recordNativeOrderSale(actor, wrongCopies)).status, 'rejected');
    assert.deepEqual(await physicalState(), before);
    assert.equal((await fixtureSales()).length, 4);
  });

  let recordedAmount;
  let amountWinner;
  await check('concurrent actual amount submissions record one aggregate sale without any stock mutation', async () => {
    const before = await physicalState();
    const requests = Array.from({ length: 5 }, () => orderAmount('manual-amount-order', manualData));
    const outcomes = await Promise.all(requests.map(input => recordNativeOrderSale(actor, input)));
    assert.equal(outcomes.filter(result => result.status === 'applied').length, 1);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 4);
    const winner = outcomes.findIndex(result => result.status === 'applied');
    amountWinner = requests[winner]; recordedAmount = outcomes[winner];
    const report = await readBulkSales();
    const sale = report.sales.find(sale => sale.id === recordedAmount.saleId);
    assert.ok(sale);
    assert.equal(sale.totalCents, 1009);
    assert.equal(sale.itemsCount, 3);
    assert.equal(sale.cogsCents, 401);
    assert.equal(sale.costIncomplete, false);
    assert.equal(sale.soldAt, amountWinner.sale.soldAt);
    assert.notEqual(sale.soldAt, manualData.createdAt);
    const lines = report.saleItems.filter(line => line.saleId === sale.id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].aggregate, true);
    assert.equal(lines[0].quantity, 3);
    assert.equal(lines[0].unitPriceCents, null);
    assert.equal(lines[0].unitCostCents, null);
    assert.equal(lines[0].lineSubtotalCents, 1001);
    assert.equal(lines[0].lineCostCents, 401);
    assert.equal('copyIds' in lines[0], false, 'reports do not need the stored exact-copy audit array');
    const stored = (await sql`SELECT data->'items'->0->'copyIds' AS copies FROM defy_bulk.sales
      WHERE warehouse_id=${warehouseId}::uuid AND id=${recordedAmount.saleId}`)[0];
    assert.deepEqual(stored.copies, manualData.copyIds);
    assert.deepEqual(await physicalState(), before);
    assert.equal((await readNativeOrderForSale({ warehouseId, orderId: 'manual-amount-order' })).financialStatus, 'recorded');
  });

  await check('lost amount responses replay once and financial receipts are never delivered to native stock handlers', async () => {
    const before = await physicalState();
    const repeats = await Promise.all(Array.from({ length: 4 }, () => recordNativeOrderSale(actor, amountWinner)));
    assert.ok(repeats.every(result => result.status === 'applied' && result.saleId === recordedAmount.saleId));
    await expectStatus(() => recordNativeOrderSale('other-test-actor', amountWinner), 409);
    await expectStatus(() => recordNativeOrderSale(actor, { ...amountWinner, note: 'Changed request body' }), 409);
    const duplicate = await recordNativeOrderSale(actor, orderAmount('manual-amount-order', manualData));
    assert.equal(duplicate.status, 'rejected');
    const response = await sync(payload());
    assert.equal(response.commands.some(command => command.id === amountWinner.requestId), false);
    await expectStatus(() => syncBulkWarehouse(owner, payload([], [receipt(amountWinner.requestId, ack)])), 409);
    assert.deepEqual(await physicalState(), before);
    assert.equal((await fixtureSales()).length, 5);
  });

  await check('native amount capture rejects existing or pending priced command links with durable outcomes', async () => {
    const pending = command([id(14)], { kind: 'sale', sale: saleTerms() });
    await queueBulkCommand(actor, pending);
    const pendingData = orderData([id(14)], { storeCommandId: pending.requestId });
    const alreadyPriced = orderData([id(0), id(1)], { storeCommandId: saleCommand.requestId });
    await sync(payload([orderEvent(ack + 1, 'amount-pending-link', pendingData), orderEvent(ack + 2, 'amount-recorded-link', alreadyPriced)]));
    assert.equal((await readNativeOrderForSale({ warehouseId, orderId: 'amount-pending-link' })).financialStatus, 'pending');
    assert.equal((await recordNativeOrderSale(actor, orderAmount('amount-pending-link', pendingData))).status, 'rejected');
    assert.equal((await recordNativeOrderSale(actor, orderAmount('amount-recorded-link', alreadyPriced))).status, 'rejected');
    assert.equal((await fixtureSales()).length, 5);
    await sync(payload([], [receipt(pending.requestId, ack, 'rejected', 'Synthetic pending sale cleanup')]));
  });

  await check('entered aggregate totals can exceed integer range while unknown and known zero costs remain distinct', async () => {
    const unknown = orderAmount('manual-unknown-order', unknownData);
    unknown.sale = { ...unknown.sale, subtotalCents: 2_000_000_000, discountCents: 0, taxCents: 2_000_000_000, totalCostCents: null };
    const high = await recordNativeOrderSale(actor, unknown);
    assert.equal(high.status, 'applied');
    let report = await readBulkSales();
    assert.equal(report.sales.find(sale => sale.id === high.saleId).totalCents, 4_000_000_000);
    assert.equal(report.sales.find(sale => sale.id === high.saleId).costIncomplete, true);
    const zero = orderAmount('manual-zero-order', zeroData);
    zero.sale = { ...zero.sale, subtotalCents: 0, discountCents: 0, taxCents: 0, totalCostCents: 0 };
    const free = await recordNativeOrderSale(actor, zero);
    assert.equal(free.status, 'applied');
    report = await readBulkSales();
    assert.equal(report.sales.find(sale => sale.id === free.saleId).totalCents, 0);
    assert.equal(report.sales.find(sale => sale.id === free.saleId).costIncomplete, false);
  });

  await check('native order edits/cancellation/deletion retain the original financial snapshot without automatic refund', async () => {
    const before = (await readBulkSales()).sales.find(sale => sale.id === recordedAmount.saleId);
    await sync(payload([orderEvent(ack + 1, 'manual-amount-order', orderData([id(10)], { status: 'cancelled', reference: 'Changed after recording' }))]));
    assert.equal((await readNativeOrderForSale({ warehouseId, orderId: 'manual-amount-order' })).financialStatus, 'recorded');
    await sync(payload([orderDeletion(ack + 1, 'manual-amount-order')]));
    const after = (await readBulkSales()).sales.find(sale => sale.id === recordedAmount.saleId);
    assert.deepEqual(after, before);
    assert.equal('nativeOrderSnapshot' in after, false, 'reports omit the stored audit snapshot');
    const stored = (await sql`SELECT data->'nativeOrderSnapshot' AS snapshot FROM defy_bulk.sales
      WHERE warehouse_id=${warehouseId}::uuid AND id=${recordedAmount.saleId}`)[0];
    assert.deepEqual(stored.snapshot.copyIds, manualData.copyIds);
    assert.equal(stored.snapshot.status, 'shipped');
    assert.equal((await recordNativeOrderSale(actor, amountWinner)).status, 'applied', 'a saved receipt survives later native deletion');
    assert.equal((await fixtureSales()).length, 7);
  });

  await check('two 50,000-copy orders produce compact reports while their exact stored audits remain intact', async () => {
    const copyIds = Array.from({ length: 50_000 }, (_, index) => String(index + 1).padStart(20, '0'));
    const saleIds = [];
    for (const suffix of ['one', 'two']) {
      const orderId = `compact-report-${suffix}`;
      const data = orderData(copyIds, { reference: `Large native report fixture ${suffix}` });
      // Each real native sync batch is byte-bounded; send these large orders
      // separately instead of inventing one oversized multi-order request.
      await sync(payload([orderEvent(ack + 1, orderId, data)]));
      const recorded = await recordNativeOrderSale(actor, orderAmount(orderId, data));
      assert.equal(recorded.status, 'applied');
      saleIds.push(recorded.saleId);
    }
    const auditRows = () => sql`WITH expected AS (SELECT ${JSON.stringify(copyIds)}::jsonb AS copies)
      SELECT s.id,md5(s.data::text) AS "auditHash",
        s.data->'nativeOrderSnapshot'->'copyIds'=expected.copies AS "snapshotExact",
        s.data->'items'->0->'copyIds'=expected.copies AS "itemExact"
      FROM defy_bulk.sales s CROSS JOIN expected
      WHERE s.warehouse_id=${warehouseId}::uuid AND s.native_order_id IN ('compact-report-one','compact-report-two')
      ORDER BY s.id`;
    const storedBefore = await auditRows();
    assert.equal(storedBefore.length, 2);
    assert.ok(storedBefore.every(row => row.snapshotExact && row.itemExact));
    const report = await readBulkSales();
    const sales = report.sales.filter(sale => saleIds.includes(sale.id));
    const items = report.saleItems.filter(item => saleIds.includes(item.saleId));
    assert.equal(sales.length, 2);
    assert.equal(items.length, 2);
    assert.ok(sales.every(sale => !('nativeOrderSnapshot' in sale) && sale.itemsCount === 50_000 && sale.totalCents === 1009));
    assert.ok(items.every(item => !('copyIds' in item) && item.aggregate && item.quantity === 50_000 && item.lineSubtotalCents === 1001));
    assert.ok(Buffer.byteLength(JSON.stringify({ sales, items })) < 12_000,
      'report size stays bounded by financial fields, not the underlying physical copy count');
    assert.deepEqual(await auditRows(), storedBefore, 'reporting leaves both complete immutable sale receipts untouched');
  });
} catch (error) {
  failed = true;
  let message = error instanceof Error ? error.message : 'Unknown test failure';
  for (const secret of [process.env.DATABASE_URL, connection.password]) if (secret) message = message.replaceAll(secret, '[redacted]');
  process.stderr.write(`FAIL ${currentCase}: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (!fixturesMayExist) process.stdout.write('No synthetic Bulk Warehouse fixtures were written.\n');
  else try {
    for (const warehouse of warehouses) {
      // Every delete is bound to this run's random warehouse AND owner. Existing
      // data from the branch, public store, Shopify and authentication are untouched.
      await sql.transaction([
        sql`DELETE FROM defy_bulk.holds WHERE warehouse_id=${warehouse}::uuid AND EXISTS(SELECT 1 FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner})`,
        sql`DELETE FROM defy_bulk.sales WHERE warehouse_id=${warehouse}::uuid AND EXISTS(SELECT 1 FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner})`,
        sql`DELETE FROM defy_bulk.commands WHERE warehouse_id=${warehouse}::uuid AND EXISTS(SELECT 1 FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner})`,
        sql`DELETE FROM defy_bulk.orders WHERE warehouse_id=${warehouse}::uuid AND EXISTS(SELECT 1 FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner})`,
        sql`DELETE FROM defy_bulk.copies WHERE warehouse_id=${warehouse}::uuid AND EXISTS(SELECT 1 FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner})`,
        sql`DELETE FROM defy_bulk.events WHERE warehouse_id=${warehouse}::uuid AND EXISTS(SELECT 1 FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner})`,
        sql`DELETE FROM defy_bulk.warehouses WHERE id=${warehouse}::uuid AND owner_id=${owner}`,
      ]);
    }
    assert.equal((await sql`SELECT count(*)::int AS count FROM defy_bulk.warehouses WHERE owner_id=${owner}`)[0].count, 0);
    process.stdout.write('Synthetic Bulk Warehouse fixtures removed.\n');
  } catch {
    failed = true;
    process.exitCode = 1;
    process.stderr.write(`Fixture cleanup failed for this run's owner ${owner}. Review only that isolated fixture scope.\n`);
  }
  process.stdout.write(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', cases: passed, branch: TEST_BRANCH, productionTouched: false }) + '\n');
}
