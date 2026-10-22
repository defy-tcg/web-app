import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { hasReviewedJapaneseCatalogNumberException, resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";
import { resolveSkuLinkPrice } from "../lib/sku-label-link-price.ts";

const typhlosion: ScrydexProduct = {
  name: "Typhlosion", game: "Pokémon (Japanese)", setName: "Neo Premium File 1", cardNumber: "",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 607835,
};

function candidate() {
  // Sanitized exact identity and raw quotes verified against live neo1pf_ja-157 on 2026-10-22.
  return {
    id: "neo1pf_ja-157", name: "バクフーン", number: "157", printed_number: "No.157",
    language: "Japanese", language_code: "JA", translation: { en: { name: "Typhlosion" } },
    rarity: null, rarity_code: null,
    expansion: {
      id: "neo1pf_ja", name: "プレミアムファイル1", series: "Neo", code: null, total: 9, printed_total: 9,
      language: "Japanese", language_code: "JA", translation: { en: { name: "Neo Premium File 1" } },
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "607835" }], prices: [
      { type: "raw", condition: "NM", currency: "JPY", source_currency: "JPY", market: 10000 },
      { type: "raw", condition: "NM", currency: "USD", source_currency: "USD", market: 30.04 },
      { type: "raw", condition: "LP", currency: "USD", source_currency: "USD", market: 22.66 },
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

test("reviewed Typhlosion maps its blank TCGplayer catalog number to the exact Japanese printing", () => {
  const original = structuredClone(typhlosion);
  assert.equal(hasReviewedJapaneseCatalogNumberException(typhlosion), true);
  const quote = selectScrydexPrice(typhlosion, [candidate()]);
  assert.equal(quote.scrydexId, "neo1pf_ja-157");
  assert.equal(quote.matchedName, "Typhlosion");
  assert.equal(quote.groupName, "Neo Premium File 1");
  assert.equal(quote.variation, "holofoil / NM");
  assert.equal(quote.cents, 3004);
  assert.equal(selectScrydexPrice({ ...typhlosion, condition: "Lightly Played" }, [candidate()]).cents, 2266);
  assert.deepEqual(typhlosion, original, "The saved blank number is never filled or changed.");
});

test("the reviewed exception cannot authorize another saved card or a guessed collector number", () => {
  const entry = candidate();
  for (const patch of [
    { name: "Typhlosion ex" }, { name: "Hisuian Typhlosion" }, { setName: "Neo Premium File 2" },
    { setName: "Neo Genesis" }, { game: "Pokémon" }, { tcgplayerId: 607836 },
    { cardNumber: "157" }, { cardNumber: "No.157" }, { cardNumber: "157/9" },
  ]) {
    const product = { ...typhlosion, ...patch };
    assert.equal(hasReviewedJapaneseCatalogNumberException(product), false);
    assert.throws(() => selectScrydexPrice(product, [entry]), error => error instanceof ScrydexError);
  }
  for (const tcgplayerId of [null, undefined, 0, -1]) {
    const product = { ...typhlosion, tcgplayerId };
    assert.equal(hasReviewedJapaneseCatalogNumberException(product), false);
    assert.throws(() => selectScrydexPrice(product, [entry]), errorCode("unsupported"));
  }
  assert.throws(() => selectScrydexPrice({ ...typhlosion, tcgplayerId: 999999 }, [entry]), errorCode("incomplete_identity"));
});

test("Typhlosion requires both native and translated names and its pinned provider numbers", () => {
  const entry = candidate();
  for (const patch of [
    { id: "neo1_ja-157" }, { name: "マグマラシ" }, { name: "Typhlosion" },
    { translation: { en: { name: "Hisuian Typhlosion" } } }, { translation: {} },
    { number: "156" }, { number: "" }, { number: null }, { printed_number: "157" },
    { printed_number: "No.156" }, { printed_number: "157/9" }, { printed_number: null },
    { language_code: "EN" }, { language: "English" }, { is_online_only: true },
  ]) assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, ...patch }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(typhlosion, [entry, entry]), errorCode("ambiguous"));
});

test("the full native and translated Neo Premium File 1 expansion remains mandatory", () => {
  const entry = candidate();
  for (const patch of [
    { id: "neo1_ja" }, { name: "プレミアムファイル2" }, { name: "Neo Premium File 1" },
    { series: "Other" }, { series: "" }, { code: "NPF1" }, { code: "" }, { code: undefined },
    { total: 8 }, { total: undefined }, { printed_total: 8 }, { printed_total: null },
    { translation: { en: { name: "Neo Premium File 2" } } }, { translation: {} },
    { language_code: "EN" }, { language_code: "" }, { language: "English" },
    { is_online_only: true }, { is_foreign_only: true },
  ]) assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, expansion: { ...entry.expansion, ...patch } }]), errorCode("not_found"));
});

