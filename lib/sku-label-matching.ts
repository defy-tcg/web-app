import { canonicalInventoryLabelFinish, inventoryLabelIdentityText, inventoryLabelVariantKey, type InventoryLabelIdentity } from "./sku-label-inventory.ts";

export type SkuLabelMatchIdentity = Omit<InventoryLabelIdentity, "sku" | "barcode" | "productType">;
export type SavedSkuLabelMatch = InventoryLabelIdentity & { id: number; createdAt?: string };

export function sameSkuLabelCard(left: SkuLabelMatchIdentity, right: SkuLabelMatchIdentity): boolean {
  if (left.tcgplayerId && right.tcgplayerId) return left.tcgplayerId === right.tcgplayerId;
  return inventoryLabelVariantKey({ ...left, condition: "", finish: "" }) ===
    inventoryLabelVariantKey({ ...right, condition: "", finish: "" });
}

export function sameSkuLabelVariant(left: SkuLabelMatchIdentity, right: SkuLabelMatchIdentity): boolean {
  return sameSkuLabelCard(left, right) &&
    inventoryLabelIdentityText(left.condition) === inventoryLabelIdentityText(right.condition) &&
    inventoryLabelIdentityText(canonicalInventoryLabelFinish(left.finish)) === inventoryLabelIdentityText(canonicalInventoryLabelFinish(right.finish));
}

/** The first stored identity stays canonical, even when a caller proposes a later SKU. */
export function compareSavedSkuLabels(left: { id: number; createdAt?: string }, right: { id: number; createdAt?: string }): number {
  const leftTime = left.createdAt ? Date.parse(left.createdAt) : NaN;
  const rightTime = right.createdAt ? Date.parse(right.createdAt) : NaN;
  return (Number.isFinite(leftTime) && Number.isFinite(rightTime) ? leftTime - rightTime : 0) || left.id - right.id;
}

export function savedSkuLabelVariants(products: readonly SavedSkuLabelMatch[], card: SkuLabelMatchIdentity): SavedSkuLabelMatch[] {
  const variants = new Map<string, SavedSkuLabelMatch>();
  for (const product of [...products].sort(compareSavedSkuLabels)) {
    if (product.productType !== "Single" || !sameSkuLabelCard(product, card)) continue;
    const key = JSON.stringify([inventoryLabelIdentityText(product.condition), inventoryLabelIdentityText(canonicalInventoryLabelFinish(product.finish))]);
    if (!variants.has(key)) variants.set(key, product);
  }
  return [...variants.values()];
}

export function isSavedSkuLabelMatch(value: unknown): value is SavedSkuLabelMatch {
  if (!value || typeof value !== "object") return false;
  const product = value as Record<string, unknown>;
  return typeof product.id === "number" && Number.isSafeInteger(product.id) && product.id > 0 &&
    ["sku", "productType", "name", "game", "setName", "cardNumber", "condition", "finish"].every((field) => typeof product[field] === "string") &&
    (product.tcgplayerId === null || (typeof product.tcgplayerId === "number" && Number.isSafeInteger(product.tcgplayerId) && product.tcgplayerId > 0));
}
