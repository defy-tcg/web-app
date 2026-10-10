import assert from "node:assert/strict";
import test from "node:test";
import { buildPokemonBuylistSnapshot, currentPokemonBuylist, POKEMON_BUYLIST_CARDS, pokemonBuylistCash } from "../lib/pokemon-buylist.ts";
import { selectScrydexPrice, type ScrydexProduct } from "../lib/scrydex.ts";

const now = Date.parse("2026-09-26T23:00:00Z");
const price = (cents: number) => ({ cents, matchedName: "Verified card", groupName: "151", variation: "holofoil / NM", scrydexId: "sv3pt5-173", url: "https://api.scrydex.com/pokemon/v1/cards/sv3pt5-173" });

test("Pokémon cash offers pay 80% of raw market cents with no retail markup or store-credit quote", () => {
  assert.equal(pokemonBuylistCash(10000), 8000);
  assert.equal(pokemonBuylistCash(6691), 5353);
  assert.equal(pokemonBuylistCash(4128), 3302);
  assert.equal(pokemonBuylistCash(1), 1);
  assert.equal(pokemonBuylistCash(2), 2);
  assert.equal(pokemonBuylistCash(3), 2);
  assert.equal(pokemonBuylistCash(100_000_000), 80_000_000);
  for (const invalid of [0, -1, 1.5, NaN, Infinity, 100_000_001]) assert.throws(() => pokemonBuylistCash(invalid));
});

test("the fixed Pokémon cash-only list contains the approved English Near Mint promos and 151 printings", async () => {
  let active = 0, max = 0;
  const requests: ScrydexProduct[] = [];
  const result = await buildPokemonBuylistSnapshot(async product => {
    requests.push(product);
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return price(10000);
  }, () => now);
  assert.equal(max, 3);
  assert.deepEqual(requests.map(card => [card.name, card.cardNumber, card.tcgplayerId]), [
    ["Mew ex", "053", 518871], ["Mewtwo", "052", 518872],
    ["Charizard ex", "183/165", 517017], ["Venusaur ex", "182/165", 517037],
    ["Blastoise ex", "184/165", 517015], ["Mew ex", "193/165", 517027],
  ]);
  for (const product of requests) {
    assert.equal(product.game, "Pokémon");
    assert.equal(product.condition, "Near Mint");
    assert.equal(product.finish, "Foil");
    assert.equal(product.productType, "Single");
  }
  assert.equal(result.game, "Pokémon");
  assert.equal(result.condition, "Near Mint");
  assert.equal(result.language, "English");
  assert.equal(result.currency, "USD");
  assert.equal(Date.parse(result.validUntil) - Date.parse(result.updatedAt), 86_400_000);
  for (const card of result.cards) {
    assert.equal(card.cashCents, 8000);
    assert.equal(card.status, "available");
    assert.equal(card.imageUrl, `https://tcgplayer-cdn.tcgplayer.com/product/${card.tcgplayerId}_in_1000x1000.jpg`);
  }
  const serialized = JSON.stringify(result);
  for (const internal of ["creditCents", "marketCents", "percent", "apiKey", "scrydexId", "api.scrydex"]) assert.equal(serialized.includes(internal), false);
});

test("failed or invalid Pokémon quotes remain unavailable without substituting screenshot prices", async () => {
  for (const invalid of ["provider-error", "invalid-price"]) {
    const result = await buildPokemonBuylistSnapshot(async product => {
      if (product.tcgplayerId === 518871) {
        if (invalid === "provider-error") throw new Error("secret provider response");
        return price(0);
      }
      return price(4120);
    }, () => now);
    assert.equal(result.cards.length, 6);
    assert.equal(result.cards[0].cashCents, null);
    assert.equal(result.cards[0].status, "unavailable");
    assert.equal(result.cards[1].cashCents, 3296);
    assert.equal(result.cards[1].status, "available");
    assert.equal(JSON.stringify(result).includes("secret provider response"), false);
  }
});

test("Pokémon snapshot expiry removes cash offers without mutating a fresh cached snapshot", async () => {
  const snapshot = await buildPokemonBuylistSnapshot(async () => price(10000), () => now);
  assert.equal(currentPokemonBuylist(snapshot, now + 86_399_999), snapshot);
  for (const time of [now - 1, now + 86_400_000, now + 172_800_000]) {
    const result = currentPokemonBuylist(snapshot, time);
    assert.equal(result.cards.length, 6);
    assert(result.cards.every(card => card.cashCents === null && card.status === "unavailable"));
    assert.equal(JSON.stringify(result).includes("creditCents"), false);
  }
  assert(currentPokemonBuylist({ ...snapshot, validUntil: "invalid" }, now).cards.every(card => card.cashCents === null));
  assert.equal(snapshot.cards[0].cashCents, 8000);
});

function candidate(card: typeof POKEMON_BUYLIST_CARDS[number]) {
  const promo = card.cardNumber === "052" || card.cardNumber === "053";
  const number = String(Number(card.cardNumber.split("/")[0]));
  // Sanitized fixtures for the approved promo and 151 printing identities.
  return {
    id: `${promo ? "svp" : "sv3pt5"}-${number}`, name: card.name, number, printed_number: card.cardNumber,
    language: "English", language_code: "EN",
    expansion: {
      id: promo ? "svp" : "sv3pt5", name: promo ? "Scarlet & Violet Black Star Promos" : "151",
      series: "Scarlet & Violet", code: promo ? "SVP" : "MEW", printed_total: promo ? null : 165,
      language: "English", language_code: "EN",
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: String(card.tcgplayerId) }], prices: [
      { type: "raw", condition: "NM", currency: "USD", market: 41.28 },
      { type: "raw", condition: "LP", currency: "USD", market: 22.22 },
      { type: "graded", condition: "NM", currency: "USD", market: 99.99 },
    ] }],
  };
}

test("each Pokémon buylist printing uses only its verified English holofoil raw Near Mint quote", async () => {
  const result = await buildPokemonBuylistSnapshot(async product => {
    const card = POKEMON_BUYLIST_CARDS.find(card => card.tcgplayerId === product.tcgplayerId)!;
    const source = candidate(card);
    const quote = selectScrydexPrice(product, [source]);
    assert.equal(quote.scrydexId, source.id);
    assert.equal(quote.cents, 4128);
    for (const mutate of [
      (entry: typeof source) => { entry.variants[0].marketplaces = []; },
      (entry: typeof source) => { entry.variants[0].marketplaces[0].product_id = "999999"; },
      (entry: typeof source) => { entry.language_code = "JA"; },
      (entry: typeof source) => { entry.printed_number = "999/165"; entry.number = "999"; },
      (entry: typeof source) => { entry.expansion.id = "another-set"; },
      (entry: typeof source) => { entry.variants[0].name = "reverseHolofoil"; },
      (entry: typeof source) => { entry.variants[0].prices = entry.variants[0].prices.slice(1); },
    ]) {
      const wrong = structuredClone(source); mutate(wrong);
      assert.throws(() => selectScrydexPrice(product, [wrong]));
    }
    return quote;
  }, () => now);
  assert(result.cards.every(card => card.status === "available" && card.cashCents === 3302));
});
