import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Giratina VSTAR (201) (Secret)", game: "Pokémon", setName: "SWSH11: Lost Origin",
  cardNumber: "201/196", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 284156,
};

function candidate() {
  // Sanitized identity and NM quote from the live swsh11-201 response verified 2026-10-16.
  return {
    id: "swsh11-201", name: "Giratina VSTAR", number: "201", printed_number: "201/196",
    rarity: "Rare Rainbow", rarity_code: "HR", language_code: "EN",
    expansion: {
      id: "swsh11", name: "Lost Origin", series: "Sword & Shield", code: "LOR", total: 217, printed_total: 196,
      language: "English", language_code: "EN", is_online_only: false,
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "284156" }],
      prices: [{ type: "raw", condition: "NM", currency: "USD", market: 28.72 }] }],
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

test("Giratina VSTAR Secret resolves its verified Sword & Shield Rainbow HR printing", () => {
  const result = selectScrydexPrice(product, [candidate()]);
  assert.equal(result.scrydexId, "swsh11-201");
  assert.equal(result.matchedName, "Giratina VSTAR");
  assert.equal(result.groupName, "Lost Origin");
  assert.equal(result.variation, "holofoil / NM");
  assert.equal(result.cents, 2872);
  assert.equal(selectScrydexPrice(product, [{ ...candidate(), rarity: "Rainbow Rare" }]).cents, 2872);
});

test("Giratina Rainbow HR pricing retains one bounded name and collector query", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/pokemon/v1/cards");
    assert.equal(url.searchParams.get("include"), "prices");
    assert.equal(url.searchParams.get("casing"), "snake");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.ok(query.includes('!name:"Giratina VSTAR"'));
    assert.ok(query.includes('number:"201"'));
    assert.ok(query.includes("AND language_code:EN"));
    assert.ok(query.includes('variants.marketplaces.product_id:"284156"'));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "swsh11-201");
  assert.equal(result.cents, 2872);
});

test("Rainbow HR retains verified collector and rarity annotations in either order", () => {
  for (const name of [
    product.name, "Giratina VSTAR (Secret) (201)", "Giratina VSTAR (201/196) (Secret)",
    "Giratina VSTAR (Secret) (201/196)", "Giratina VSTAR (Secret) - 201/196",
    "Giratina VSTAR - 201/196 (Secret)", "Giratina VSTAR (201) (Rainbow Rare)",
  ]) assert.equal(selectScrydexPrice({ ...product, name }, [candidate()]).cents, 2872, name);
  for (const name of ["Giratina VSTAR (200) (Secret)", "Giratina VSTAR (201/197) (Secret)", "Giratina VSTAR (201) (Prime)"]) {
    assert.throws(() => selectScrydexPrice({ ...product, name }, [candidate()]), errorCode("not_found"));
  }
});

test("HR code alone or with contradictory rarity cannot prove a Rainbow printing", () => {
  const entry = candidate();
  for (const name of [entry.name, product.name]) {
    for (const rarity of [undefined, "", "Rare Secret", "Secret Rare", "Rare Prime", "Rare Ultra", "Hyper Rare"]) {
      assert.throws(() => selectScrydexPrice(product, [{ ...entry, name, rarity }]), errorCode("not_found"));
    }
  }
  for (const rarity_code of ["UNKNOWN", "HYPER", "Rare Secret", "Rare Prime"]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, rarity_code }]), errorCode("not_found"));
  }
});

test("Rainbow HR alias is confined to verified Sword & Shield provider metadata", () => {
  const entry = candidate();
  // Use the provider's exact set title so failure proves the HR series check,
  // rather than the independent series-prefixed set-label check.
  const saved = { ...product, setName: "Lost Origin" };
  for (const series of [undefined, "", "Scarlet & Violet", "Sun & Moon", "Mega Evolution"]) {
    assert.throws(() => selectScrydexPrice(saved, [{ ...entry, expansion: { ...entry.expansion, series } }]), errorCode("not_found"));
  }
});

test("Giratina Rainbow HR retains exact name, set, language and full collector identity", () => {
  const entry = candidate();
  for (const patch of [
    { name: "Giratina V" }, { name: "Giratina VSTAR (201) (Secret) (Promo)" },
    { setName: "SWSH10: Astral Radiance" }, { cardNumber: "201/197" }, { cardNumber: "200/196" },
    { tcgplayerId: undefined }, { tcgplayerId: 284157 },
  ]) assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("not_found"));
  for (const patch of [
    { printed_number: "201/197" }, { printed_number: "200/196" }, { language_code: "JA" },
    { expansion: { ...entry.expansion, id: "swsh10" } },
    { expansion: { ...entry.expansion, name: "Astral Radiance" } },
    { expansion: { ...entry.expansion, language_code: "JA" } },
    { expansion: { ...entry.expansion, is_online_only: true } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
});

test("Rainbow HR needs marketplace proof on the chosen finish and its positive NM USD quote", () => {
  const entry = candidate(), foil = entry.variants[0];
  const wrongFinishId = { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "284157" }] };
  const correctOtherFinish = { ...foil, name: "reverseHolofoil" };
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [wrongFinishId, correctOtherFinish] }]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...foil, marketplaces: [] }] }]), errorCode("not_found"));
  for (const patch of [{ finish: "Normal" }, { condition: "Lightly Played" }]) {
    assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("price_unavailable"));
  }
  for (const patch of [{ market: 0 }, { market: -1 }, { currency: "JPY" }, { type: "graded" }]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...foil, prices: [{ ...foil.prices[0], ...patch }] }] }]), errorCode("price_unavailable"));
  }
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
});
