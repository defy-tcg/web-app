import assert from "node:assert/strict";
import test from "node:test";
import { approveSkuLabelManualPrice, validateSkuLabelManualPriceRequest } from "../lib/sku-label-manual-price.ts";
import { SkuLabelInventoryError } from "../lib/sku-label-inventory.ts";
import type { ShopifyLinkableSkuProduct } from "../lib/sku-label-inventory-storage.ts";
import type { SkuLabelShopifyStatus } from "../lib/sku-label-shopify.ts";
import { TcgplayerCardLookupError, type TcgplayerCardLookup } from "../lib/tcgplayer-card.ts";

const product: ShopifyLinkableSkuProduct = {
  id: 77, sku: "DEFY-6842788124", barcode: null, name: "Mel, Newly Awakened", productType: "Single", game: "Riftbound",
  setName: "Riftbound Organized Play Promotional Cards", cardNumber: "069b/166", rarity: "Epic", condition: "Near Mint", finish: "Foil",
  tcgplayerId: 709987, tcgplayerUrl: "https://example.invalid/untrusted-saved-url",
  quantity: 1, initialQuantity: 1, sheetQuantity: null, costCents: 123, marketPriceCents: 456, listPriceCents: 789,
  location: "SHELF A", lowStockThreshold: 2, priceSource: "scrydex", priceUpdatedAt: "2026-10-07T00:00:00Z",
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z", imageUrl: null,
};
const catalog: TcgplayerCardLookup = { productId: 709987, categoryId: 89, name: product.name, game: "Riftbound",
  setName: product.setName, cardNumber: product.cardNumber, imageUrl: "", productUrl: "https://www.tcgplayer.com/product/709987",
  finishes: ["Foil"], warnings: [] };
const reviewedCard = { name: product.name, game: product.game, setName: product.setName, cardNumber: product.cardNumber,
  condition: product.condition, finish: product.finish, tcgplayerId: product.tcgplayerId! };
const request = { sku: product.sku, priceCents: 25000, confirmed: true as const, card: reviewedCard };
const approved: SkuLabelShopifyStatus = { sku: product.sku, status: "pending", message: "Store price confirmed. Link this original QR." };
const conflict = (error: unknown) => error instanceof SkuLabelInventoryError && error.status === 409;

test("store price requests require explicit confirmation and positive integer cents within the allowed bound", () => {
  assert.deepEqual(validateSkuLabelManualPriceRequest(request), request);
  for (const priceCents of [1, 100_000_000]) assert.equal(validateSkuLabelManualPriceRequest({ ...request, priceCents }).priceCents, priceCents);
  for (const value of [null, [], {}, { ...request, confirmed: false }, { ...request, confirmed: "true" }, { ...request, sku: "other" },
    { ...request, card: undefined }, { ...request, card: null }, { ...request, card: [] },
    ...[null, 0, -1, 1.5, 2_147_483_648].map(tcgplayerId => ({ ...request, card: { ...reviewedCard, tcgplayerId } })),
    ...["name", "game", "setName", "cardNumber", "condition", "finish"].map(field => ({ ...request, card: { ...reviewedCard, [field]: "" } })),
    ...[0, -1, 1.5, 100_000_001, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "25000", undefined].map(priceCents => ({ ...request, priceCents }))]) {
    assert.throws(() => validateSkuLabelManualPriceRequest(value), error => error instanceof SkuLabelInventoryError && error.status === 400);
  }
  assert.deepEqual(validateSkuLabelManualPriceRequest({ ...request, url: "https://example.invalid", quantity: 100, tcgplayerId: 706064 }), request,
    "Clients cannot choose a printing, stock delta, or lookup URL");
});

test("explicit approval verifies the authoritative promo and forwards the unchanged saved QR and receipt", async () => {
  const calls: string[] = [], snapshot = structuredClone(product);
  const result = await approveSkuLabelManualPrice(request, {
    load: async sku => { assert.equal(sku, product.sku); calls.push("load"); return product; },
    lookup: async url => { calls.push(url); return catalog; },
    approve: async (saved, cents, shopify) => {
      calls.push("approve"); assert.equal(saved, product); assert.equal(cents, 25000); assert.equal(shopify, undefined);
      return approved;
    },
  });
  assert.deepEqual(calls, ["load", "https://www.tcgplayer.com/product/709987", "load", "approve"]);
  assert.equal(result.product, product); assert.equal(result.link, approved); assert.deepEqual(product, snapshot);
  assert.equal(result.product.listPriceCents, 789, "Approval does not rewrite recorded Defy prices");
});

