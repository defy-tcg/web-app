import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { reserveSkuLabel, saveSkuLabelsToInventory } from "../lib/sku-label-inventory-storage.ts";
import { SkuLabelInventoryError, type InventoryLabelInput } from "../lib/sku-label-inventory.ts";
import { generateSkuBatch } from "../lib/sku-labels.ts";

const enabled = process.env.SKU_LABEL_RESERVE_INTEGRATION === "1" && Boolean(process.env.SKU_LABEL_RESERVE_TEST_DATABASE_URL);
// This integration test may write only to the reviewed development endpoint.
const DEVELOPMENT_HOST = "ep-square-truth-af9c9mha-pooler.c-2.us-west-2.aws.neon.tech";

test("evergreen QR reservations persist once, reuse variants, serialize writers, and preserve existing inventory", { skip: !enabled }, async () => {
  const databaseUrl = process.env.SKU_LABEL_RESERVE_TEST_DATABASE_URL!;
  assert.equal(new URL(databaseUrl).hostname, DEVELOPMENT_HOST, "Use the allowlisted development Neon branch only.");
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrl;
  const sql = neon(databaseUrl);
  const marker = `QR reserve test ${randomUUID()}`;
  const skus = generateSkuBatch(12, [], "TEST");
  const legacySku = `LEGACY-${randomUUID()}`;
  const ownedSkus = [...skus, legacySku];
  const catalogId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  const label: InventoryLabelInput = {
    sku: skus[0], name: marker, game: "Riftbound", setName: "Reserve test", cardNumber: "TEST-001",
    condition: "Near Mint", finish: "Normal", quantity: 99, costCents: 999, listPriceCents: 1999,
    tcgplayerId: catalogId,
  };
  try {
    const initial = await reserveSkuLabel(label);
    assert.equal(initial.created, true);
    assert.equal(initial.product.sku, skus[0]);
    assert.equal(initial.product.quantity, 0);
    assert.equal(initial.product.costCents, 0);
    assert.equal(initial.product.listPriceCents, 0);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM inventory_movements WHERE product_id = ${initial.product.id}`)[0].count, 0);
    const retry = await reserveSkuLabel(label);
    assert.equal(retry.created, false);
    assert.equal(retry.product.id, initial.product.id);

    await sql`UPDATE products SET quantity = 7, cost_cents = 321, list_price_cents = 654,
      price_source = 'scrydex', location = 'TEST SHELF', rarity = 'Existing rarity'
      WHERE id = ${initial.product.id}`;
    const before = (await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${initial.product.id}`)[0].product;
    const reused = await reserveSkuLabel({ ...label, sku: skus[1], name: `${marker} changed catalog spelling`, finish: "Nonfoil", location: "NEW" });
    assert.equal(reused.created, false);
    assert.equal(reused.product.sku, skus[0]);
    assert.deepEqual((await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${initial.product.id}`)[0].product, before);
    for (const sku of [skus[0], skus[1]]) {
      await assert.rejects(() => reserveSkuLabel({ ...label, sku, tcgplayerId: catalogId + 1 }),
        (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409 && error.existingSku === skus[0]);
    }
    assert.equal((await sql`SELECT count(*)::integer AS count FROM products WHERE tcgplayer_id = ${catalogId + 1}`)[0].count, 0);
    await sql`INSERT INTO products (sku, name, product_type, game, set_name, card_number, condition, finish)
      VALUES (${skus[10]}, ${`${marker} without catalog ID`}, 'Single', 'Riftbound', 'Reserve test', 'TEST-001', 'Near Mint', 'Normal')`;
    const canonical = await reserveSkuLabel({ ...label, sku: skus[11], name: `${marker} without catalog ID`, tcgplayerId: catalogId + 1 });
    assert.equal(canonical.created, false);
    assert.equal(canonical.product.sku, skus[10]);
    assert.equal(canonical.product.tcgplayerId, null);

    const concurrentLabel = { ...label, name: `${marker} concurrent`, tcgplayerId: catalogId + 2 };
    const concurrent = await Promise.all([
      reserveSkuLabel({ ...concurrentLabel, sku: skus[2] }),
      reserveSkuLabel({ ...concurrentLabel, sku: skus[3] }),
    ]);
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    assert.equal(concurrent[0].product.id, concurrent[1].product.id);
    assert.equal(concurrent[0].product.sku, concurrent[1].product.sku);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM products WHERE tcgplayer_id = ${catalogId + 2}`)[0].count, 1);

    const damaged = await reserveSkuLabel({ ...label, sku: skus[4], condition: "Damaged" });
    const foil = await reserveSkuLabel({ ...label, sku: skus[5], finish: "Foil" });
    assert.equal(damaged.created, true);
    assert.equal(foil.created, true);
    assert.notEqual(damaged.product.id, foil.product.id);

    await assert.rejects(() => reserveSkuLabel({ ...concurrentLabel, sku: skus[0] }),
      (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409 && error.existingSku === skus[0]);
    await sql`INSERT INTO products (sku, barcode, name, product_type, game)
      VALUES (${skus[6]}, ${skus[7]}, ${`${marker} barcode blocker`}, 'Sealed', 'Riftbound')`;
    await assert.rejects(() => reserveSkuLabel({ ...label, name: `${marker} barcode collision`, tcgplayerId: catalogId + 3, sku: skus[7] }),
      (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409 && error.existingSku === skus[6]);

    await sql`INSERT INTO products (sku, name, product_type, game, set_name, card_number, condition, finish, tcgplayer_id)
      VALUES (${legacySku}, ${`${marker} legacy`}, 'Single', 'Riftbound', 'Reserve test', 'TEST-001', 'Near Mint', 'Normal', ${catalogId + 4})`;
    await assert.rejects(() => reserveSkuLabel({ ...label, name: `${marker} legacy`, tcgplayerId: catalogId + 4, sku: skus[8] }),
      (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409 && error.existingSku === legacySku);

    const saveRaceLabel = { ...label, sku: skus[9], name: `${marker} regular save race`, tcgplayerId: catalogId + 5, quantity: 2 };
    const [reserved, saved] = await Promise.all([reserveSkuLabel(saveRaceLabel), saveSkuLabelsToInventory([saveRaceLabel])]);
    assert.equal(reserved.product.id, saved.products[0].id);
    assert.equal((reserved.created ? 1 : 0) + saved.createdCount, 1);
    const final = (await sql`SELECT quantity FROM products WHERE id = ${reserved.product.id}`)[0];
    assert.equal(final.quantity, saved.createdCount ? 2 : 0);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM inventory_movements WHERE product_id = ${reserved.product.id}`)[0].count, saved.createdCount);
  } finally {
    await sql`DELETE FROM products WHERE sku = ANY(${ownedSkus}) AND name LIKE ${`${marker}%`}`;
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
