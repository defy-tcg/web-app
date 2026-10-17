import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Blaziken VMAX", game: "Pokémon", setName: "SWSH12: Silver Tempest Trainer Gallery",
  cardNumber: "TG15/TG30", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 452031,
};

function candidate() {
  // Sanitized identity and NM quote from the live swsh12tg-TG15 response verified 2026-10-16.
  return {
    id: "swsh12tg-TG15", name: "Blaziken VMAX", number: "TG15", printed_number: "TG15/TG30", language_code: "EN",
    expansion: {
      id: "swsh12tg", name: "Silver Tempest Trainer Gallery", series: "Sword & Shield", code: "SIT",
      total: 30, printed_total: 30, language: "English", language_code: "EN", is_online_only: false,
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "452031" }],
      prices: [{ type: "raw", condition: "NM", currency: "USD", market: 31.72 }] }],
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

test("Blaziken VMAX maps its numbered Trainer Gallery label to the exact gallery printing", () => {
  const result = selectScrydexPrice(product, [candidate()]);
  assert.equal(result.scrydexId, "swsh12tg-TG15");
  assert.equal(result.matchedName, "Blaziken VMAX");
  assert.equal(result.groupName, "Silver Tempest Trainer Gallery");
  assert.equal(result.variation, "holofoil / NM");
  assert.equal(result.cents, 3172);
});

test("Trainer Gallery pricing uses one bounded Pokémon search and its exact marketplace alternative", async t => {
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
    assert.ok(query.includes('!name:"Blaziken VMAX"'));
    assert.ok(query.includes('number:"TG15"'));
    assert.ok(query.includes("AND language_code:EN"));
    assert.ok(query.includes('variants.marketplaces.product_id:"452031"'));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "swsh12tg-TG15");
  assert.equal(result.cents, 3172);
});

test("Trainer Gallery aliases preserve the numbered expansion, full title, and series", () => {
  const entry = candidate();
  for (const expansion of [
    { ...entry.expansion, id: "swsh11tg" },
    { ...entry.expansion, id: "swsh12" },
    { ...entry.expansion, id: "swsh12gg" },
    { ...entry.expansion, id: "swsh12tga" },
    { ...entry.expansion, id: "" },
    { ...entry.expansion, name: "Lost Origin Trainer Gallery" },
    { ...entry.expansion, name: "Silver Tempest" },
    { ...entry.expansion, name: "Silver Tempest Galarian Gallery" },
    { ...entry.expansion, series: "Scarlet & Violet" },
    { ...entry.expansion, series: "" },
    { ...entry.expansion, code: "LOR" },
    { ...entry.expansion, code: "" },
    { ...entry.expansion, code: undefined },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, expansion }]), errorCode("not_found"));
  for (const setName of [
    "SWSH11: Silver Tempest Trainer Gallery", "SV12: Silver Tempest Trainer Gallery",
    "SWSH12: Lost Origin Trainer Gallery", "SWSH12: Silver Tempest Galarian Gallery",
    "SWSH12: Silver Tempest Bonus Gallery", "SWSH12: Silver Tempest Trainer Gallery Promos",
  ]) assert.throws(() => selectScrydexPrice({ ...product, setName }, [entry]), errorCode("not_found"));
});

test("Trainer Gallery aliases require the exact TCGplayer ID on the selected finish", () => {
  const entry = candidate(), foil = entry.variants[0];
  for (const tcgplayerId of [undefined, 452032]) {
    assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId }, [entry]), errorCode("not_found"));
  }
  for (const marketplaces of [[], [{ name: "tcgplayer", product_id: "452032" }], [{ name: "other", product_id: "452031" }]]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...foil, marketplaces }] }]), errorCode("not_found"));
  }
  const otherFinish = { ...foil, name: "reverseHolofoil" };
  const wrongFoil = { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "452032" }] };
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [wrongFoil, otherFinish] }]), errorCode("price_unavailable"));
});

test("Trainer Gallery matching preserves the complete collector number and denominator", () => {
  const entry = candidate();
  for (const cardNumber of ["TG14/TG30", "TG15/TG29", "TG15/30", "TG15a/TG30"]) {
    assert.throws(() => selectScrydexPrice({ ...product, cardNumber }, [entry]), errorCode("not_found"));
  }
  for (const printed_number of ["TG14/TG30", "TG15/TG29", "TG15/30", "TG15a/TG30"]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, printed_number }]), errorCode("not_found"));
  }
});

test("Trainer Gallery aliases cannot select the main set or an unrelated gallery suffix", () => {
  const entry = candidate();
  assert.throws(() => selectScrydexPrice({ ...product, setName: "SWSH12: Silver Tempest" }, [entry]), errorCode("not_found"));
  const mainSet = { ...entry, id: "swsh12-15", number: "15", printed_number: "15/195",
    expansion: { ...entry.expansion, id: "swsh12", name: "Silver Tempest", total: 215, printed_total: 195 } };
  assert.throws(() => selectScrydexPrice(product, [mainSet]), errorCode("not_found"));
  const galarian = { ...entry, id: "swsh12pt5gg-TG15",
    expansion: { ...entry.expansion, id: "swsh12pt5gg", name: "Crown Zenith Galarian Gallery" } };
  assert.throws(() => selectScrydexPrice({ ...product, setName: "SWSH12pt5: Crown Zenith Galarian Gallery" }, [galarian]), errorCode("not_found"));
  const bonus = { ...entry, expansion: { ...entry.expansion, id: "swsh12bg", name: "Silver Tempest Bonus Gallery" } };
  assert.throws(() => selectScrydexPrice({ ...product, setName: "SWSH12: Silver Tempest Bonus Gallery" }, [bonus]), errorCode("not_found"));
});

test("Trainer Gallery pricing still requires its physical language, condition, and positive USD quote", () => {
  const entry = candidate(), foil = entry.variants[0];
  for (const patch of [
    { language_code: "JA" }, { expansion: { ...entry.expansion, language_code: "JA" } },
    { is_online_only: true }, { expansion: { ...entry.expansion, is_online_only: true } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
  for (const patch of [{ market: 0 }, { market: -1 }, { currency: "JPY" }, { type: "graded" }]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...foil, prices: [{ ...foil.prices[0], ...patch }] }] }]), errorCode("price_unavailable"));
  }
});
