import assert from "node:assert/strict";
import test from "node:test";
import { verifyScrydexCatalog, scrydexCatalogProofMatches, type VerifiedScrydexCatalogProof } from "../lib/scrydex-catalog-proof.ts";
import { resolveScrydexPrice, selectScrydexPrice, ScrydexError, type ScrydexProduct } from "../lib/scrydex.ts";
import type { TcgplayerCardLookup } from "../lib/tcgplayer-card.ts";

const pidgeot: ScrydexProduct = {
  name: "Pidgeot", game: "Pokémon (Japanese)", setName: "Pokemon Jungle", cardNumber: "",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 576637,
};
function source(product = pidgeot): TcgplayerCardLookup {
  return { productId: product.tcgplayerId!, categoryId: product.game === "Pokémon" ? 3 : 85,
    name: product.name, game: product.game as TcgplayerCardLookup["game"], setName: product.setName,
    cardNumber: product.cardNumber, ...(!product.cardNumber ? { catalogNumberAbsent: true as const } : {}),
    finishes: [product.finish], warnings: [], productUrl: `https://www.tcgplayer.com/product/${product.tcgplayerId}`,
    imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${product.tcgplayerId}_in_1000x1000.jpg` };
}
const proofFor = (product = pidgeot) => verifyScrydexCatalog(product, { lookup: async (url, options) => {
  assert.equal(url, `https://www.tcgplayer.com/product/${product.tcgplayerId}`);
  assert.equal(options?.fresh, true);
  return source(product);
} });
function candidate() {
  // Sanitized live base2_ja record verified 2026-10-23. Its ID's 43 is an
  // internal ordinal, while 18 / No.018 is the printed Pokédex identity.
  return { id: "base2_ja-43", name: "ピジョット", number: "18", printed_number: "No.018",
    language: "Japanese", language_code: "JA", translation: { en: { name: "Pidgeot" } },
    expansion: { id: "base2_ja", name: "ポケモンジャングル", series: "Original", code: null,
      total: 48, printed_total: 48, language: "Japanese", language_code: "JA", translation: { en: { name: "Jungle" } } },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "576637" }], prices: [
      { type: "raw", condition: "NM", currency: "JPY", source_currency: "JPY", market: 15000 },
      { type: "raw", condition: "NM", currency: "USD", source_currency: "USD", market: 25.86 },
      { type: "raw", condition: "LP", currency: "USD", source_currency: "USD", market: 16.32 },
    ] }] };
}
const code = (value: string) => (error: unknown) => error instanceof ScrydexError && error.code === value;

test("Pidgeot's verified blank source accepts a separate Japanese internal ordinal and printed Pokédex number", async () => {
  const before = structuredClone(pidgeot), entry = candidate(), proof = await proofFor();
  const quote = selectScrydexPrice(pidgeot, [entry], { catalogProof: proof });
  assert.equal(quote.scrydexId, "base2_ja-43");
  assert.equal(quote.matchedName, "Pidgeot");
  assert.equal(quote.groupName, "Jungle");
  assert.equal(quote.variation, "holofoil / NM");
  assert.equal(quote.cents, 2586);
  assert.deepEqual(pidgeot, before, "Neither ordinal 43 nor printed number 18 replaces the source's blank number.");
  assert.deepEqual(entry, candidate(), "Provider identity is not rewritten to make it match.");
});

