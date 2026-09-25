import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { loadSkuLabelProducts, persistSkuLabelCatalogCorrection, saveSkuLabelsToInventory } from "../lib/sku-label-inventory-storage.ts";
import { skuLabelCatalogVersion } from "../lib/sku-label-shopify.ts";
import { generateSkuBatch } from "../lib/sku-labels.ts";
import { SkuLabelInventoryError } from "../lib/sku-label-inventory.ts";

const enabled = process.env.SKU_LABEL_CATALOG_CORRECTION_INTEGRATION === "1" && Boolean(process.env.SKU_LABEL_RESERVE_TEST_DATABASE_URL);
test("catalog correction DB transaction preserves stock and receipts, rejects duplicates and stale snapshots", { skip: !enabled }, async () => {
  const databaseUrl = process.env.SKU_LABEL_RESERVE_TEST_DATABASE_URL!;
  assert.equal(new URL(databaseUrl).hostname, "ep-square-truth-af9c9mha-pooler.c-2.us-west-2.aws.neon.tech");
  const previous = process.env.DATABASE_URL; process.env.DATABASE_URL = databaseUrl;
  const sql = neon(databaseUrl), marker = `Catalog correction test ${randomUUID()}`;
  const [sku, duplicateSku] = generateSkuBatch(2, [], "TEST");
  const sourceId = 2_000_000_000 + Math.floor(Math.random() * 50_000_000), targetId = sourceId + 50_000_000;
  try {
    await saveSkuLabelsToInventory([{ sku, name: `${marker} old`, game: "Pokémon", setName: "Old set", cardNumber: "027/073", condition: "Near Mint", finish: "Normal", quantity: 1, costCents: 123, listPriceCents: 789, location: "SHELF A", tcgplayerId: sourceId }]);
    const [saved] = await loadSkuLabelProducts({ skus: [sku] });
    const target = { ...saved, name: `${marker} corrected`, setName: "Corrected set", cardNumber: "27/73", finish: "Foil", tcgplayerId: targetId, tcgplayerUrl: `https://www.tcgplayer.com/product/${targetId}` };
    const before = (await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${saved.id}`)[0].product;
    const movements = await sql`SELECT to_jsonb(m) AS movement FROM inventory_movements m WHERE product_id = ${saved.id} ORDER BY id`;
    await saveSkuLabelsToInventory([{ ...target, sku: duplicateSku, game: "Pokémon", condition: "Near Mint" }]);
    await assert.rejects(persistSkuLabelCatalogCorrection(saved, target), /already saved as/);
    assert.deepEqual((await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${saved.id}`)[0].product, before);
    await sql`DELETE FROM products WHERE sku = ${duplicateSku} AND name = ${target.name}`;
    // Detect stock changes even if another writer did not update the timestamp.
    await sql`UPDATE products SET quantity = 2 WHERE id = ${saved.id}`;
    await assert.rejects(persistSkuLabelCatalogCorrection(saved, target), SkuLabelInventoryError);
    await sql`UPDATE products SET quantity = 1 WHERE id = ${saved.id}`;
    const corrected = await persistSkuLabelCatalogCorrection(saved, target);
    assert.equal(skuLabelCatalogVersion(corrected), skuLabelCatalogVersion(target), "Timestamp serialization must preserve the reviewed version");
    assert.deepEqual((await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${saved.id}`)[0].product,
      { ...before, name: target.name, set_name: target.setName, card_number: target.cardNumber, finish: target.finish,
        tcgplayer_id: target.tcgplayerId, tcgplayer_url: target.tcgplayerUrl });
    assert.deepEqual(await sql`SELECT to_jsonb(m) AS movement FROM inventory_movements m WHERE product_id = ${saved.id} ORDER BY id`, movements);
    assert.equal(corrected.sku, sku); assert.equal(corrected.quantity, 1); assert.equal(corrected.initialQuantity, 1);
    await assert.rejects(persistSkuLabelCatalogCorrection(saved, target), SkuLabelInventoryError);
  } finally {
    await sql`DELETE FROM products WHERE sku = ANY(${[sku, duplicateSku]}) AND name LIKE ${`${marker}%`}`;
    assert.equal((await sql`SELECT count(*)::integer AS count FROM products WHERE sku = ANY(${[sku, duplicateSku]})`)[0].count, 0);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
