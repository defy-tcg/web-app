import { BUYLIST_TTL_SECONDS } from "./buylist.ts";
import { resolveScrydexPrice, type ScrydexProduct, type ScrydexPrice } from "./scrydex.ts";

// The four owner-approved English holofoil printings. Keep the exact TCGplayer
// set labels so Scrydex's set aliases also require the matching marketplace ID.
export const POKEMON_BUYLIST_CARDS = [
  { name: "Mew ex", setName: "SV: Scarlet & Violet Promo Cards", cardNumber: "053", finish: "Foil", tcgplayerId: 518871 },
  { name: "Mewtwo", setName: "SV: Scarlet & Violet Promo Cards", cardNumber: "052", finish: "Foil", tcgplayerId: 518872 },
  { name: "Psyduck", setName: "SV: Scarlet & Violet 151", cardNumber: "175/165", finish: "Foil", tcgplayerId: 517035 },
  { name: "Pikachu", setName: "SV: Scarlet & Violet 151", cardNumber: "173/165", finish: "Foil", tcgplayerId: 513721 },
] as const;

export type PokemonBuylistOffer = (typeof POKEMON_BUYLIST_CARDS)[number] & {
  imageUrl: string;
  cashCents: number | null;
  status: "available" | "unavailable";
};
export type PokemonBuylistSnapshot = {
  game: "Pokémon";
  currency: "USD";
  condition: "Near Mint";
  language: "English";
  updatedAt: string;
  validUntil: string;
  cards: PokemonBuylistOffer[];
};

export function pokemonBuylistCash(marketCents: number) {
  if (!Number.isSafeInteger(marketCents) || marketCents <= 0 || marketCents > 100_000_000) throw new Error("Invalid buylist market price.");
  // Cash only, at 80% of the verified raw market quote, rounded half up.
  // The Pokémon retail markup must never enter this calculation.
  return Math.floor((marketCents * 80 + 50) / 100);
}

export async function buildPokemonBuylistSnapshot(
  quote: (product: ScrydexProduct) => Promise<ScrydexPrice> = resolveScrydexPrice,
  now: () => number = Date.now,
): Promise<PokemonBuylistSnapshot> {
  const checkedAt = now();
  const cards: PokemonBuylistOffer[] = [];
  for (let i = 0; i < POKEMON_BUYLIST_CARDS.length; i += 3) {
    cards.push(...await Promise.all(POKEMON_BUYLIST_CARDS.slice(i, i + 3).map(async card => {
      const base = { ...card, imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayerId}_in_1000x1000.jpg` };
      try {
        const price = await quote({ ...card, game: "Pokémon", productType: "Single", condition: "Near Mint" });
        return { ...base, cashCents: pokemonBuylistCash(price.cents), status: "available" as const };
      } catch {
        return { ...base, cashCents: null, status: "unavailable" as const };
      }
    })));
  }
  return {
    game: "Pokémon", currency: "USD", condition: "Near Mint", language: "English",
    updatedAt: new Date(checkedAt).toISOString(),
    validUntil: new Date(checkedAt + BUYLIST_TTL_SECONDS * 1000).toISOString(), cards,
  };
}

export function currentPokemonBuylist(snapshot: PokemonBuylistSnapshot, now = Date.now()): PokemonBuylistSnapshot {
  if (Date.parse(snapshot.validUntil) > now && Date.parse(snapshot.updatedAt) <= now) return snapshot;
  return { ...snapshot, cards: snapshot.cards.map(card => ({ ...card, cashCents: null, status: "unavailable" })) };
}