test("the exact chosen foil owns the marketplace ID and one positive raw native USD price", () => {
  const entry = candidate(), foil = entry.variants[0], usd = foil.prices[1];
  for (const marketplaces of [[], [{ name: "tcgplayer", product_id: "607836" }], [{ name: "other", product_id: "607835" }]])
    assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, variants: [{ ...foil, marketplaces }] }]), errorCode("not_found"));
  const wrongFoil = { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "607836" }] };
  assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, variants: [wrongFoil, { ...foil, name: "reverseHolofoil" }] }]), errorCode("price_unavailable"));
  for (const finish of ["Normal", "Reverse Holo", "First Edition Holofoil"])
    assert.throws(() => selectScrydexPrice({ ...typhlosion, finish }, [entry]), errorCode("price_unavailable"));
  for (const patch of [
    { type: "graded" }, { condition: "LP" }, { currency: "JPY" }, { source_currency: "JPY" },
    { source_currency: undefined }, { market: 0 }, { market: -1 }, { market: NaN }, { market: Infinity },
    { is_signed: true }, { is_error: true }, { is_perfect: true },
  ]) assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, variants: [{ ...foil, prices: [{ ...usd, ...patch }] }] }]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, variants: [{ ...foil, prices: [usd, usd] }] }]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(typhlosion, [{ ...entry, variants: [foil, foil] }]), errorCode("ambiguous"));
});

test("Japanese Typhlosion retrieval stays within one exact native number and expansion query", async t => {
  config(t);
  let calls = 0;
  const quote = await resolveScrydexPrice(typhlosion, { fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
    assert.ok(query.includes('!name:"バクフーン"'));
    assert.ok(query.includes('number:"157"'));
    assert.ok(query.includes('expansion.id:"neo1pf_ja"'));
    assert.ok(query.includes("AND language_code:JA"));
    assert.ok(query.includes('variants.marketplaces.product_id:"607835"'));
    assert.ok(!query.includes('number:""'));
    assert.equal(url.searchParams.get("include"), "prices");
    assert.equal(url.searchParams.get("casing"), "snake");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ data: [candidate()], total_count: 1 });
  } });
  assert.equal(calls, 1);
  assert.equal(quote.cents, 3004);
});

test("a stale Typhlosion quote gets one fresh lookup without changing the saved blank identity", async t => {
  config(t);
  const original = structuredClone(typhlosion);
  const caches: unknown[] = [];
  const quote = await resolveSkuLinkPrice(typhlosion, (product, options) => resolveScrydexPrice(product, { ...options, fetch: async (_input, init) => {
    assert.deepEqual(product, original);
    caches.push(init?.cache);
    return caches.length === 1 ? Response.json({ data: [], total_count: 0 }) : Response.json({ data: [candidate()], total_count: 1 });
  } }));
  assert.deepEqual(caches, [undefined, "no-store"]);
  assert.equal(quote.cents, 3004);
  assert.deepEqual(typhlosion, original);
});
