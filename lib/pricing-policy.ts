export const SCRYDEX_PRICE_SOURCE = "scrydex";

/** The store rule is a 10% markup, rounded half-up to the nearest USD cent. */
export function scrydexSellPriceCents(marketCents: number): number {
  if (!Number.isSafeInteger(marketCents) || marketCents <= 0 || marketCents > 100_000_000) {
    throw new Error("Scrydex must provide a positive USD market price within the supported range.");
  }
  return Math.floor((marketCents * 110 + 50) / 100);
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
export function preserveScrydexPricing<T extends StoredPricing>(current: StoredPricing, incoming: T): T {
  if (current.priceSource !== SCRYDEX_PRICE_SOURCE) return incoming;
  return {
    ...incoming,
    marketPriceCents: current.marketPriceCents,
    listPriceCents: scrydexSellPriceCents(current.marketPriceCents),
    priceSource: current.priceSource,
    priceUpdatedAt: current.priceUpdatedAt,
  };
}
