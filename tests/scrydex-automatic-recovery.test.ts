import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

// Synthetic expansions exercise the provider convention without a per-set alias.
const trainer: ScrydexProduct = {
  name: "Fixture Card", game: "Pokémon", setName: "SWSH099: Future Stars Trainer Gallery",
  cardNumber: "TG07/TG30", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 900001,
};
const galarian: ScrydexProduct = {
  ...trainer, setName: "SWSH012pt05: Future Crown: Galarian Gallery", cardNumber: "GG07/GG70",
};

function candidate(product = trainer) {
  const gallery = product === galarian;
  const expansionId = gallery ? "swsh12pt5gg" : "swsh99tg";
  return {
    id: `${expansionId}-${gallery ? "GG07" : "TG07"}`, name: product.name,
    number: gallery ? "GG07" : "TG07", printed_number: product.cardNumber, language_code: "EN", language: "English",
    expansion: {
      id: expansionId, name: gallery ? "Future Crown Galarian Gallery" : "Future Stars Trainer Gallery",
      series: "Sword & Shield", code: "FIX", printed_total: gallery ? 70 : 30, language_code: "EN", language: "English",
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "900001" }], prices: [
      { type: "raw", condition: "NM", currency: "USD", market: 12.34 },
      { type: "raw", condition: "LP", currency: "USD", market: 9.87 },
    ] }],
  };
}

const errorCode = (code: ScrydexErrorCode) => (error: unknown) => error instanceof ScrydexError && error.code === code;

function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-key";
  process.env.SCRYDEX_TEAM_ID = "test-only-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("unlisted numbered Trainer and Galarian Galleries recover from exact provider metadata", () => {
  for (const product of [trainer, galarian]) {
    const quote = selectScrydexPrice(product, [candidate(product)]);
    assert.equal(quote.cents, 1234);
    assert.equal(quote.scrydexId, candidate(product).id);
    assert.equal(quote.variation, "holofoil / NM");
    assert.equal(selectScrydexPrice({ ...product, condition: "Lightly Played" }, [candidate(product)]).cents, 987);
  }
  // Padding is the only expansion-code normalization in this recovery.
  const entry = candidate();
  assert.equal(selectScrydexPrice({ ...trainer, setName: "SWSH00099: Future Stars Trainer Gallery" }, [
    { ...entry, expansion: { ...entry.expansion, id: "swsh0099tg" } },
  ]).cents, 1234);
});

test("gallery recovery retains the entire title, known series and numbered base expansion", () => {
  const entry = candidate();
  for (const expansion of [
    { ...entry.expansion, id: "swsh99" }, { ...entry.expansion, id: "swsh98tg" },
    { ...entry.expansion, id: "swsh99gg" }, { ...entry.expansion, id: "swsh99tga" },
    { ...entry.expansion, id: "sv99tg" }, { ...entry.expansion, id: "" },
    { ...entry.expansion, name: "Future Stars" }, { ...entry.expansion, name: "Future Stars Galarian Gallery" },
    { ...entry.expansion, name: "Other Stars Trainer Gallery" }, { ...entry.expansion, name: "Future Stars Trainer Gallery Promos" },
    { ...entry.expansion, series: "Scarlet & Violet" }, { ...entry.expansion, series: "" },
  ]) assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, expansion }]), errorCode("not_found"));
  for (const setName of [
    "SWSH098: Future Stars Trainer Gallery", "SV099: Future Stars Trainer Gallery", "Unknown099: Future Stars Trainer Gallery",
    "SWSH099: Future Stars Galarian Gallery", "SWSH099: Future Stars Trainer Gallery Promos", "SWSH099: Other Stars Trainer Gallery",
    "SWSH099a: Future Stars Trainer Gallery", "SWSH099tg: Future Stars Trainer Gallery Promos",
  ]) assert.throws(() => selectScrydexPrice({ ...trainer, setName }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...trainer, name: "Other Card" }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(trainer, [entry, entry]), errorCode("ambiguous"));
});

test("automatic gallery recovery requires a complete consistent prefixed collector number", () => {
  for (const product of [trainer, galarian]) {
    const entry = candidate(product);
    for (const cardNumber of ["07", "TG07", "GG07", "TG07/30", "GG07/70", "TG07/TG29", "GG07/GG69", "TG07a/TG30", "TG00/TG30"]) {
      assert.throws(() => selectScrydexPrice({ ...product, cardNumber }, [entry]), errorCode("not_found"));
    }
    for (const number of ["07", "TG08", "GG08", ""])
      assert.throws(() => selectScrydexPrice(product, [{ ...entry, number }]), errorCode("not_found"));
    for (const printed_number of ["TG07/TG29", "GG07/GG69", "TG07/30", "GG07/70", ""])
      assert.throws(() => selectScrydexPrice(product, [{ ...entry, printed_number }]), errorCode("not_found"));
    for (const printed_total of [0, 29, 69])
      assert.throws(() => selectScrydexPrice(product, [{ ...entry, expansion: { ...entry.expansion, printed_total } }]), errorCode("not_found"));
  }
});