test("a missing saved QR or invalid authoritative catalog ID never makes a lookup or approval", async () => {
  for (const saved of [undefined, { ...product, sku: "DEFY-0000000001" }, { ...product, productType: "Sealed" as const },
    ...[null, 0, -1, 1.5, 2_147_483_648].map(tcgplayerId => ({ ...product, tcgplayerId }))]) {
    await assert.rejects(approveSkuLabelManualPrice(request, {
      load: async () => saved,
      lookup: async () => assert.fail("Invalid saved identities must not reach a catalog lookup"),
      approve: async () => assert.fail("Invalid saved identities must not approve a price"),
    }), conflict);
  }
});

test("a matching ID alone cannot approve a changed name, game, set, full collector number, or finish", async () => {
  for (const patch of [{ productId: 706064 }, { name: "Mel, Defiant Soul" }, { game: "Other" }, { setName: "Vendetta" },
    { cardNumber: "069/166" }, { cardNumber: "069a/166" }, { cardNumber: "069b/167" }, { cardNumber: "069b" },
    { cardNumber: "" }, { finishes: [] }, { finishes: ["Normal"] }, { finishes: ["Textured Foil"] }]) {
    await assert.rejects(approveSkuLabelManualPrice(request, {
      load: async () => product, lookup: async () => ({ ...catalog, ...patch }) as TcgplayerCardLookup,
      approve: async () => assert.fail("A different printing or unverified finish must not approve a price"),
    }), conflict);
  }
  for (const field of ["name", "game", "setName", "cardNumber", "finish"] as const) {
    await assert.rejects(approveSkuLabelManualPrice(request, {
      load: async () => ({ ...product, [field]: "" }), lookup: async () => catalog,
      approve: async () => assert.fail("Incomplete saved identity must not approve a price"),
    }), conflict);
  }
});

test("normalized catalog text and plain finish aliases preserve the verified printing", async () => {
  const result = await approveSkuLabelManualPrice({ ...request, card: { ...reviewedCard, finish: "Holofoil" } }, {
    load: async () => product,
    lookup: async () => ({ ...catalog, name: "  MEL,   Newly Awakened ", game: "Riftbound", setName: ` ${catalog.setName.toUpperCase()} `,
      cardNumber: " 069B/166 ", finishes: ["Holofoil"] }),
    approve: async () => approved,
  });
  assert.equal(result.link, approved);
});

test("a stale physical-card confirmation cannot approve another printing or condition using the same QR", async () => {
  for (const patch of [{ tcgplayerId: 706064 }, { cardNumber: "069a/166" }, { condition: "Lightly Played" }, { name: "Mel, Defiant Soul" },
    { game: "Other" }, { setName: "Vendetta" }, { finish: "Textured Foil" }]) {
    await assert.rejects(approveSkuLabelManualPrice({ ...request, card: { ...reviewedCard, ...patch } }, {
      load: async () => product,
      lookup: async () => assert.fail("Stale confirmation must fail before lookup"),
      approve: async () => assert.fail("Stale confirmation must not approve a price"),
    }), conflict);
  }
});

test("a card correction during the lookup invalidates confirmation before the journal approval", async () => {
  for (const patch of [{ tcgplayerId: 706064, cardNumber: "069/166", setName: "Vendetta" }, { cardNumber: "069a/166" },
    { condition: "Lightly Played" }, { id: product.id + 1 }, { initialQuantity: product.initialQuantity + 1 }]) {
    let loads = 0;
    await assert.rejects(approveSkuLabelManualPrice(request, {
      load: async () => ++loads === 1 ? product : { ...product, ...patch },
      lookup: async () => catalog,
      approve: async () => assert.fail("A concurrent correction must not approve the reviewed price"),
    }), conflict);
    assert.equal(loads, 2);
  }
});

test("catalog or journal failures do not report an approved price", async () => {
  const lookupError = new TcgplayerCardLookupError(502, "The card catalog is unavailable.");
  await assert.rejects(approveSkuLabelManualPrice(request, {
    load: async () => product, lookup: async () => { throw lookupError; },
    approve: async () => assert.fail("A failed catalog lookup cannot approve a price"),
  }), error => error === lookupError);
  const approvalError = new SkuLabelInventoryError(409, "Shopify linking already started. Keep the original QR.");
  await assert.rejects(approveSkuLabelManualPrice(request, {
    load: async () => product, lookup: async () => catalog, approve: async () => { throw approvalError; },
  }), error => error === approvalError);
});
