import assert from "node:assert/strict";
import test from "node:test";
import { verifySavedSkuLabelGame } from "../lib/sku-label-game-correction.ts";
import type { ShopifyLinkableSkuProduct } from "../lib/sku-label-inventory-storage.ts";
import { SkuLabelInventoryError } from "../lib/sku-label-inventory.ts";
import type { TcgplayerCardLookup } from "../lib/tcgplayer-card.ts";

const product: ShopifyLinkableSkuProduct = {
  id: 77, sku: "DEFY-3448510729", barcode: null, name: "Charmander", productType: "Single", game: "Other",
  setName: "SV2a: Pokemon Card 151", cardNumber: "168/165", rarity: "", condition: "Near Mint", finish: "Foil",
  tcgplayerId: 566513, tcgplayerUrl: "https://www.tcgplayer.com/product/566513/old-copied-slug",
  quantity: 4, initialQuantity: 1, sheetQuantity: null, costCents: 123, marketPriceCents: 456, listPriceCents: 789,
  location: "SHELF A", lowStockThreshold: 2, priceSource: "scrydex", priceUpdatedAt: "2026-09-23T00:00:00Z",
  createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", imageUrl: null,
};
const catalog: TcgplayerCardLookup = { productId: 566513, categoryId: 85, name: "Charmander", game: "Pokémon (Japanese)",
  setName: "SV2a: Pokemon Card 151", cardNumber: "168/165", imageUrl: "", productUrl: "https://www.tcgplayer.com/product/566513", finishes: ["Foil"], warnings: [] };

test("verified category85 legacy correction preserves QR and all stock/pricing facts", async () => {
  const calls: string[] = [];
  const result = await verifySavedSkuLabelGame(product, {
    lookup: async url => { calls.push(url); return catalog; },
    persist: async saved => { assert.deepEqual(saved, product); return { ...saved, game: "Pokémon (Japanese)" }; },
  });
  assert.deepEqual(calls, ["https://www.tcgplayer.com/product/566513"]);
  assert.deepEqual(result, { ...product, game: "Pokémon (Japanese)" });
  assert.equal(result.initialQuantity, 1); assert.equal(result.quantity, 4);
});

test("Japanese correction needs exact ID, category, canonical game, name, set and full collector number", async () => {
  const persist = async (): Promise<ShopifyLinkableSkuProduct> => assert.fail("Unverified identity must not be written");
  for (const patch of [{ productId: 566514 }, { game: "Pokémon" }, { name: "Charmeleon" }, { setName: "Scarlet & Violet 151" }, { cardNumber: "168/166" }, { cardNumber: "168" }]) {
    await assert.rejects(verifySavedSkuLabelGame(product, { lookup: async () => ({ ...catalog, ...patch }) as TcgplayerCardLookup, persist }),
      (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409);
  }
  // A Japanese-looking category name cannot substitute for the authoritative ID.
  assert.equal(await verifySavedSkuLabelGame(product, { lookup: async () => ({ ...catalog, categoryId: 999 }), persist }), product);
  await assert.rejects(verifySavedSkuLabelGame({ ...product, cardNumber: "" }, { lookup: async () => catalog, persist }), SkuLabelInventoryError);
});

test("canonical games and manual cards do not make correction lookups or writes", async () => {
  const deps = { lookup: async (): Promise<TcgplayerCardLookup> => assert.fail("Unexpected catalog lookup"), persist: async (): Promise<ShopifyLinkableSkuProduct> => assert.fail("Unexpected game write") };
  for (const patch of [{ game: "Pokémon" }, { game: "Pokémon (Japanese)" }, { tcgplayerId: null }, { productType: "Sealed" as const }]) {
    const saved = { ...product, ...patch };
    assert.equal(await verifySavedSkuLabelGame(saved, deps), saved);
  }
});

test("catalog failures and changed-row guards never fall through into unverified Shopify linking", async () => {
  await assert.rejects(verifySavedSkuLabelGame(product, {
    lookup: async () => { throw new Error("Catalog unavailable"); },
    persist: async () => assert.fail("A failed lookup cannot write"),
  }), /Catalog unavailable/);
  await assert.rejects(verifySavedSkuLabelGame(product, {
    lookup: async () => catalog,
    persist: async () => { throw new SkuLabelInventoryError(409, "Saved row changed"); },
  }), /Saved row changed/);
});
