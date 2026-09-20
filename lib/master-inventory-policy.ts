import { matchSheetProducts, type ExistingProductIdentity, type SheetIdentity } from "./inventory-identity.ts";
import { isGeneratedSku } from "./sku-labels.ts";

type SheetSyncProduct = {
  sku: string;
  productType: string;
  sheetQuantity: number | null;
  priceSource: string;
};

function isCustomLabelSingle(product: Pick<SheetSyncProduct, "sku" | "productType">) {
  return product.productType === "Single" && isGeneratedSku(product.sku);
}

/** Label inventory stays independent even when a sheet row has the same name. */
export function matchMasterSheetProducts<T extends ExistingProductIdentity & { productType: string }>(
  existing: T[],
  sheet: SheetIdentity,
) {
  return matchSheetProducts(existing.filter((product) => !isCustomLabelSingle(product)), sheet);
}

export function isMasterSheetManagedProduct(product: SheetSyncProduct) {
  return !isCustomLabelSingle(product) && (
    product.sheetQuantity !== null ||
    product.priceSource === "master-sheet" ||
    product.priceSource === "google-sheet" ||
    product.sku.startsWith("DEFY-SHEET-")
  );
}