test("proof-backed set matching removes only one leading standalone Pokémon brand token", async () => {
  for (const setName of ["Pokemon Jungle", "Pokémon Jungle", "Jungle"]) {
    const product = { ...pidgeot, setName }, proof = await proofFor(product);
    assert.equal(selectScrydexPrice(product, [candidate()], { catalogProof: proof }).cents, 2586);
  }
  for (const setName of ["Pokemon Jungle Promos", "Pokemon Jungle 2", "Pokemon Jungle (Error)", "Pokemon Team Rocket",
    "Jungle Pokemon", "Jungle Pokémon", "Jungle Pokemon Promos", "Pokemon Pokemon Jungle", "PokemonJungle", "Pokemon"]) {
    const product = { ...pidgeot, setName }, proof = await proofFor(product);
    assert.throws(() => selectScrydexPrice(product, [candidate()], { catalogProof: proof }), code("not_found"), setName);
  }
  const proof = await proofFor(), entry = candidate();
  for (const name of ["Jungle Promos", "Jungle 2", "Jungle (No Symbol)", "Team Rocket", "Jungle Pokemon", "Pokemon"]) {
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, expansion: { ...entry.expansion, translation: { en: { name } } } }],
      { catalogProof: proof }), code("not_found"), name);
  }
});

test("an internal ordinal remains positive, numeric, within the expansion and separate from coherent No. numbering", async () => {
  const entry = candidate(), proof = await proofFor();
  for (const suffix of ["0", "49", "999999", "alpha", "-1", "1.2", "43a"]) {
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, id: `base2_ja-${suffix}` }], { catalogProof: proof }), code("not_found"), suffix);
  }
  for (const patch of [{ number: "19" }, { number: "" }, { number: null }, { printed_number: "No.019" },
    { printed_number: "18" }, { printed_number: "18/48" }, { printed_number: "No18" }, { printed_number: "No.018a" },
    { printed_number: null }, { number: "0", printed_number: "No.000" }, { id: "base3_ja-43" }])
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, ...patch }], { catalogProof: proof }), code("not_found"));
  for (const patch of [{ total: 42 }, { total: 0 }, { total: undefined }, { printed_total: undefined }, { id: "base3_ja" }])
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, expansion: { ...entry.expansion, ...patch } }], { catalogProof: proof }), code("not_found"));
});

test("ordinal support cannot turn forged proof, a changed source identity or a numbered source into a match", async () => {
  const entry = candidate(), proof = await proofFor();
  for (const forged of [{}, { verified: true }, { catalogNumberAbsent: true }, JSON.parse(JSON.stringify(proof))])
    assert.throws(() => selectScrydexPrice(pidgeot, [entry], { catalogProof: forged as VerifiedScrydexCatalogProof }), code("incomplete_identity"));
  for (const patch of [{ tcgplayerId: 576638 }, { name: "Pidgeotto" }, { setName: "Pokemon Jungle Promos" },
    { game: "Pokémon" }, { condition: "Lightly Played" }, { finish: "Reverse Holo" }, { cardNumber: "18" }]) {
    const changed = { ...pidgeot, ...patch };
    assert.equal(scrydexCatalogProofMatches(changed, proof), false);
    assert.throws(() => selectScrydexPrice(changed, [entry], { catalogProof: proof }), error => error instanceof ScrydexError);
  }
  const numbered = { ...pidgeot, cardNumber: "18" }, numberedProof = await proofFor(numbered);
  assert.throws(() => selectScrydexPrice(numbered, [entry], { catalogProof: numberedProof }), code("not_found"),
    "The special internal ordinal rule applies only when the source independently confirms its number is absent.");
  const english = { ...pidgeot, game: "Pokémon" }, englishProof = await proofFor(english);
  const englishCandidate = { ...entry, id: "base2_en-43", name: "Pidgeot", language: "English", language_code: "EN",
    expansion: { ...entry.expansion, id: "base2_en", name: "Jungle", language: "English", language_code: "EN" } };
  assert.throws(() => selectScrydexPrice(english, [englishCandidate], { catalogProof: englishProof }), code("not_found"));
});

