import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Arceus VSTAR (Secret)", game: "Pokémon", setName: "SWSH: Crown Zenith: Galarian Gallery",
  cardNumber: "GG70/GG70", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 478101,
};
function candidate() {
  // Sanitized identity and NM quote from Scrydex's live swsh12pt5gg-GG70 response.
  return {
    id: "swsh12pt5gg-GG70", name: "Arceus VSTAR", number: "GG70", printed_number: "GG70/GG70",
    rarity: "Rare Secret", rarity_code: "Rare Secret", language: "English", language_code: "EN",
    expansion: {
      id: "swsh12pt5gg", name: "Crown Zenith Galarian Gallery", series: "Sword & Shield", code: "CRZ",
      printed_total: 70, language: "English", language_code: "EN",
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "478101" }],
      prices: [{ type: "raw", condition: "NM", market: 210.82, currency: "USD", source_currency: "USD" }] }],
  };
}
function errorCode(code: ScrydexErrorCode) {
  return (error: unknown) => error instanceof ScrydexError && error.code === code;
}
function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-key";
  process.env.SCRYDEX_TEAM_ID = "test-only-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY;
    else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID;
    else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("Arceus Secret in Galarian Gallery resolves its exact raw quote with one bounded request", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async input => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/pokemon/v1/cards");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.ok(query.includes('!name:"Arceus VSTAR"'));
    assert.ok(query.includes('number:"GG70"'));
    assert.ok(query.includes("language_code:EN"));
    assert.ok(query.includes('variants.marketplaces.product_id:"478101"'));
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "swsh12pt5gg-GG70");
  assert.equal(result.cents, 21082);
  assert.equal(result.variation, "holofoil / NM");
});

test("Secret and Rainbow annotations require their corresponding provider rarity", () => {
  for (const [annotation, expected, wrong] of [
    ["Secret", "Rare Secret", "Rare Ultra"], ["Secret Rare", "Secret Rare", "Rare Ultra"],
    ["Secret", "Rare Rainbow", "Rare Ultra"], ["Secret Rare", "Rainbow Rare", "Rare Ultra"],
    ["Rainbow", "Rare Rainbow", "Rare Secret"], ["Rainbow Rare", "Rainbow Rare", "Rare Ultra"],
  ]) {
    const saved = { ...product, name: `Arceus VSTAR (${annotation})` };
    assert.equal(selectScrydexPrice(saved, [{ ...candidate(), rarity: expected, rarity_code: expected }]).cents, 21082);
    assert.throws(() => selectScrydexPrice(saved, [{ ...candidate(), rarity: wrong, rarity_code: wrong }]), errorCode("not_found"));
  }
});

test("Arceus Secret parenthetical collectors distinguish verified rainbow and gold printings", () => {
  // Verified identity mappings; deliberately synthetic prices keep this test independent of market movement.
  const printings = [
    { number: "176", tcgplayerId: 263896, rarity: "Rare Rainbow", market: 100.01, cents: 10001 },
    { number: "184", tcgplayerId: 263904, rarity: "Rare Secret", market: 200.02, cents: 20002 },
  ];
  const entries = printings.map(printing => {
    const entry = candidate(), foil = entry.variants[0];
    return {
      ...entry, id: `swsh9-${printing.number}`, number: printing.number, printed_number: `${printing.number}/172`,
      rarity: printing.rarity, rarity_code: printing.rarity,
      expansion: { ...entry.expansion, id: "swsh9", name: "Brilliant Stars", code: "BRS", printed_total: 172 },
      variants: [{ ...foil, marketplaces: [{ name: "tcgplayer", product_id: String(printing.tcgplayerId) }],
        prices: [{ ...foil.prices[0], market: printing.market }] }],
    };
  });
  for (const printing of printings) {
    const saved = { ...product, name: `Arceus VSTAR (Secret) (${printing.number})`, setName: "Brilliant Stars",
      cardNumber: `${printing.number}/172`, tcgplayerId: printing.tcgplayerId };
    const result = selectScrydexPrice(saved, entries);
    assert.equal(result.scrydexId, `swsh9-${printing.number}`);
    assert.equal(result.cents, printing.cents);
    assert.equal(selectScrydexPrice({ ...saved, name: `Arceus VSTAR (${printing.number}/172) (Secret)` }, entries).cents, printing.cents);
    const other = printings.find(item => item.number !== printing.number)!;
    for (const patch of [
      { name: `Arceus VSTAR (Secret) (${other.number})` }, { tcgplayerId: other.tcgplayerId },
      { cardNumber: `${other.number}/172` }, { cardNumber: `${printing.number}/173` },
      { name: `Arceus VSTAR (Secret) (${printing.number}/173)` }, { name: `Arceus VSTAR (Secret) (${printing.number}a)` },
    ]) assert.throws(() => selectScrydexPrice({ ...saved, ...patch }, entries), errorCode("not_found"));
  }
});

test("rarity, art, and verified collector annotations can appear in different orders", () => {
  for (const name of [
    "Arceus VSTAR (Secret) - GG70/GG70", "Arceus VSTAR - GG70/GG70 (Secret)",
    "Arceus VSTAR (Secret) (Full Art) - GG70/GG70", "Arceus VSTAR (Full Art) - GG70/GG70 (Secret)",
    "Arceus VSTAR - GG70/GG70 (Secret) (Alternate Full Art)",
  ]) assert.equal(selectScrydexPrice({ ...product, name }, [candidate()]).cents, 21082, name);
  for (const name of ["Arceus VSTAR (Secret) - GG70/GG69", "Arceus VSTAR - GG70/GG69 (Secret) (Full Art)"]) {
    assert.throws(() => selectScrydexPrice({ ...product, name }, [candidate()]), errorCode("not_found"));
  }
});

