import assert from "node:assert/strict";
import test from "node:test";
import { resolveScrydexPrice, selectScrydexPrice, ScrydexError, type ScrydexProduct } from "../lib/scrydex.ts";

const charmander: ScrydexProduct = {
  name: "Charmander - 038", game: "Pokémon", setName: "ME: Mega Evolution Promo", cardNumber: "038",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 684462,
};
const mew: ScrydexProduct = {
  name: "Mew ex - 205/165 (151 Metal Card)", game: "Pokémon", setName: "SV: Scarlet & Violet 151", cardNumber: "205/165",
  productType: "Single", condition: "Near Mint", finish: "Normal", tcgplayerId: 519481,
};
function charmanderCandidate() {
  // Live Scrydex metadata verified 2026-09-24; the ME promo expansion differs from ME01.
  return {
    id: "mep-38", name: "Charmander", number: "38", printed_number: "038", rarity: "Promo", rarity_code: "PROMO",
    language: "English", language_code: "EN",
    expansion: { id: "mep", name: "Mega Evolution Black Star Promos", series: "Mega Evolution", code: "MEP", printed_total: null, language: "English", language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "684462" }], prices: [
      { type: "raw", condition: "NM", currency: "USD", market: 26.26 },
      { type: "raw", condition: "LP", currency: "USD", market: 37.6 },
    ] }],
  };
}
function mewCandidate() {
  // The metal UPC card shares a Scrydex card record with a different, regular gold printing.
  return {
    id: "sv3pt5-205", name: "Mew ex", number: "205", printed_number: "205/165", rarity: "Hyper Rare", rarity_code: "HR",
    language: "English", language_code: "EN",
    expansion: { id: "sv3pt5", name: "151", series: "Scarlet & Violet", code: "MEW", printed_total: 165, language: "English", language_code: "EN" },
    variants: [
      { name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "517051" }], prices: [{ type: "raw", condition: "NM", currency: "USD", market: 27.46 }] },
      { name: "metal", marketplaces: [{ name: "tcgplayer", product_id: "519481" }], prices: [
        { type: "raw", condition: "NM", currency: "USD", market: 22.59 },
        { type: "raw", condition: "LP", currency: "USD", market: 21.92 },
      ] },
    ],
  };
}
const blocked = (error: unknown) => error instanceof ScrydexError;

test("Charmander 038 matches the verified Mega Evolution promo expansion and condition", () => {
  const result = selectScrydexPrice(charmander, [charmanderCandidate()]);
  assert.equal(result.cents, 2626);
  assert.equal(result.scrydexId, "mep-38");
  assert.equal(result.variation, "holofoil / NM");
  assert.equal(selectScrydexPrice({ ...charmander, condition: "Lightly Played" }, [charmanderCandidate()]).cents, 3760);
  for (const change of [
    { tcgplayerId: null }, { tcgplayerId: 684463 }, { cardNumber: "039" },
    { setName: "ME01: Mega Evolution" }, { finish: "Normal" },
  ]) assert.throws(() => selectScrydexPrice({ ...charmander, ...change }, [charmanderCandidate()]), blocked);
  for (const field of ["id", "name", "series", "code"] as const) {
    const wrongSet = charmanderCandidate(); wrongSet.expansion[field] = "different";
    assert.throws(() => selectScrydexPrice(charmander, [wrongSet]), blocked);
  }
});

test("151 metal Mew uses only the metal printing's exact USD condition price", () => {
  const result = selectScrydexPrice(mew, [mewCandidate()]);
  assert.equal(result.cents, 2259);
  assert.equal(result.scrydexId, "sv3pt5-205");
  assert.equal(result.variation, "metal / NM");
  assert.equal(selectScrydexPrice({ ...mew, condition: "Lightly Played" }, [mewCandidate()]).cents, 2192);
  assert.equal(selectScrydexPrice({ ...mew, name: "Mew ex (151 Metal Card) - 205/165" }, [mewCandidate()]).cents, 2259);
  assert.equal(selectScrydexPrice({ ...mew, name: "Mew ex - 205/165", tcgplayerId: 517051, finish: "Foil" }, [mewCandidate()]).cents, 2746);
});

test("metal annotation cannot fall back to regular Mew, an unverified edition, or missing condition prices", () => {
  for (const change of [
    { tcgplayerId: null }, { tcgplayerId: 517051 }, { name: "Mew ex - 205/165" },
    { cardNumber: "205/164" }, { setName: "SV: Scarlet & Violet Promo Cards" },
    { finish: "Foil" }, { finish: "Reverse Holofoil" }, { name: "Mew ex - 205/165 (Metal Card)" },
    { name: "Mew ex - 205/165 (151 Metal Card) (First Edition)" },
  ]) assert.throws(() => selectScrydexPrice({ ...mew, ...change }, [mewCandidate()]), blocked);
  const onlyRegular = mewCandidate(); onlyRegular.variants = [onlyRegular.variants[0]];
  assert.throws(() => selectScrydexPrice(mew, [onlyRegular]), blocked);
  const wrongId = mewCandidate(); wrongId.variants[1].marketplaces[0].product_id = "517051";
  assert.throws(() => selectScrydexPrice(mew, [wrongId]), blocked);
  const wrongCard = mewCandidate(); wrongCard.id = "sv3pt5-206";
  assert.throws(() => selectScrydexPrice(mew, [wrongCard]), blocked);
  const wrongCurrency = mewCandidate(); wrongCurrency.variants[1].prices[0].currency = "EUR";
  assert.throws(() => selectScrydexPrice(mew, [wrongCurrency]), blocked);
  const noCondition = mewCandidate(); noCondition.variants[1].prices = [noCondition.variants[1].prices[1]];
  assert.throws(() => selectScrydexPrice(mew, [noCondition]), blocked);
  const foreign = mewCandidate(); foreign.language_code = "JA";
  assert.throws(() => selectScrydexPrice(mew, [foreign]), blocked);
  const duplicate = mewCandidate(); duplicate.variants.push(structuredClone(duplicate.variants[1]));
  assert.throws(() => selectScrydexPrice(mew, [duplicate]), blocked);
});

test("special promo lookups retain exact number and language bounds in one request", async t => {
  const oldKey = process.env.SCRYDEX_API_KEY, oldTeam = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-key"; process.env.SCRYDEX_TEAM_ID = "test-team";
  t.after(() => {
    if (oldKey === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = oldKey;
    if (oldTeam === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = oldTeam;
  });
  for (const [product, candidate, baseName, number] of [
    [charmander, charmanderCandidate(), "Charmander", "38"],
    [mew, mewCandidate(), "Mew ex", "205"],
  ] as const) {
    let calls = 0;
    await resolveScrydexPrice(product, { fetch: async input => {
      calls++;
      const url = new URL(String(input)), q = url.searchParams.get("q")!;
      assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
      assert.ok(q.includes(`!name:"${baseName}"`));
      assert.ok(q.includes(`number:"${number}"`));
      assert.ok(q.includes("language_code:EN"));
      assert.ok(q.includes(`variants.marketplaces.product_id:"${product.tcgplayerId}"`));
      return Response.json({ data: [candidate], total_count: 1 });
    } });
    assert.equal(calls, 1);
  }
});
