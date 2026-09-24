import assert from "node:assert/strict";
import test from "node:test";
import { resolveScrydexPrice, selectScrydexPrice, ScrydexError, type ScrydexProduct } from "../lib/scrydex.ts";

const card: ScrydexProduct = {
  name: "Eevee - 173 (Pokemon Center Exclusive)", game: "Pokémon", setName: "SV: Scarlet & Violet Promo Cards",
  cardNumber: "173", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 610757,
};
function candidate() {
  // Scrydex svp-173 metadata verified on 2026-09-24: these are different collectible editions.
  return {
    id: "svp-173", name: "Eevee", number: "173", printed_number: "173", rarity: "Promo", rarity_code: "PROMO",
    language: "English", language_code: "EN",
    expansion: { id: "svp", name: "Scarlet & Violet Black Star Promos", series: "Scarlet & Violet", code: "SVP", printed_total: 224, language: "English", language_code: "EN" },
    variants: [
      { name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "610758" }], prices: [{ type: "raw", condition: "NM", currency: "USD", market: 9.6 }] },
      { name: "pokemonCenterStamp", marketplaces: [{ name: "tcgplayer", product_id: "610757" }], prices: [
        { type: "raw", condition: "NM", currency: "USD", market: 84.01 },
        { type: "raw", condition: "LP", currency: "USD", market: 85 },
      ] },
    ],
  };
}
const blocked = (error: unknown) => error instanceof ScrydexError;

test("Pokémon Center Eevee uses the stamped edition's exact USD condition quote", () => {
  const result = selectScrydexPrice(card, [candidate()]);
  assert.equal(result.cents, 8401);
  assert.equal(result.scrydexId, "svp-173");
  assert.equal(result.variation, "pokemonCenterStamp / NM");
  assert.equal(selectScrydexPrice({ ...card, condition: "Lightly Played" }, [candidate()]).cents, 8500);
  assert.equal(selectScrydexPrice({ ...card, name: "Eevee (Pokémon Center Exclusive) - 173" }, [candidate()]).cents, 8401);
  assert.equal(selectScrydexPrice({ ...card, name: "Eevee - 173", tcgplayerId: 610758 }, [candidate()]).cents, 960);
});

test("a Pokémon Center annotation never falls back to regular holofoil or a different printing", () => {
  for (const change of [
    { tcgplayerId: 610758 }, { tcgplayerId: null }, { cardNumber: "174" }, { setName: "SV: Scarlet & Violet 151" },
    { finish: "Normal" }, { finish: "Reverse Holofoil" }, { name: "Eevee - 173 (Pokemon Center Exclusive) (First Edition)" },
    { name: "Eevee - 173" },
  ]) assert.throws(() => selectScrydexPrice({ ...card, ...change }, [candidate()]), blocked);
  const unstamped = candidate(); unstamped.variants = [unstamped.variants[0]];
  assert.throws(() => selectScrydexPrice(card, [unstamped]), blocked);
  const wrongId = candidate(); wrongId.variants[1].marketplaces[0].product_id = "999";
  assert.throws(() => selectScrydexPrice(card, [wrongId]), blocked);
  const foreign = candidate(); foreign.language_code = "JA";
  assert.throws(() => selectScrydexPrice(card, [foreign]), blocked);
  const noStampedPrice = candidate(); noStampedPrice.variants[1].prices = [];
  assert.throws(() => selectScrydexPrice(card, [noStampedPrice]), blocked);
  const duplicate = candidate(); duplicate.variants.push(structuredClone(duplicate.variants[1]));
  assert.throws(() => selectScrydexPrice(card, [duplicate]), blocked);
});

test("Pokémon Center lookup retrieves its base name while retaining number and language bounds", async t => {
  const oldKey = process.env.SCRYDEX_API_KEY, oldTeam = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-key"; process.env.SCRYDEX_TEAM_ID = "test-team";
  t.after(() => {
    if (oldKey === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = oldKey;
    if (oldTeam === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = oldTeam;
  });
  let calls = 0;
  const result = await resolveScrydexPrice(card, { fetch: async input => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
    const q = url.searchParams.get("q")!;
    assert.ok(q.includes('!name:"Eevee"'));
    assert.ok(q.includes('number:"173"'));
    assert.ok(q.includes('language_code:EN'));
    assert.ok(q.includes('variants.marketplaces.product_id:"610757"'));
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1); assert.equal(result.cents, 8401);
});
