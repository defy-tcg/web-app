import { correctLegacyJapaneseSkuGame, type ShopifyLinkableSkuProduct } from "./sku-label-inventory-storage.ts";
import { inventoryLabelIdentityText, SkuLabelInventoryError } from "./sku-label-inventory.ts";
import { lookupTcgplayerCard, type TcgplayerCardLookup } from "./tcgplayer-card.ts";

interface CorrectionDependencies {
  lookup(url: string): Promise<TcgplayerCardLookup>;
  persist(product: ShopifyLinkableSkuProduct): Promise<ShopifyLinkableSkuProduct>;
}

/** Legacy imports lacked the Japanese category. Read/status paths never call this. */
export async function verifySavedSkuLabelGame(product: ShopifyLinkableSkuProduct,
  deps: CorrectionDependencies = { lookup: lookupTcgplayerCard, persist: correctLegacyJapaneseSkuGame }): Promise<ShopifyLinkableSkuProduct> {
  if (product.game !== "Other" || product.productType !== "Single" || !Number.isSafeInteger(product.tcgplayerId) || Number(product.tcgplayerId) <= 0) return product;
  // Rebuild the fixed-host URL from the saved ID; never fetch a stored/custom URL.
  const card = await deps.lookup(`https://www.tcgplayer.com/product/${product.tcgplayerId}`);
  if (card.categoryId !== 85) return product;
  if (card.productId !== product.tcgplayerId || card.game !== "Pokémon (Japanese)" ||
    ["name", "setName", "cardNumber"].some(key => {
      const field = key as "name" | "setName" | "cardNumber";
      return !product[field].trim() || inventoryLabelIdentityText(product[field]) !== inventoryLabelIdentityText(card[field]);
    })) {
    throw new SkuLabelInventoryError(409, "TCGplayer's Japanese card details do not exactly match this saved QR. Review its name, set, and card number before linking Shopify.");
  }
  return deps.persist(product);
}