test("gallery recovery cannot substitute another language, digital card, or variant marketplace", () => {
  const entry = candidate(), foil = entry.variants[0];
  for (const tcgplayerId of [undefined, 900002])
    assert.throws(() => selectScrydexPrice({ ...trainer, tcgplayerId }, [entry]), errorCode("not_found"));
  for (const patch of [{ language_code: "JA" }, { language: "Japanese" }, { is_online_only: true }])
    assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, ...patch }]), errorCode("not_found"));
  for (const patch of [{ language_code: "JA" }, { language: "Japanese" }, { is_online_only: true }, { is_foreign_only: true }])
    assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, expansion: { ...entry.expansion, ...patch } }]), errorCode("not_found"));
  for (const marketplaces of [[], [{ name: "tcgplayer", product_id: "900002" }], [{ name: "other", product_id: "900001" }]])
    assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, variants: [{ ...foil, marketplaces }] }]), errorCode("not_found"));
  const wrongFoil = { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "900002" }] };
  const rightReverse = { ...foil, name: "reverseHolofoil" };
  assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, variants: [wrongFoil, rightReverse] }]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...trainer, finish: "Reverse Holo" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, variants: [foil, foil] }]), errorCode("ambiguous"));
});

test("automatic recovery still requires one positive raw USD quote for the exact condition", () => {
  const entry = candidate(), foil = entry.variants[0], raw = foil.prices[0];
  for (const patch of [
    { type: "graded" }, { condition: "MP" }, { currency: "JPY" },
    { market: 0 }, { market: -1 }, { market: NaN }, { market: Infinity },
    { is_signed: true }, { is_error: true }, { is_perfect: true },
  ]) assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, variants: [{ ...foil, prices: [{ ...raw, ...patch }] }] }]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice(trainer, [{ ...entry, variants: [{ ...foil, prices: [raw, raw] }] }]), errorCode("ambiguous"));
});

test("known gallery aliases keep their stricter metadata checks before general recovery", () => {
  const entry = candidate();
  const product = { ...trainer, setName: "SWSH09: Brilliant Stars Trainer Gallery", cardNumber: "TG11/TG30", tcgplayerId: 264218 };
  const eevee = { ...entry, id: "swsh9tg-TG11", number: "TG11", printed_number: "TG11/TG30",
    expansion: { ...entry.expansion, id: "swsh9tg", name: "Brilliant Stars Trainer Gallery", code: "BRS" },
    variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "264218" }] }],
  };
  assert.equal(selectScrydexPrice(product, [eevee]).cents, 1234);
  for (const patch of [{ code: "WRONG" }, { code: "" }, { id: "swsh09tg" }])
    assert.throws(() => selectScrydexPrice(product, [{ ...eevee, expansion: { ...eevee.expansion, ...patch } }]), errorCode("not_found"));
});

test("default and fresh gallery lookups each make one fixed-host bounded request", async t => {
  config(t);
  const timeout = AbortSignal.timeout, timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => { timeouts.push(milliseconds); return timeout(milliseconds); });
  for (const fresh of [undefined, true]) {
    let calls = 0;
    const quote = await resolveScrydexPrice(trainer, { fresh, fetch: async (input, options) => {
      calls++;
      const url = new URL(String(input)), q = url.searchParams.get("q")!;
      assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("page_size"), "100");
      assert.equal(url.searchParams.get("include"), "prices");
      assert.equal(url.searchParams.get("casing"), "snake");
      assert.ok(q.includes('!name:"Fixture Card"'));
      assert.ok(q.includes('number:"TG07"'));
      assert.ok(q.includes("AND language_code:EN"));
      assert.ok(q.includes('variants.marketplaces.product_id:"900001"'));
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal instanceof AbortSignal);
      const caching = options as RequestInit & { next?: { revalidate: number } };
      assert.equal(caching.cache, fresh ? "no-store" : undefined);
      assert.deepEqual(caching.next, fresh ? undefined : { revalidate: 86_400 });
      return Response.json({ data: [candidate()], total_count: 1 });
    } });
    assert.equal(calls, 1);
    assert.equal(quote.cents, 1234);
  }
  assert.deepEqual(timeouts, [10_000, 10_000]);
});

test("fresh lookup does not loop when provider results are absent, truncated, or invalid", async t => {
  config(t);
  for (const [payload, code] of [
    [{ data: [], total_count: 0 }, "not_found"],
    [{ data: [candidate()], total_count: 2 }, "ambiguous"],
    [{ data: [candidate()] }, "upstream_error"],
  ] as const) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice(trainer, { fresh: true, fetch: async () => { calls++; return Response.json(payload); } }), errorCode(code));
    assert.equal(calls, 1);
  }
});
