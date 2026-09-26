import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Master Yi, Wuju Bladesman (Starter)", game: "Riftbound", setName: "Origins: Proving Grounds",
  cardNumber: "019/024", productType: "Single", condition: "Near Mint", finish: "Normal", tcgplayerId: 653154,
};

function candidate() {
  // Sanitized identity and quote from the live OGS-19 response. Both providers
  // identify TCGplayer 653154, but their set and Starter name labels differ.
  return {
    id: "OGS-19", name: "Wuju Bladesman - Starter", number: "19", printed_number: "019/24",
    type: "Legend", subtypes: ["Master Yi"], rarity: "Rare", language: "English", language_code: "EN",
    expansion: { id: "OGS", name: "Proving Grounds", code: "OGS", type: "Starter", printed_total: 24, language: "English", language_code: "EN" },
    variants: [{ name: "normal", marketplaces: [{ name: "tcgplayer", product_id: "653154" }],
      prices: [{ type: "raw", condition: "NM", market: 20.62, currency: "USD", source_currency: "USD" }] }],
  };
}

function errorCode(code: ScrydexErrorCode) {
  return (error: unknown) => error instanceof ScrydexError && error.code === code;
}

function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-starters-key";
  process.env.SCRYDEX_TEAM_ID = "test-only-starters-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY;
    else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID;
    else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("Master Yi Starter retrieves the verified provider expansion and keeps its exact printing", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/riftbound/v1/cards");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.searchParams.get("include"), "prices");
    assert.ok(query.includes('(number:"019" OR number:"19") AND (expansion.name:"Origins\\: Proving Grounds" OR expansion.code:"Origins\\: Proving Grounds" OR expansion.id:"Origins\\: Proving Grounds" OR expansion.id:"OGS") AND language_code:EN'));
    assert.ok(query.includes('variants.marketplaces.product_id:"653154"'));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "OGS-19");
  assert.equal(result.cents, 2062);
  assert.equal(result.matchedName, "Wuju Bladesman - Starter");
  assert.equal(result.groupName, "Proving Grounds");
  assert.equal(result.variation, "normal / NM");
});

test("Starter aliases retain character, title, Starter edition, set, number, and language", () => {
  const entry = candidate();
  for (const patch of [
    { name: "Wuju Bladesman" }, { name: "Wuju Bladesman - Promo" }, { name: "Different - Starter" },
    { type: "Unit" }, { subtypes: ["Jinx"] }, { subtypes: ["Master Yi", "Warrior"] },
    { subtypes: [] }, { number: "20", printed_number: "020/24" }, { printed_number: "019/298" },
    { printed_number: "019a/24" }, { language_code: "JA" }, { language: "Japanese" },
    { is_online_only: true },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
  for (const patch of [
    { id: "OGN" }, { code: "OGN" }, { name: "Origins" }, { type: "Booster" },
    { printed_total: 298 }, { printed_total: undefined }, { language_code: "JA" },
    { is_online_only: true }, { is_foreign_only: true },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, expansion: { ...entry.expansion, ...patch } }]), errorCode("not_found"));
  for (const patch of [
    { name: "Master Yi, Wuju Bladesman" }, { name: "Master Yi, Wuju Bladesman (Promo)" },
    { name: "Master Yi, Wuju Bladesman (Metal) (Prize Wall)" },
    { name: "Master Yi, Wuju Bladesman (Starter) (Promo)" },
    { setName: "Origins" }, { cardNumber: "019/298" }, { cardNumber: "019a/024" },
    { game: "Pokémon" }, { productType: "Sealed", condition: "Sealed" },
  ]) assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
});

test("Starter aliases require exact marketplace proof on the selected finish", () => {
  const entry = candidate(), variant = entry.variants[0];
  for (const tcgplayerId of [undefined, null, 0, -1, 1.5, 999999]) {
    assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId }, [entry]), errorCode("not_found"));
  }
  for (const marketplaces of [[], [{ name: "tcgplayer", product_id: "999999" }], [{ name: "other", product_id: "653154" }]]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...variant, marketplaces }] }]), errorCode("not_found"));
  }
  const wrongFinish = { ...entry, variants: [
    { ...variant, marketplaces: [{ name: "tcgplayer", product_id: "999999" }] },
    { ...variant, name: "foil" },
  ] };
  assert.throws(() => selectScrydexPrice(product, [wrongFinish]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, finish: "Foil" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
  for (const patch of [{ market: 0 }, { market: -1 }, { currency: "JPY" }, { type: "graded" }, { is_signed: true }]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...variant, prices: [{ ...variant.prices[0], ...patch }] }] }]), errorCode("price_unavailable"));
  }
});

test("Proving Grounds set aliases and Starter name aliases independently preserve identity", () => {
  const entry = candidate();
  assert.equal(selectScrydexPrice({ ...product, setName: "Proving Grounds" }, [entry]).cents, 2062);
  assert.equal(selectScrydexPrice({ ...product, name: "Wuju Bladesman - Starter" }, [entry]).cents, 2062);
  assert.throws(() => selectScrydexPrice({ ...product, name: "Wuju Bladesman - Starter", tcgplayerId: undefined }, [entry]), errorCode("not_found"));
});
