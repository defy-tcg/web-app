import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { neon } from "@neondatabase/serverless";
import { correctLegacyJapaneseSkuGame, loadSkuLabelProducts, saveSkuLabelsToInventory } from "../lib/sku-label-inventory-storage.ts";
import { generateSkuBatch } from "../lib/sku-labels.ts";
import { SkuLabelInventoryError } from "../lib/sku-label-inventory.ts";

const enabled = process.env.SKU_LABEL_GAME_CORRECTION_INTEGRATION === "1" && Boolean(process.env.SKU_LABEL_RESERVE_TEST_DATABASE_URL);
test("legacy Japanese database correction changes only game and rejects concurrent identity changes", { skip: !enabled }, async () => {
  const databaseUrl = process.env.SKU_LABEL_RESERVE_TEST_DATABASE_URL!;
  assert.equal(new URL(databaseUrl).hostname, "ep-square-truth-af9c9mha-pooler.c-2.us-west-2.aws.neon.tech");
  const previous = process.env.DATABASE_URL; process.env.DATABASE_URL = databaseUrl;
  const sql = neon(databaseUrl), marker = `Japanese correction test ${randomUUID()}`, sku = generateSkuBatch(1, [], "TEST")[0];
  const tcgplayerId = 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
  try {
    await saveSkuLabelsToInventory([{ sku, name: marker, game: "Other", setName: "Test JP set", cardNumber: "168/165", condition: "Near Mint", finish: "Foil", quantity: 1, costCents: 123, listPriceCents: 789, tcgplayerId }]);
    const [saved] = await loadSkuLabelProducts({ skus: [sku] });
    await sql`UPDATE products SET name = ${`${marker} changed`} WHERE id = ${saved.id}`;
    await assert.rejects(correctLegacyJapaneseSkuGame(saved), (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409);
    assert.equal((await sql`SELECT game FROM products WHERE id = ${saved.id}`)[0].game, "Other");
    await sql`UPDATE products SET name = ${marker}, quantity = 4, cost_cents = 321, list_price_cents = 987 WHERE id = ${saved.id}`;
    const before = (await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${saved.id}`)[0].product;
    const movements = await sql`SELECT to_jsonb(m) AS movement FROM inventory_movements m WHERE product_id = ${saved.id} ORDER BY id`;
    const corrected = await correctLegacyJapaneseSkuGame(saved);
    assert.equal(corrected.game, "Pokémon (Japanese)"); assert.equal(corrected.initialQuantity, 1); assert.equal(corrected.quantity, 4);
    assert.deepEqual((await sql`SELECT to_jsonb(p) AS product FROM products p WHERE id = ${saved.id}`)[0].product, { ...before, game: "Pokémon (Japanese)" });
    assert.deepEqual(await sql`SELECT to_jsonb(m) AS movement FROM inventory_movements m WHERE product_id = ${saved.id} ORDER BY id`, movements);
    await assert.rejects(correctLegacyJapaneseSkuGame(saved), SkuLabelInventoryError);
  } finally {
    await sql`DELETE FROM products WHERE sku = ${sku} AND name LIKE ${`${marker}%`}`;
    assert.equal((await sql`SELECT count(*)::integer AS count FROM products WHERE sku = ${sku}`)[0].count, 0);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
  }
});
