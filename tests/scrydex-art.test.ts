import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Umbreon V (Alternate Full Art)", game: "Pokémon", setName: "SWSH07: Evolving Skies",
  cardNumber: "189/203", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 246719,
};
const artAnnotations = [
  "Alternate Art", "Alt Art", "Alternate Full Art", "Alt Full Art", "Full Art",
  "Alternate Art Secret", "Alt Art Secret", "Alternate Full Art Secret", "Alt Full Art Secret",
];

function candidate() {
  // Sanitized identity and NM quote from Scrydex's live swsh7-189 response.
  return {
    id: "swsh7-189", name: "Umbreon V", number: "189", printed_number: "189/203",
    language: "English", language_code: "EN",
    expansion: {
      id: "swsh7", name: "Evolving Skies", series: "Sword & Shield", code: "EVS",
      printed_total: 203, language: "English", language_code: "EN",
    },
    variants: [{
      name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "246719" }],
      prices: [{ type: "raw", condition: "NM", market: 385.2, currency: "USD", source_currency: "USD" }],
    }],
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

test("Umbreon alternate full art resolves its exact printing with one bounded request", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async input => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/pokemon/v1/cards");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.ok(query.includes('!name:"Umbreon V"'));
    assert.ok(query.includes('number:"189"'));
    assert.ok(query.includes("language_code:EN"));
    assert.ok(query.includes('variants.marketplaces.product_id:"246719"'));
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "swsh7-189");
  assert.equal(result.cents, 38520);
  assert.equal(result.variation, "holofoil / NM");
});

test("recognized Pokémon art annotations combine with verified collector suffixes in either order", () => {
  for (const annotation of artAnnotations) {
    for (const name of [
      `Umbreon V (${annotation})`,
      `Umbreon V (${annotation}) - 189/203`,
      `Umbreon V - 189/203 (${annotation})`,
    ]) {
      const result = selectScrydexPrice({ ...product, name }, [candidate()]);
      assert.equal(result.scrydexId, "swsh7-189", name);
      assert.equal(result.cents, 38520, name);
    }
  }
});

test("regular and alternate printings with the same name retain distinct IDs and collector numbers", () => {
  const alt = candidate();
  // A synthetic regular printing is a distractor, not another source of the alt-art quote.
  const regular = {
    ...alt, id: "swsh7-94", number: "94", printed_number: "094/203",
    variants: [{ ...alt.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "999999" }],
      prices: [{ ...alt.variants[0].prices[0], market: 1.23 }] }],
  };
  assert.equal(selectScrydexPrice(product, [regular, alt]).scrydexId, "swsh7-189");
  assert.equal(selectScrydexPrice({ ...product, name: "Umbreon V", cardNumber: "094/203", tcgplayerId: 999999 }, [alt, regular]).cents, 123);
  assert.throws(() => selectScrydexPrice(product, [regular]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: 999999 }, [alt, regular]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, cardNumber: "094/203" }, [alt, regular]), errorCode("not_found"));
});

test("art aliases cannot hide a mismatched collector suffix in either order", () => {
  for (const annotation of artAnnotations) {
    for (const number of ["188/203", "189/204", "189a/203"]) {
      for (const name of [`Umbreon V (${annotation}) - ${number}`, `Umbreon V - ${number} (${annotation})`]) {
        assert.throws(() => selectScrydexPrice({ ...product, name }, [candidate()]), errorCode("not_found"), name);
      }
    }
  }
});

test("art aliases still reject wrong marketplace IDs, set, collector number, and language", () => {
  const entry = candidate();
  for (const patch of [
    { tcgplayerId: 246720 }, { tcgplayerId: undefined }, { cardNumber: "188/203" }, { cardNumber: "189/204" },
    { setName: "SWSH08: Evolving Skies" }, { setName: "SWSH07: Different Set" },
  ]) assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("not_found"));
  for (const patch of [
    { language_code: "JA" }, { language: "Japanese" },
    { expansion: { ...entry.expansion, language_code: "JA" } },
    { expansion: { ...entry.expansion, series: "Scarlet & Violet" } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
});

test("an art printing's marketplace ID on another finish cannot verify the requested foil", () => {
  const entry = candidate(), foil = entry.variants[0];
  const wrongFinish = { ...entry, variants: [
    { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "999999" }] },
    { ...foil, name: "reverseHolofoil" },
  ] };
  assert.throws(() => selectScrydexPrice(product, [wrongFinish]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, finish: "First Edition Holofoil" }, [entry]), errorCode("price_unavailable"));
});

test("unrecognized annotations remain part of the name even beside a recognized art annotation", () => {
  for (const annotation of ["Promo", "First Edition", "Champion", "Secret", "Rainbow"]) {
    for (const name of [
      `Umbreon V (${annotation})`, `Umbreon V (${annotation}) (Full Art)`,
      `Umbreon V (Full Art) (${annotation})`, `Umbreon V (${annotation}) - 189/203 (Full Art)`,
    ]) assert.throws(() => selectScrydexPrice({ ...product, name }, [candidate()]), errorCode("not_found"), name);
  }
});

test("missing marketplace identity does not add an art alias query or extra API calls", async t => {
  config(t);
  let calls = 0;
  await assert.rejects(resolveScrydexPrice({ ...product, tcgplayerId: undefined }, { fetch: async input => {
    calls++;
    const query = new URL(String(input)).searchParams.get("q")!;
    assert.equal(query.includes('!name:"Umbreon V"'), false);
    assert.equal(query.includes("variants.marketplaces.product_id"), false);
    assert.equal((query.match(/!name:/g) ?? []).length, 1);
    return Response.json({ data: [candidate()], total_count: 1 });
  } }), errorCode("not_found"));
  assert.equal(calls, 1);
});

test("a failed art match does not make fallback API requests", async t => {
  config(t);
  let calls = 0;
  await assert.rejects(resolveScrydexPrice(product, { fetch: async () => {
    calls++;
    return Response.json({ data: [], total_count: 0 });
  } }), errorCode("not_found"));
  assert.equal(calls, 1);
});

test("Pokémon full-art annotations do not broaden Riftbound name matching", async t => {
  config(t);
  const riftbound: ScrydexProduct = {
    name: "Void Gate (Full Art)", game: "Riftbound", setName: "Origins", cardNumber: "296/298",
    productType: "Single", condition: "Near Mint", finish: "Normal", tcgplayerId: 999998,
  };
  const entry = {
    ...candidate(), id: "OGN-296", name: "Void Gate", number: "296", printed_number: "296/298",
    expansion: { id: "OGN", name: "Origins", code: "OGN", printed_total: 298, language_code: "EN" },
    variants: [{ name: "normal", marketplaces: [{ name: "tcgplayer", product_id: "999998" }],
      prices: [{ type: "raw", currency: "USD", condition: "NM", market: 1 }] }],
  };
  let calls = 0;
  await assert.rejects(resolveScrydexPrice(riftbound, { fetch: async input => {
    calls++;
    const query = new URL(String(input)).searchParams.get("q")!;
    assert.equal(query.includes('!name:"Void Gate"'), false);
    return Response.json({ data: [entry], total_count: 1 });
  } }), errorCode("not_found"));
  assert.equal(calls, 1);
});
