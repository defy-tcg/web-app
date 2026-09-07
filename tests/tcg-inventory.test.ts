import assert from "node:assert/strict";
import test from "node:test";

import { parseInventoryCsv } from "../lib/inventory-csv.ts";
import {
  matchCatalogProduct,
  matchSheetProducts,
} from "../lib/inventory-identity.ts";
import {
  catalogProductSku,
  importedProductSku,
  legacyCsvFallbackSku,
  manualProductSku,
  matchesSkuOrBarcode,
  sheetProductSku,
  validateSku,
} from "../lib/product-sku.ts";
import {
  canonicalizeGame,
  gameCode,
  gameFromAlias,
  inferGameFromName,
} from "../lib/tcg-games.ts";

test("game aliases normalize to the shared canonical registry", () => {
  assert.equal(canonicalizeGame("Pokemon"), "Pokémon");
  assert.equal(canonicalizeGame("Pokémon TCG"), "Pokémon");
  assert.equal(canonicalizeGame("Magic: The Gathering"), "MTG");
  assert.equal(canonicalizeGame("Magic"), "MTG");
  assert.equal(canonicalizeGame("One-Piece"), "One Piece");
  assert.equal(canonicalizeGame("Gundam Card Game"), "Gundam");
  assert.equal(gameFromAlias("not a real game"), null);
  assert.equal(inferGameFromName("Gundam Freedom Ascension GD-05 Booster Box"), "Gundam");
});

test("new manual, catalog, sheet, and import SKUs use per-game codes", () => {
  assert.equal(manualProductSku("Pokémon", 1), "DEFY-PKM-000001");
  assert.equal(manualProductSku("Magic", 42), "DEFY-MTG-000042");
  assert.equal(catalogProductSku("Riftbound", 635368), "DEFY-RFB-T635368");
  const identity = { game: "Gundam", name: "Freedom Ascension Box", setName: "GD-05" };
  assert.match(sheetProductSku(identity), /^DEFY-GDM-S[A-Z0-9]{8}$/);
  assert.equal(sheetProductSku(identity), sheetProductSku(identity));
  assert.match(importedProductSku({ ...identity, game: "Lorcana" }), /^DEFY-LOR-I[A-Z0-9]{8}$/);
  assert.equal(gameCode("Dragon Ball Super"), "DBS");
  assert.equal(gameCode("unknown"), "OTH");
});

test("legacy SKUs and old printed barcodes continue to scan without renaming", () => {
  const products = [
    { sku: "DEFY-000001", barcode: "012345678905" },
    { sku: "DEFY-SHEET-ABC123", barcode: null },
    { sku: "DEFY-TCG-509980", barcode: null },
    { sku: "TCG-CHARIZARD-NM-FOIL", barcode: null },
  ];
  for (const product of products)
    assert.equal(matchesSkuOrBarcode(product, product.sku.toLowerCase()), true);
  assert.equal(matchesSkuOrBarcode(products[0], "012345678905"), true);
  assert.equal(validateSku("defy-000001"), "DEFY-000001");
});

test("CSV preserves supplied SKU, normalizes Game, and has deterministic blank-SKU identity", () => {
  const csv = [
    "SKU,Product Name,Game,TCGplayer ID,Quantity,Condition,Finish",
    "CUSTOM-OP-7,One Piece Test Card,One Piece Card Game,700001,2,Near Mint,Foil",
    ",Gundam Freedom Ascension Box,Gundam TCG,,1,,",
  ].join("\n");
  const first = parseInventoryCsv(csv);
  const second = parseInventoryCsv(csv);
  assert.equal(first[0].sku, "CUSTOM-OP-7");
  assert.equal(first[0].skuWasExplicit, true);
  assert.equal(first[0].game, "One Piece");
  assert.equal(first[1].sku, undefined);
  assert.equal(first[1].game, "Gundam");
  assert.deepEqual(first[1].legacySkuCandidates, second[1].legacySkuCandidates);
  assert.equal(
    importedProductSku(first[1]),
    importedProductSku(second[1]),
  );
  assert.equal(
    first[1].legacySkuCandidates[0],
    legacyCsvFallbackSku(first[1], 2),
  );
});

test("sheet matching never crosses same-name products from different games", () => {
  const existing = [
    { id: 1, sku: "DEFY-000001", game: "Pokémon", name: "Shared Box" },
    { id: 2, sku: "DEFY-000002", game: "Magic", name: "Shared Box" },
  ];
  assert.deepEqual(
    matchSheetProducts(existing, { name: "Shared Box", game: "MTG", gameReliable: true }),
    [existing[1]],
  );
  assert.deepEqual(
    matchSheetProducts(existing, { name: "Shared Box", game: null, gameReliable: false }),
    [],
  );
  assert.deepEqual(
    matchSheetProducts([existing[0]], { name: "Shared Box", game: null, gameReliable: false }),
    [existing[0]],
  );
});

test("catalog receive reuses a legacy SKU and new catalog inserts use game prefix", () => {
  const legacy = {
    id: 7,
    sku: "DEFY-TCG-635368",
    game: "Riftbound",
    name: "Old catalog name",
    tcgplayerId: 635368,
  };
  assert.equal(
    matchCatalogProduct([legacy], {
      game: "Riftbound TCG",
      name: "Updated catalog name",
      tcgplayerId: 635368,
    })?.sku,
    legacy.sku,
  );
  assert.equal(catalogProductSku("Riftbound", 635368), "DEFY-RFB-T635368");
});