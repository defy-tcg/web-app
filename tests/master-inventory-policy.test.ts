import assert from "node:assert/strict";
import test from "node:test";
import { isMasterSheetManagedProduct, matchMasterSheetProducts } from "../lib/master-inventory-policy.ts";

const sheet = { name: "Shared Product", game: "Pokémon" as const, gameReliable: true };
const custom = {
  id: 1, sku: "DEFY-1234567890", name: "Shared Product", game: "Pokémon",
  productType: "Single", sheetQuantity: null, priceSource: "manual",
};
const sealed = {
  ...custom, id: 2, sku: "DEFY-PKM-S00123456", productType: "Sealed",
  sheetQuantity: 5, priceSource: "master-sheet",
};

test("a matching custom-label single cannot be adopted as a sheet product", () => {
  assert.deepEqual(matchMasterSheetProducts([custom], sheet), []);
  assert.deepEqual(matchMasterSheetProducts([custom, sealed], sheet), [sealed]);
});

test("custom-label singles never enter the sheet duplicate-zeroing list", () => {
  const secondCustom = { ...custom, id: 3, sku: "1234567891" };
  const genuineDuplicate = { ...sealed, id: 4, sku: "DEFY-SHEET-OLD" };
  assert.deepEqual(
    matchMasterSheetProducts([sealed, custom, secondCustom, genuineDuplicate], sheet),
    [sealed, genuineDuplicate],
  );
});

test("custom labels stay protected after pricing changes or earlier sheet association", () => {
  for (const priceSource of ["manual", "scrydex", "master-sheet", "google-sheet"]) {
    for (const sheetQuantity of [null, 0, 5]) {
      const product = { ...custom, priceSource, sheetQuantity };
      assert.deepEqual(matchMasterSheetProducts([product], sheet), []);
      assert.equal(isMasterSheetManagedProduct(product), false);
    }
  }
});

test("sealed sync and legacy single eligibility keep their existing behavior", () => {
  const sealedWithShortSku = { ...custom, productType: "Sealed" };
  const legacySingle = { ...custom, sku: "DEFY-PKM-000001" };
  assert.deepEqual(matchMasterSheetProducts([sealedWithShortSku, legacySingle], sheet), [sealedWithShortSku, legacySingle]);
  assert.equal(isMasterSheetManagedProduct(sealed), true);
  assert.equal(isMasterSheetManagedProduct(sealedWithShortSku), false);
  assert.equal(isMasterSheetManagedProduct({ ...sealedWithShortSku, sheetQuantity: 0 }), true);
  assert.equal(isMasterSheetManagedProduct({ ...legacySingle, priceSource: "google-sheet" }), true);
  assert.equal(isMasterSheetManagedProduct({ ...legacySingle, sku: "DEFY-SHEET-OLD" }), true);
  assert.equal(isMasterSheetManagedProduct(legacySingle), false);
});