test("Japanese ordinal recovery retains full card identity, language and selected variant marketplace proof", async () => {
  const entry = candidate(), proof = await proofFor(), foil = entry.variants[0];
  for (const patch of [{ translation: {} }, { translation: { en: { name: "Pidgeotto" } } }, { name: "" },
    { language_code: "EN" }, { language_code: "" }, { language: "English" }, { is_online_only: true }])
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, ...patch }], { catalogProof: proof }), code("not_found"));
  for (const patch of [{ name: "" }, { code: undefined }, { series: "" }, { language_code: "EN" },
    { language: "English" }, { is_online_only: true }, { is_foreign_only: true }])
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, expansion: { ...entry.expansion, ...patch } }], { catalogProof: proof }), code("not_found"));
  for (const marketplaces of [[], [{ name: "other", product_id: "576637" }], [{ name: "tcgplayer", product_id: "576638" }]])
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, variants: [{ ...foil, marketplaces }] }], { catalogProof: proof }), code("not_found"));
  const wrongFoil = { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "576638" }] };
  assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, variants: [wrongFoil, { ...foil, name: "reverseHolofoil" }] }],
    { catalogProof: proof }), code("price_unavailable"));
  assert.throws(() => selectScrydexPrice(pidgeot, [entry, entry], { catalogProof: proof }), code("ambiguous"));
  assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, variants: [foil, foil] }], { catalogProof: proof }), code("ambiguous"));
});

test("the verified Japanese ordinal printing still needs one raw USD quote for the exact finish and condition", async () => {
  const entry = candidate(), proof = await proofFor(), foil = entry.variants[0], usd = foil.prices[1];
  for (const patch of [{ type: "graded" }, { condition: "LP" }, { currency: "JPY" }, { source_currency: "JPY" },
    { source_currency: undefined }, { market: 0 }, { market: -1 }, { market: NaN }, { market: Infinity },
    { is_signed: true }, { is_error: true }, { is_perfect: true }])
    assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, variants: [{ ...foil, prices: [{ ...usd, ...patch }] }] }],
      { catalogProof: proof }), code("price_unavailable"));
  const lpProduct = { ...pidgeot, condition: "Lightly Played" }, lpProof = await proofFor(lpProduct);
  assert.equal(selectScrydexPrice(lpProduct, [entry], { catalogProof: lpProof }).cents, 1632);
  for (const finish of ["Normal", "Reverse Holo", "First Edition Holofoil"]) {
    const product = { ...pidgeot, finish }, wrongFinishProof = await proofFor(product);
    assert.throws(() => selectScrydexPrice(product, [entry], { catalogProof: wrongFinishProof }), code("price_unavailable"));
  }
  assert.throws(() => selectScrydexPrice(pidgeot, [{ ...entry, variants: [{ ...foil, prices: [usd, usd] }] }],
    { catalogProof: proof }), code("ambiguous"));
});

test("one complete Japanese set retrieval selects Pidgeot among 48 siblings and rejects truncation", async t => {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-key"; process.env.SCRYDEX_TEAM_ID = "test-only-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = team;
  });
  const proof = await proofFor(), entry = candidate();
  const cards = Array.from({ length: 48 }, (_, index) => {
    if (index === 42) return entry;
    return { ...entry, id: `base2_ja-${index + 1}`, translation: { en: { name: `Sibling ${index + 1}` } },
      variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: String(900000 + index) }] }] };
  });
  for (const total_count of [48, 49]) {
    let requests = 0;
    const quote = resolveScrydexPrice(pidgeot, { fresh: true, catalogProof: proof, fetch: async (input, init) => {
      requests++;
      const url = new URL(String(input)), query = url.searchParams.get("q")!;
      assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
      assert.ok(query.includes('expansion.translation.en.name:"Pokemon Jungle"'));
      assert.ok(query.includes('expansion.translation.en.name:"Jungle"'));
      assert.ok(query.includes("AND language_code:JA"));
      assert.ok(query.includes('variants.marketplaces.product_id:"576637"'));
      assert.ok(!query.includes('number:""'));
      assert.equal(url.searchParams.get("page"), "1"); assert.equal(url.searchParams.get("page_size"), "100");
      assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ data: cards, total_count });
    } });
    if (total_count === 48) assert.equal((await quote).cents, 2586); else await assert.rejects(quote, code("ambiguous"));
    assert.equal(requests, 1);
  }
});
