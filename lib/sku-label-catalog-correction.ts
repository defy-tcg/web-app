import { loadSkuLabelProducts, persistSkuLabelCatalogCorrection, type ShopifyLinkableSkuProduct } from "./sku-label-inventory-storage.ts";
import { canonicalInventoryLabelFinish, inventoryLabelIdentityText, SkuLabelInventoryError } from "./sku-label-inventory.ts";
import { isGeneratedSku } from "./sku-labels.ts";
import { lookupTcgplayerCard, type TcgplayerCardLookup } from "./tcgplayer-card.ts";
import { resolveScrydexPrice, ScrydexError, type ScrydexPrice, type ScrydexProduct } from "./scrydex.ts";
import { scrydexSellPriceCents } from "./pricing-policy.ts";
import { correctSkuLabelCatalog, readSkuLabelCatalogCorrection, skuLabelCatalogDetails, skuLabelCatalogVersion, type SkuLabelShopifyDependencies } from "./sku-label-shopify.ts";
import type { SkuLabelCatalogReview } from "./sku-label-catalog-types.ts";

interface CorrectionRequest { action: "preview" | "apply"; sku: string; url: string; finish: string; sourceVersion?: string; targetVersion?: string; confirmed?: boolean }
interface CorrectionDependencies {
  load: (sku: string) => Promise<ShopifyLinkableSkuProduct | undefined>;
  lookup: (url: string) => Promise<TcgplayerCardLookup>;
  price: (product: ScrydexProduct) => Promise<ScrydexPrice>;
  persist: typeof persistSkuLabelCatalogCorrection;
  shopify?: SkuLabelShopifyDependencies;
}
const defaults: CorrectionDependencies = {
  load: async sku => (await loadSkuLabelProducts({ skus: [sku] }))[0], lookup: lookupTcgplayerCard,
  price: resolveScrydexPrice, persist: persistSkuLabelCatalogCorrection,
};
export function validateSkuLabelCatalogRequest(value: unknown): CorrectionRequest {
  const input = value as Partial<CorrectionRequest> | null;
  if (!input || typeof input !== "object" || !["preview", "apply"].includes(input.action ?? "") ||
    !isGeneratedSku(input.sku) || typeof input.url !== "string" || input.url.length > 2048 ||
    typeof input.finish !== "string" || !input.finish.trim() || input.finish.length > 80) {
    throw new SkuLabelInventoryError(400, "Choose a saved QR, an exact TCGplayer card link, and the physical card's finish.");
  }
  if (input.action === "apply" && (input.confirmed !== true || typeof input.sourceVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceVersion) || typeof input.targetVersion !== "string" || !/^[a-f0-9]{64}$/.test(input.targetVersion))) {
    throw new SkuLabelInventoryError(400, "Review and explicitly confirm the corrected card details before saving.");
  }
  return { action: input.action!, sku: input.sku!, url: input.url, finish: canonicalInventoryLabelFinish(input.finish),
    ...(input.action === "apply" ? { sourceVersion: input.sourceVersion, targetVersion: input.targetVersion, confirmed: true } : {}) };
}

/** Exact catalog identity is rebuilt server-side on both preview and explicit confirmation. */
export async function reviewOrCorrectSkuLabelCatalog(input: CorrectionRequest, deps: CorrectionDependencies = defaults): Promise<{
  review?: SkuLabelCatalogReview; product?: ShopifyLinkableSkuProduct;
}> {
  const product = await deps.load(input.sku);
  if (!product) throw new SkuLabelInventoryError(409, "The saved QR was not found. Reload the saved label before correcting its catalog details.");
  const card = await deps.lookup(input.url);
  const finish = canonicalInventoryLabelFinish(input.finish);
  if (!card.finishes.some(value => inventoryLabelIdentityText(canonicalInventoryLabelFinish(value)) === inventoryLabelIdentityText(finish))) {
    throw new SkuLabelInventoryError(400, "That finish is not verified for this TCGplayer card. Choose the exact printing that matches the physical card.");
  }
  const target = { ...product, name: card.name, game: card.game, setName: card.setName, cardNumber: card.cardNumber,
    finish, tcgplayerId: card.productId, tcgplayerUrl: `https://www.tcgplayer.com/product/${card.productId}`, imageUrl: card.imageUrl };
  let quote: ScrydexPrice;
  try { quote = await deps.price(target); }
  catch (error) {
    if (error instanceof ScrydexError) throw new SkuLabelInventoryError(409,
      "The corrected card does not yet have an exact verified Scrydex price. Check its catalog link and finish before saving.");
    throw error;
  }
  const cents = scrydexSellPriceCents(quote.cents, target);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new SkuLabelInventoryError(409, "A verified positive price is required before this catalog correction can be saved.");
  if (input.action === "apply") {
    if (skuLabelCatalogVersion(target) !== input.targetVersion) throw new SkuLabelInventoryError(409, "The target card or saved stock changed after review. Review the exact correction again before saving.");
    return { product: await correctSkuLabelCatalog(product, target, input.sourceVersion!, deps.persist, deps.shopify) };
  }
  const state = await readSkuLabelCatalogCorrection(product, deps.shopify);
  if (state.target && JSON.stringify(state.target) !== JSON.stringify(skuLabelCatalogDetails(target))) {
    throw new SkuLabelInventoryError(409, "An earlier correction is unfinished. Enter the same reviewed TCGplayer card and finish to complete it.");
  }
  return { review: { sku: product.sku, sourceVersion: state.sourceVersion, targetVersion: skuLabelCatalogVersion(target), source: state.source,
    target: skuLabelCatalogDetails(target), condition: product.condition, quantity: product.quantity, priceCents: cents } };
}
