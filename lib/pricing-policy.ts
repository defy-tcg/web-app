import { gameFromAlias } from "./tcg-games.ts";

export const SCRYDEX_PRICE_SOURCE = "scrydex";
export const RIFTBOUND_SINGLE_MARKUP_PERCENT = 6;

export type PricingProduct = Pick<PricingIdentity, "game" | "productType">;

/** Only Riftbound singles receive the customer selling-price increase. */
export function isRiftboundSinglePricingProduct(product: PricingProduct): boolean {
  return gameFromAlias(product.game)?.key === "riftbound"
    && product.productType.trim().toLowerCase() === "single";
}

/** Eligible singles add 6%, rounded half-up; every other product stays at market. */
export function scrydexSellPriceCents(marketCents: number, product: PricingProduct): number {
  if (!Number.isSafeInteger(marketCents) || marketCents <= 0 || marketCents > 100_000_000) {
    throw new Error("Scrydex must provide a positive USD market price within the supported range.");
  }
  return isRiftboundSinglePricingProduct(product)
    ? Math.floor((marketCents * (100 + RIFTBOUND_SINGLE_MARKUP_PERCENT) + 50) / 100)
    : marketCents;
}

export type StoredPricing = {
  marketPriceCents: number;
  listPriceCents: number;
  priceSource: string;
  priceUpdatedAt: string | null;
};

export type PricingIdentity = {
  name: string;
  game: string;
  productType: string;
  setName: string;
  cardNumber: string;
  condition: string;
  finish: string;
  tcgplayerId: number | null;
};

/** Every field consulted when selecting an exact Scrydex printing and quote. */
export function samePricingIdentity(left: PricingIdentity, right: PricingIdentity) {
  return left.name === right.name && left.game === right.game
    && left.productType === right.productType && left.setName === right.setName
    && left.cardNumber === right.cardNumber && left.condition === right.condition
    && left.finish === right.finish && left.tcgplayerId === right.tcgplayerId;
}

/** Sheet/CSV edits cannot overwrite a verified Scrydex quote with another feed. */
export function preserveScrydexPricing<T extends StoredPricing>(current: StoredPricing & PricingProduct, incoming: T): T {
  if (current.priceSource !== SCRYDEX_PRICE_SOURCE) return incoming;
  return {
    ...incoming,
    marketPriceCents: current.marketPriceCents,
    listPriceCents: scrydexSellPriceCents(current.marketPriceCents, current),
    priceSource: current.priceSource,
    priceUpdatedAt: current.priceUpdatedAt,
  };
}
