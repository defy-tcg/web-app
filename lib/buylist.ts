import { resolveScrydexPrice, type ScrydexProduct, type ScrydexPrice } from "./scrydex.ts";

// Owner-approved standard English Near Mint buylist. Rates stay server-side;
// the public response contains only the resulting dollar offers.
export const BUYLIST_CARDS = [
  { name: "Astral Heron", setName: "Vendetta", cardNumber: "044/166", finish: "Foil", tcgplayerId: 707611 },
  { name: "Thousand-Tailed Watcher", setName: "Origins", cardNumber: "116/298", finish: "Foil", tcgplayerId: 652898 },
  { name: "Falling Star", setName: "Origins", cardNumber: "029/298", finish: "Foil", tcgplayerId: 652801 },
  { name: "Sabotage", setName: "Origins", cardNumber: "156/298", finish: "Foil", tcgplayerId: 652941 },
  { name: "Kai'Sa, Survivor", setName: "Origins", cardNumber: "039/298", finish: "Foil", tcgplayerId: 652812 },
  { name: "Defy", setName: "Origins", cardNumber: "045/298", finish: "Normal", tcgplayerId: 652821 },
  { name: "Zhonya's Hourglass", setName: "Origins", cardNumber: "077/298", finish: "Foil", tcgplayerId: 652855 },
  { name: "Tideturner", setName: "Origins", cardNumber: "199/298", finish: "Foil", tcgplayerId: 652990 },
  { name: "Scuttle Crab", setName: "Unleashed", cardNumber: "053/219", finish: "Foil", tcgplayerId: 685519 },
] as const;
export const BUYLIST_TTL_SECONDS = 86_400;
export type BuylistOffer = (typeof BUYLIST_CARDS)[number] & {
  imageUrl: string; cashCents: number | null; creditCents: number | null;
  status: "available" | "unavailable";
};
export type BuylistSnapshot = { currency: "USD"; condition: "Near Mint"; language: "English"; updatedAt: string; validUntil: string; cards: BuylistOffer[] };

export function buylistOffers(marketCents: number) {
  if (!Number.isSafeInteger(marketCents) || marketCents <= 0 || marketCents > 100_000_000) throw new Error("Invalid buylist market price.");
  return { cashCents: Math.floor((marketCents * 70 + 50) / 100), creditCents: Math.floor((marketCents * 80 + 50) / 100) };
}

export async function buildBuylistSnapshot(
  quote: (product: ScrydexProduct) => Promise<ScrydexPrice> = resolveScrydexPrice,
  now: () => number = Date.now,
): Promise<BuylistSnapshot> {
  const checkedAt = now();
  const cards: BuylistOffer[] = [];
  // Bound provider concurrency and use one fixed catalog. Public visitors cannot
  // choose arbitrary cards, conditions, URLs, percentages, or force refreshes.
  for (let i = 0; i < BUYLIST_CARDS.length; i += 3) {
    cards.push(...await Promise.all(BUYLIST_CARDS.slice(i, i + 3).map(async card => {
      const base = { ...card, imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayerId}_in_1000x1000.jpg` };
      try {
        const price = await quote({ ...card, game: "Riftbound", productType: "Single", condition: "Near Mint" });
        return { ...base, ...buylistOffers(price.cents), status: "available" as const };
      } catch {
        return { ...base, cashCents: null, creditCents: null, status: "unavailable" as const };
      }
    })));
  }
  return { currency: "USD", condition: "Near Mint", language: "English", updatedAt: new Date(checkedAt).toISOString(), validUntil: new Date(checkedAt + BUYLIST_TTL_SECONDS * 1000).toISOString(), cards };
}

// Next's cache can return its old snapshot while refreshing in the background.
// Hide expired offers rather than present yesterday's amount as today's quote.
export function currentBuylist(snapshot: BuylistSnapshot, now = Date.now()): BuylistSnapshot {
  if (Date.parse(snapshot.validUntil) > now && Date.parse(snapshot.updatedAt) <= now) return snapshot;
  return { ...snapshot, cards: snapshot.cards.map(card => ({ ...card, cashCents: null, creditCents: null, status: "unavailable" })) };
}
