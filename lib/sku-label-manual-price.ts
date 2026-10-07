import { loadSkuLabelProducts, type ShopifyLinkableSkuProduct } from "./sku-label-inventory-storage.ts";
import { canonicalInventoryLabelFinish, inventoryLabelIdentityText, SkuLabelInventoryError } from "./sku-label-inventory.ts";
import { isGeneratedSku } from "./sku-labels.ts";
import { setSkuLabelManualPrice, type SkuLabelShopifyDependencies, type SkuLabelShopifyStatus } from "./sku-label-shopify.ts";
import { lookupTcgplayerCard, type TcgplayerCardLookup } from "./tcgplayer-card.ts";

export interface SkuLabelManualPriceCard {
  name: string; game: string; setName: string; cardNumber: string; condition: string; finish: string; tcgplayerId: number;
}
export interface SkuLabelManualPriceRequest { sku: string; priceCents: number; confirmed: true; card: SkuLabelManualPriceCard }
interface ManualPriceDependencies {
  load: (sku: string) => Promise<ShopifyLinkableSkuProduct | undefined>;
  lookup: (url: string) => Promise<TcgplayerCardLookup>;
  approve: typeof setSkuLabelManualPrice;
  shopify?: SkuLabelShopifyDependencies;
}
const defaults: ManualPriceDependencies = {
  load: async sku => (await loadSkuLabelProducts({ skus: [sku] }))[0],
  lookup: lookupTcgplayerCard,
  approve: setSkuLabelManualPrice,
};

export function validateSkuLabelManualPriceRequest(value: unknown): SkuLabelManualPriceRequest {
  const input = value as Partial<SkuLabelManualPriceRequest> | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || !isGeneratedSku(input.sku) ||
    typeof input.priceCents !== "number" || !Number.isSafeInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > 100_000_000 ||
    input.confirmed !== true) {
    throw new SkuLabelInventoryError(400, "Choose a saved QR, enter a positive store selling price, and confirm the physical card and price before linking.");
  }
  const card = input.card;
  const limits = { name: 240, game: 120, setName: 120, cardNumber: 40, condition: 80, finish: 80 } as const;
  if (!card || typeof card !== "object" || Array.isArray(card) || !Number.isSafeInteger(card.tcgplayerId) || card.tcgplayerId <= 0 || card.tcgplayerId > 2_147_483_647 ||
    (Object.keys(limits) as Array<keyof typeof limits>).some(field => typeof card[field] !== "string" || !card[field].trim() ||
      card[field].length > limits[field] || /[\u0000-\u001f\u007f]/u.test(card[field]))) {
    throw new SkuLabelInventoryError(400, "Review this saved card's complete details and confirm its physical printing before setting a store price.");
  }
  return { sku: input.sku!, priceCents: input.priceCents, confirmed: true,
    card: { name: card.name, game: card.game, setName: card.setName, cardNumber: card.cardNumber,
      condition: card.condition, finish: card.finish, tcgplayerId: card.tcgplayerId } };
}

function reviewedCardMatches(product: ShopifyLinkableSkuProduct, card: SkuLabelManualPriceCard): boolean {
  return product.tcgplayerId === card.tcgplayerId && (["name", "game", "setName", "cardNumber", "condition"] as const).every(field =>
    inventoryLabelIdentityText(product[field]) === inventoryLabelIdentityText(card[field])) &&
    inventoryLabelIdentityText(canonicalInventoryLabelFinish(product.finish)) === inventoryLabelIdentityText(canonicalInventoryLabelFinish(card.finish));
}
const staleReview = () => new SkuLabelInventoryError(409, "The saved card changed after your review. Reload its details and confirm the physical card and store price again.");

/** Verify the saved printing before explicitly approving its store price; never substitute another card. */
export async function approveSkuLabelManualPrice(input: SkuLabelManualPriceRequest, deps: ManualPriceDependencies = defaults): Promise<{
  product: ShopifyLinkableSkuProduct; link: SkuLabelShopifyStatus;
}> {
  const request = validateSkuLabelManualPriceRequest(input);
  const product = await deps.load(request.sku);
  if (!product || product.sku !== request.sku) {
    throw new SkuLabelInventoryError(409, "The saved QR was not found. Reload the saved label before setting its store price.");
  }
  if (product.productType !== "Single" || !Number.isSafeInteger(product.tcgplayerId) ||
    (product.tcgplayerId ?? 0) <= 0 || (product.tcgplayerId ?? 0) > 2_147_483_647) {
    throw new SkuLabelInventoryError(409, "A store price requires this saved QR's exact TCGplayer card. Review its catalog details before linking.");
  }
  if (!reviewedCardMatches(product, request.card)) throw staleReview();
  // Rebuild the fixed-host URL from the authoritative ID; stored/client URLs cannot select another printing.
  const card = await deps.lookup(`https://www.tcgplayer.com/product/${product.tcgplayerId}`);
  const fields = ["name", "game", "setName", "cardNumber"] as const;
  const finish = inventoryLabelIdentityText(canonicalInventoryLabelFinish(product.finish));
  if (card.productId !== product.tcgplayerId || fields.some(field =>
    !product[field].trim() || inventoryLabelIdentityText(product[field]) !== inventoryLabelIdentityText(card[field])) ||
    !finish || !card.finishes.some(value => inventoryLabelIdentityText(canonicalInventoryLabelFinish(value)) === finish)) {
    throw new SkuLabelInventoryError(409, "TCGplayer's card details do not exactly match this saved QR. Review its name, game, set, full card number, and finish before setting a store price.");
  }
  // The catalog lookup may take seconds. A correction in another tab must invalidate the physical-card confirmation.
  const current = await deps.load(request.sku);
  if (!current || current.sku !== request.sku || current.productType !== "Single" || current.id !== product.id ||
    current.initialQuantity !== product.initialQuantity || !reviewedCardMatches(current, request.card)) throw staleReview();
  const link = await deps.approve(current, request.priceCents, deps.shopify);
  return { product: current, link };
}
