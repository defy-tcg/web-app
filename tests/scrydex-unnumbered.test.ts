import assert from "node:assert/strict";
import test from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const ancientMew: ScrydexProduct = {
  name: "Ancient Mew", game: "Pokémon", setName: "Miscellaneous Cards & Products", cardNumber: "1",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 108589,
};

function printing() {
  // Sanitized metadata and condition quotes from the live English miscp-1 response.
  return {
    id: "miscp-1", name: "Ancient Mew", number: null, printed_number: null, rarity: "Promo",
    language: "English", language_code: "EN",
    expansion: {
      id: "miscp", name: "Miscellaneous", series: "Other", code: "MISC", total: 1,
      printed_total: null, language: "English", language_code: "EN",
    },
    variants: [{
      name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "108589" }],
      prices: [
        { type: "raw", currency: "USD", condition: "NM", market: 117.64 },
        { type: "raw", currency: "USD", condition: "LP", market: 85 },
        { type: "raw", currency: "USD", condition: "MP", market: 75.28 },
        { type: "raw", currency: "USD", condition: "HP", market: 64.11 },
        { type: "raw", currency: "USD", condition: "DM", market: 37.03 },
      ],
    }],
  };
}

const errorCode = (code: ScrydexErrorCode) => (error: unknown) => error instanceof ScrydexError && error.code === code;

test("Ancient Mew's catalog number 1 maps only to its verified unnumbered Scrydex printing", () => {
  const entry = printing();
  const japanese = { ...entry, id: "miscp_ja-101", name: "ミュウ", language: "Japanese", language_code: "JA",
    expansion: { ...entry.expansion, id: "miscp_ja", language: "Japanese", language_code: "JA" },
    variants: [{ ...entry.variants[0], marketplaces: [] }],
  };
  const result = selectScrydexPrice(ancientMew, [japanese, entry]);
  assert.equal(result.scrydexId, "miscp-1");
  assert.equal(result.cents, 11764);
  assert.equal(result.groupName, "Miscellaneous");
  assert.equal(result.variation, "holofoil / NM");
  assert.equal(result.url, "https://api.scrydex.com/pokemon/v1/cards/miscp-1");
  for (const [condition, cents] of [["Lightly Played", 8500], ["Moderately Played", 7528], ["Heavily Played", 6411], ["Damaged", 3703]] as const) {
    assert.equal(selectScrydexPrice({ ...ancientMew, condition }, [entry]).cents, cents);
  }
});

test("the unnumbered alias cannot change the saved card, set, collector number, or marketplace identity", () => {
  for (const patch of [
    { name: "Mew" }, { name: "Ancient Mew (First Edition)" },
    { setName: "WoTC Promo" }, { setName: "Other" }, { setName: "Miscellaneous" },
    { cardNumber: "2" }, { cardNumber: "1/1" }, { cardNumber: "108589" },
    { tcgplayerId: undefined }, { tcgplayerId: 482427 }, { game: "Riftbound" },
  ]) {
    assert.throws(() => selectScrydexPrice({ ...ancientMew, ...patch }, [printing()]), errorCode("not_found"), JSON.stringify(patch));
  }
  assert.throws(() => selectScrydexPrice({ ...ancientMew, name: "Ancient Mew (Japanese Exclusive Print)" }, [printing()]), errorCode("unsupported"));
  assert.throws(() => selectScrydexPrice({ ...ancientMew, cardNumber: "" }, [printing()]), errorCode("incomplete_identity"));
});

