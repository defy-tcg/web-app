import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { loadSkuLabelProducts, reserveSkuLabel, saveSkuLabelsToInventory } from "../lib/sku-label-inventory-storage.ts";
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
  const skus = generateSkuBatch(14, [], "TEST");
  const legacySku = `LEGACY-${randomUUID()}`;
  const ownedSkus = [...skus, legacySku];
  const catalogId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  const label: InventoryLabelInput = {
    sku: skus[0], name: marker, game: "Riftbound", setName: "Reserve test", cardNumber: "TEST-001",
    condition: "Near Mint", finish: "Normal", quantity: 3, costCents: 999, listPriceCents: 1999,
    tcgplayerId: catalogId,
  };
  try {
    const initial = await reserveSkuLabel(label);
    assert.equal(initial.created, true);
    assert.equal(initial.product.sku, skus[0]);
    assert.equal(initial.product.quantity, 3);
    assert.equal(initial.product.costCents, 0);
    assert.equal(initial.product.listPriceCents, 0);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM inventory_movements WHERE product_id = ${initial.product.id}`)[0].count, 1);
    const retry = await reserveSkuLabel({ ...label, quantity: 99 });
    assert.equal(retry.created, false);
    assert.equal(retry.product.id, initial.product.id);
    assert.equal(retry.product.quantity, 3);

    await sql`UPDATE products SET quantity = 7, cost_cents = 321, list_price_cents = 654,
      price_source = 'scrydex', location = 'TEST SHELF', rarity = 'Existing rarity'
      WHERE id = ${initial.product.id}`;
    const before = (await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${initial.product.id}`)[0].product;
    const [linkable] = await loadSkuLabelProducts({ skus: [skus[0]] });
    assert.equal(linkable.quantity, 7);
    assert.equal(linkable.initialQuantity, 3, "Shopify receives the first receipt rather than a later inventory balance.");
    const reused = await reserveSkuLabel({ ...label, sku: skus[1], name: `${marker} changed catalog spelling`, finish: "Nonfoil", location: "NEW" });
    assert.equal(reused.created, false);
    assert.equal(reused.product.sku, skus[0]);
    assert.deepEqual((await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${initial.product.id}`)[0].product, before);
    const correctedGame = await reserveSkuLabel({ ...label, sku: skus[1], game: "Other", name: `${marker} corrected game` });
    assert.equal(correctedGame.product.id, initial.product.id);
    const batchRetry = await saveSkuLabelsToInventory([{ ...label, game: "Other", name: `${marker} corrected game` }]);
    assert.equal(batchRetry.existingCount, 1);
    assert.equal(batchRetry.products[0].id, initial.product.id);
    await assert.rejects(() => saveSkuLabelsToInventory([{ ...label, sku: skus[1], game: "Other", name: `${marker} corrected game` }]),
      (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409 && error.existingSku === skus[0]);
    for (const sku of [skus[0], skus[1]]) {
      await assert.rejects(() => reserveSkuLabel({ ...label, sku, tcgplayerId: catalogId + 1 }),
        (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409 && error.existingSku === skus[0]);
    }
    assert.equal((await sql`SELECT count(*)::integer AS count FROM products WHERE tcgplayer_id = ${catalogId + 1}`)[0].count, 0);
    await sql`INSERT INTO products (sku, name, product_type, game, set_name, card_number, condition, finish)
      VALUES (${skus[10]}, ${`${marker} without catalog ID`}, 'Single', 'Riftbound', 'Reserve test', 'TEST-001', 'Near Mint', 'Normal')`;
    const unlinkedBefore = (await sql`SELECT to_jsonb(p) AS product FROM products p WHERE sku = ${skus[10]}`)[0].product;
    const canonical = await reserveSkuLabel({ ...label, sku: skus[11], name: `${marker} without catalog ID`, tcgplayerId: catalogId + 1 });
    assert.equal(canonical.created, false);
    assert.equal(canonical.product.sku, skus[10]);
    assert.equal(canonical.product.tcgplayerId, catalogId + 1);
    assert.equal(canonical.product.tcgplayerUrl, `https://www.tcgplayer.com/product/${catalogId + 1}`);
    assert.deepEqual((await sql`SELECT to_jsonb(p) AS product FROM products p WHERE sku = ${skus[10]}`)[0].product, {
      ...unlinkedBefore, tcgplayer_id: catalogId + 1, tcgplayer_url: `https://www.tcgplayer.com/product/${catalogId + 1}`,
    });
    const renamedAfterLink = await reserveSkuLabel({ ...label, sku: skus[11], name: `${marker} renamed after linking`, game: "Other", tcgplayerId: catalogId + 1 });
    assert.equal(renamedAfterLink.product.id, canonical.product.id);
    assert.equal(renamedAfterLink.created, false);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM inventory_movements WHERE product_id = ${canonical.product.id}`)[0].count, 0);

    const concurrentLabel = { ...label, name: `${marker} concurrent`, tcgplayerId: catalogId + 2 };
    const concurrent = await Promise.all([
      reserveSkuLabel({ ...concurrentLabel, sku: skus[2], game: "Other" }),
      reserveSkuLabel({ ...concurrentLabel, sku: skus[3] }),
    ]);
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    assert.equal(concurrent[0].product.id, concurrent[1].product.id);
    assert.equal(concurrent[0].product.sku, concurrent[1].product.sku);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM products WHERE tcgplayer_id = ${catalogId + 2}`)[0].count, 1);
    assert.equal((await loadSkuLabelProducts({ skus: [concurrent[0].product.sku] }))[0].initialQuantity, 3);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM inventory_movements WHERE product_id = ${concurrent[0].product.id}`)[0].count, 1);

    const damaged = await reserveSkuLabel({ ...label, sku: skus[4], condition: "Damaged", quantity: 0 });
    const foil = await reserveSkuLabel({ ...label, sku: skus[5], finish: "Foil" });
    assert.equal(damaged.created, true);
    assert.equal(foil.created, true);
    assert.notEqual(damaged.product.id, foil.product.id);
    assert.equal((await loadSkuLabelProducts({ skus: [damaged.product.sku] }))[0].initialQuantity, 0);

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
    assert.equal(final.quantity, 2);
    assert.equal((await sql`SELECT count(*)::integer AS count FROM inventory_movements WHERE product_id = ${reserved.product.id}`)[0].count, 1);

    // A caller's proposed later duplicate never displaces the canonical saved SKU.
    await sql`INSERT INTO products (sku, name, product_type, game, condition, finish, tcgplayer_id, created_at)
      VALUES (${skus[13]}, ${`${marker} later duplicate`}, 'Single', 'Other', 'Near Mint', 'Normal', ${catalogId + 6}, '2021-01-01T00:00:00Z')`;
    await sql`INSERT INTO products (sku, name, product_type, game, condition, finish, tcgplayer_id, created_at)
      VALUES (${skus[12]}, ${`${marker} earlier duplicate`}, 'Single', 'Riftbound', 'Near Mint', 'Normal', ${catalogId + 6}, '2020-01-01T00:00:00Z')`;
    const duplicatesBefore = await sql`SELECT to_jsonb(p) AS product FROM products p WHERE sku = ANY(${[skus[12], skus[13]]}) ORDER BY id`;
    const canonicalDuplicate = await reserveSkuLabel({ ...label, sku: skus[13], name: `${marker} duplicate lookup`, tcgplayerId: catalogId + 6 });
    assert.equal(canonicalDuplicate.created, false);
    assert.equal(canonicalDuplicate.product.sku, skus[12]);
    assert.deepEqual(await sql`SELECT to_jsonb(p) AS product FROM products p WHERE sku = ANY(${[skus[12], skus[13]]}) ORDER BY id`, duplicatesBefore);
    // Equal creation times have a stable primary-key tie break as well.
    await sql`UPDATE products SET created_at = '2020-01-01T00:00:00Z' WHERE sku = ${skus[13]}`;
    const tiedDuplicate = await reserveSkuLabel({ ...label, sku: skus[12], name: `${marker} duplicate lookup`, tcgplayerId: catalogId + 6 });
    assert.equal(tiedDuplicate.product.sku, skus[13]);
  } finally {
    await sql`DELETE FROM products WHERE sku = ANY(${ownedSkus}) AND name LIKE ${`${marker}%`}`;
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
