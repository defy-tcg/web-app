import { gameFromAlias } from "./tcg-games.ts";

export const SCRYDEX_PRICE_SOURCE = "scrydex";
export const RIFTBOUND_SINGLE_MARKUP_PERCENT = 6.5;
export const POKEMON_SINGLE_MARKUP_PERCENT = 1.5;

export type PricingProduct = Pick<PricingIdentity, "game" | "productType">;

/** Identify singles eligible for the Riftbound selling-price rule. */
export function isRiftboundSinglePricingProduct(product: PricingProduct): boolean {
  return gameFromAlias(product.game)?.key === "riftbound"
    && product.productType.trim().toLowerCase() === "single";
}

/** Apply each game's singles markup to raw market cents, rounded half-up. */
export function scrydexSellPriceCents(marketCents: number, product: PricingProduct): number {
  if (!Number.isSafeInteger(marketCents) || marketCents <= 0 || marketCents > 100_000_000) {
    throw new Error("Scrydex must provide a positive USD market price within the supported range.");
  }
  if (product.productType.trim().toLowerCase() !== "single") return marketCents;
  const game = gameFromAlias(product.game)?.key;
  const markupPercent = game === "riftbound" ? RIFTBOUND_SINGLE_MARKUP_PERCENT
    : game === "pokemon" || game === "pokemon-japanese" ? POKEMON_SINGLE_MARKUP_PERCENT : 0;
  // Integer basis points keep fractional percentages and half-cent ties exact.
  return Math.floor((marketCents * (10_000 + markupPercent * 100) + 5_000) / 10_000);
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