test("missing or contradictory rarity metadata cannot be bypassed by an exact annotated name", () => {
  const entry = candidate();
  for (const name of [entry.name, product.name]) {
    for (const rarity of [
      { rarity: undefined, rarity_code: undefined }, { rarity: "", rarity_code: "" },
      { rarity: "Rare Secret", rarity_code: "Rare Rainbow" }, { rarity: "Rare Ultra", rarity_code: "Rare Secret" },
    ]) {
      assert.throws(() => selectScrydexPrice(product, [{ ...entry, name, ...rarity }]), errorCode("not_found"));
    }
  }
  // Exact names and set labels still cannot substitute for marketplace identity.
  const exact = { ...entry, name: product.name };
  for (const tcgplayerId of [undefined, 478102]) {
    assert.throws(() => selectScrydexPrice({ ...product, setName: entry.expansion.name, tcgplayerId }, [exact]), errorCode("not_found"));
  }
});

test("gallery colon matching preserves the full set title, series, and numbered expansion identity", () => {
  const entry = candidate();
  const future = { ...entry, expansion: { ...entry.expansion, id: "swsh99gg", name: "Future Set Bonus Gallery" } };
  assert.equal(selectScrydexPrice({ ...product, setName: "SWSH: Future Set: Bonus Gallery" }, [future]).cents, 21082);
  assert.equal(selectScrydexPrice({ ...product, setName: "SWSH99gg: Future Set: Bonus Gallery" }, [future]).cents, 21082);
  for (const setName of [
    "SWSH: Crown Zenith", "SWSH: Crown Zenith: Trainer Gallery", "SV: Crown Zenith: Galarian Gallery",
    "SWSH: Crown Zenith-Galarian Gallery", "SWSH: Crown Zenith / Galarian Gallery", "SWSH12pt5: Crown Zenith: Galarian Gallery",
  ]) assert.throws(() => selectScrydexPrice({ ...product, setName }, [entry]), errorCode("not_found"));
  for (const expansion of [
    { ...entry.expansion, name: "Crown Zenith" }, { ...entry.expansion, name: "Crown Zenith Trainer Gallery" },
    { ...entry.expansion, series: "Scarlet & Violet" },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, expansion }]), errorCode("not_found"));
});

test("rarity aliases retain exact marketplace, collector denominator, earlier printing, and language checks", () => {
  const entry = candidate();
  for (const patch of [{ tcgplayerId: undefined }, { tcgplayerId: 478102 }, { cardNumber: "GG70/GG69" }, { cardNumber: "GG69/GG70" }]) {
    assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("not_found"));
  }
  for (const patch of [
    { printed_number: "GG70/GG69" }, { language_code: "JA" }, { language: "Japanese" },
    { expansion: { ...entry.expansion, language_code: "JA" } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
  const earlier = { ...entry, id: "swsh9-123", number: "123", printed_number: "123/172",
    expansion: { ...entry.expansion, id: "swsh9", name: "Brilliant Stars", code: "BRS", printed_total: 172 } };
  assert.throws(() => selectScrydexPrice(product, [earlier]), errorCode("not_found"));
  assert.equal(selectScrydexPrice(product, [earlier, entry]).scrydexId, "swsh12pt5gg-GG70");
});

test("rarity aliases need marketplace proof on the chosen finish and a positive matching condition quote", () => {
  const entry = candidate(), foil = entry.variants[0];
  const variants = [
    { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "478102" }] },
    { ...foil, name: "reverseHolofoil" },
  ];
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants }]), errorCode("price_unavailable"));
  const exact = { ...entry, name: product.name, variants: [
    { ...foil, marketplaces: undefined }, { ...foil, name: "reverseHolofoil" },
  ] };
  assert.throws(() => selectScrydexPrice({ ...product, setName: entry.expansion.name }, [exact]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, finish: "Reverse Holo" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
  for (const quote of [{ ...foil.prices[0], market: 0 }, { ...foil.prices[0], currency: "JPY" }]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...foil, prices: [quote] }] }]), errorCode("price_unavailable"));
  }
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [foil, foil] }]), errorCode("ambiguous"));
});

test("unknown annotations and another game's Secret suffix remain required name identity", () => {
  for (const name of [
    "Arceus VSTAR (Promo)", "Arceus VSTAR (First Edition) (Secret)", "Arceus VSTAR (Secret) (Champion)",
    "Arceus VSTAR (Gold)", "Arceus VSTAR (Secret Rainbow)",
  ]) assert.throws(() => selectScrydexPrice({ ...product, name }, [candidate()]), errorCode("not_found"));
  const entry = candidate();
  assert.throws(() => selectScrydexPrice({ ...product, game: "Riftbound", setName: entry.expansion.name }, [entry]), errorCode("not_found"));
});

test("rarity aliases do not add base-name searches without an exact ID or make fallback requests", async t => {
  config(t);
  for (const tcgplayerId of [undefined, 478101]) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice({ ...product, tcgplayerId }, { fetch: async input => {
      calls++;
      const query = new URL(String(input)).searchParams.get("q")!;
      if (!tcgplayerId) {
        assert.equal(query.includes('!name:"Arceus VSTAR"'), false);
        assert.equal(query.includes("variants.marketplaces.product_id"), false);
      }
      return Response.json({ data: [], total_count: 0 });
    } }), errorCode("not_found"));
    assert.equal(calls, 1);
  }
});
