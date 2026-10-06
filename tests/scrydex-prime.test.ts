import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Gengar (Prime)", game: "Pokémon", setName: "ME: 30th Celebration Classic Collection",
  cardNumber: "94/102", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 716198,
};
function candidate() {
  // Sanitized identity and NM quote from Scrydex's live me55c-94 response,
  // verified 2026-10-06. This reprint retains the original card's 94/102 number.
  return {
    id: "me55c-94", name: "Gengar", number: "94", printed_number: "94/102",
    rarity: "Rare Prime", rarity_code: "Rare Prime", language: "English", language_code: "EN",
    expansion: {
      id: "me55c", name: "30th Celebration: Classic Collection", series: "Mega Evolution", code: "30C",
      printed_total: null as number | null, language: "English", language_code: "EN",
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "716198" }],
      prices: [{ type: "raw", condition: "NM", market: 54.48, currency: "USD" }] }],
  };
}
function originalCandidate() {
  const entry = candidate();
  return {
    ...entry, id: "hgss4-94",
    expansion: { ...entry.expansion, id: "hgss4", name: "HS—Triumphant", series: "HeartGold & SoulSilver", code: "TM", printed_total: 102 },
    variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "85679" }] }],
  };
}
const errorCode = (code: ScrydexErrorCode) => (error: unknown) => error instanceof ScrydexError && error.code === code;
function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-key"; process.env.SCRYDEX_TEAM_ID = "test-only-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("Gengar Prime reprint resolves its verified rarity in one bounded collector/name search", async t => {
  config(t);
  for (const name of [product.name, "Gengar (Prime) - 94/102", "Gengar - 94/102 (Prime)"]) {
    let calls = 0;
    const result = await resolveScrydexPrice({ ...product, name }, { fetch: async input => {
      calls++;
      const url = new URL(String(input)), query = url.searchParams.get("q")!;
      assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
      assert.ok(query.includes('!name:"Gengar"'));
      assert.ok(query.includes('AND (number:"94") AND language_code:EN'));
      assert.ok(query.includes('variants.marketplaces.product_id:"716198"'));
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("page_size"), "100");
      return Response.json({ data: [originalCandidate(), candidate()], total_count: 2 });
    } });
    assert.equal(calls, 1);
    assert.equal(result.scrydexId, "me55c-94");
    assert.equal(result.cents, 5448);
    assert.equal(result.variation, "holofoil / NM");
  }
});

test("Prime alias keeps the reprint's exact set, number, language and marketplace identity", () => {
  const entry = candidate();
  for (const change of [
    { tcgplayerId: undefined }, { tcgplayerId: 85679 }, { cardNumber: "94/103" }, { cardNumber: "95/102" },
    { setName: "Triumphant" }, { setName: "ME: 30th Celebration" }, { setName: "SWSH: 30th Celebration Classic Collection" },
    { game: "Riftbound" }, { name: "Gengar (Prime) (First Edition)" }, { name: "Gengar (Promo)" },
  ]) assert.throws(() => selectScrydexPrice({ ...product, ...change }, [entry]), errorCode("not_found"));
  for (const change of [
    { printed_number: "94/103" }, { language_code: "JA" },
    { expansion: { ...entry.expansion, series: "Sword & Shield" } },
    { expansion: { ...entry.expansion, name: "30th Celebration" } },
    { expansion: { ...entry.expansion, language: "Japanese", language_code: "JA" } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...change }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(product, [originalCandidate()]), errorCode("not_found"));
});

test("Prime rarity proof is mandatory even for an exact annotated candidate name", () => {
  const entry = candidate();
  for (const name of [entry.name, product.name]) {
    for (const rarity of [
      { rarity: undefined, rarity_code: undefined }, { rarity: "", rarity_code: "" },
      { rarity: "Rare Prime", rarity_code: "Rare Secret" }, { rarity: "Rare Rainbow", rarity_code: "Rare Prime" },
      { rarity: "Rare Secret", rarity_code: "Rare Secret" },
    ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, name, ...rarity }]), errorCode("not_found"));
    const noId = { ...entry, name, variants: [{ ...entry.variants[0], marketplaces: [] }] };
    assert.throws(() => selectScrydexPrice(product, [noId]), errorCode("not_found"));
  }
  // The broader Secret annotation permits Rainbow, but must not permit Prime.
  assert.throws(() => selectScrydexPrice({ ...product, name: "Gengar (Secret)" }, [entry]), errorCode("not_found"));
});

test("Prime pricing requires the exact ID on the selected finish and matching USD condition quote", () => {
  const entry = candidate(), foil = entry.variants[0];
  const wrongFinishId = { ...entry, name: product.name, variants: [
    { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "85679" }] },
    { ...foil, name: "reverseHolofoil" },
  ] };
  assert.throws(() => selectScrydexPrice(product, [wrongFinishId]), errorCode("price_unavailable"));
  for (const change of [{ finish: "Normal" }, { condition: "Lightly Played" }]) {
    assert.throws(() => selectScrydexPrice({ ...product, ...change }, [entry]), errorCode("price_unavailable"));
  }
  const foreignQuote = { ...entry, variants: [{ ...foil, prices: [{ ...foil.prices[0], currency: "JPY" }] }] };
  assert.throws(() => selectScrydexPrice(product, [foreignQuote]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
});

test("Prime base-name retrieval requires an exact marketplace ID and never makes a fallback request", async t => {
  config(t);
  for (const tcgplayerId of [undefined, 716198]) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice({ ...product, tcgplayerId }, { fetch: async input => {
      calls++;
      const query = new URL(String(input)).searchParams.get("q")!;
      assert.equal(query.includes('!name:"Gengar"'), Boolean(tcgplayerId));
      return Response.json({ data: [], total_count: 0 });
    } }), errorCode("not_found"));
    assert.equal(calls, 1);
  }
});