test("the unnumbered alias requires complete verified provider printing and expansion metadata", () => {
  const entry = printing();
  for (const patch of [
    { id: "miscp-2" }, { id: "miscp_ja-101" }, { name: "Mew" }, { rarity: "Rare" }, { rarity: undefined },
    { number: "1" }, { printed_number: "1" }, { number: "2" }, { printed_number: "2" },
    { number: undefined }, { printed_number: undefined },
    { language_code: "JA" }, { language: "Japanese" }, { is_online_only: true },
  ]) {
    assert.throws(() => selectScrydexPrice(ancientMew, [{ ...entry, ...patch }]), errorCode("not_found"), JSON.stringify(patch));
  }
  for (const patch of [
    { id: "basep" }, { name: "Wizards Black Star Promos" }, { series: "Base" }, { code: "PROMO" },
    { printed_total: 1 }, { printed_total: undefined },
    { language_code: "JA" }, { language: "Japanese" }, { is_online_only: true }, { is_foreign_only: true },
  ]) {
    assert.throws(() => selectScrydexPrice(ancientMew, [{ ...entry, expansion: { ...entry.expansion, ...patch } }]), errorCode("not_found"), JSON.stringify(patch));
  }
  assert.throws(() => selectScrydexPrice(ancientMew, [entry, entry]), errorCode("ambiguous"));
});

test("an unnumbered match still needs the chosen finish's exact TCGplayer ID and valid condition price", () => {
  const entry = printing();
  const foil = entry.variants[0];
  for (const finish of ["Normal", "Reverse Holo", "First Edition Holofoil"]) {
    assert.throws(() => selectScrydexPrice({ ...ancientMew, finish }, [entry]), errorCode("price_unavailable"));
  }
  for (const marketplaces of [[], [{ name: "tcgplayer", product_id: "482427" }]]) {
    const wrongFinishIdentity = { ...entry, variants: [
      { ...foil, marketplaces },
      { ...foil, name: "reverseHolofoil" },
    ] };
    assert.throws(() => selectScrydexPrice(ancientMew, [wrongFinishIdentity]), errorCode("price_unavailable"));
  }
  for (const price of [
    { type: "graded", currency: "USD", condition: "NM", market: 117.64 },
    { type: "raw", currency: "JPY", condition: "NM", market: 117.64 },
    { type: "raw", currency: "USD", condition: "LP", market: 117.64 },
    { type: "raw", currency: "USD", condition: "NM", market: 0 },
    { type: "raw", currency: "USD", condition: "NM", market: -1 },
    { type: "raw", currency: "USD", condition: "NM", market: 117.64, is_error: true },
  ]) {
    assert.throws(() => selectScrydexPrice(ancientMew, [{ ...entry, variants: [{ ...foil, prices: [price] }] }]), errorCode("price_unavailable"));
  }
});

test("unknown unnumbered Pokémon cards cannot use the reviewed Ancient Mew mapping", () => {
  const entry = printing();
  const unknown = { ...ancientMew, name: "Another unnumbered promo", setName: "Miscellaneous", tcgplayerId: 999999 };
  const candidate = { ...entry, id: "miscp-999", name: unknown.name,
    variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "999999" }] }],
  };
  assert.throws(() => selectScrydexPrice(unknown, [candidate]), errorCode("not_found"));
});

test("Ancient Mew retrieval adds a bounded name, expansion and language clause without extra requests", async (t) => {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = team;
  });
  process.env.SCRYDEX_API_KEY = "test-key";
  process.env.SCRYDEX_TEAM_ID = "test-team";
  let calls = 0;
  const result = await resolveScrydexPrice(ancientMew, { fetch: async (input, options) => {
    calls += 1;
    const url = new URL(String(input));
    const query = url.searchParams.get("q")!;
    assert.equal(url.pathname, "/pokemon/v1/cards");
    assert.ok(query.includes('!name:"Ancient Mew" AND expansion.id:"miscp" AND language_code:EN'));
    assert.ok(query.includes('number:"1"'));
    assert.ok(query.includes('variants.marketplaces.product_id:"108589"'));
    assert.ok(query.includes("language_code:EN"));
    assert.equal(url.searchParams.get("include"), "prices");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(options?.redirect, "error");
    return Response.json({ data: [printing()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.cents, 11764);
});
