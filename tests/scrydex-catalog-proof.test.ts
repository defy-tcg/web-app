import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { lookupTcgplayerCard, type TcgplayerCardLookup } from "../lib/tcgplayer-card.ts";
import { verifyScrydexCatalog, scrydexCatalogProofMatches, ScrydexCatalogProofError, type VerifiedScrydexCatalogProof } from "../lib/scrydex-catalog-proof.ts";
import { resolveScrydexPrice, selectScrydexPrice, ScrydexError, type ScrydexProduct } from "../lib/scrydex.ts";
import { resolveSkuLinkPrice } from "../lib/sku-label-link-price.ts";

const feraligatr: ScrydexProduct = { name: "Feraligatr", game: "Pokémon (Japanese)", setName: "Neo Premium File 1",
  cardNumber: "", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 607838 };
function source(product = feraligatr): TcgplayerCardLookup {
  return { productId: product.tcgplayerId!, categoryId: product.game === "Pokémon" ? 3 : 85,
    name: product.name, game: product.game as TcgplayerCardLookup["game"], setName: product.setName, cardNumber: product.cardNumber,
    ...(!product.cardNumber ? { catalogNumberAbsent: true as const } : {}),
    finishes: ["Foil"], warnings: [], imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/607838_in_1000x1000.jpg",
    productUrl: `https://www.tcgplayer.com/product/${product.tcgplayerId}` };
}
function candidate(product = feraligatr) {
  const japanese = product.game !== "Pokémon";
  return { id: "neo1pf_ja-160", name: japanese ? "オーダイル" : product.name, number: "160", printed_number: "No.160",
    language: japanese ? "Japanese" : "English", language_code: japanese ? "JA" : "EN", translation: { en: { name: product.name } },
    expansion: { id: "neo1pf_ja", name: japanese ? "プレミアムファイル1" : product.setName, code: null, series: "Neo", total: 9, printed_total: 9,
      language: japanese ? "Japanese" : "English", language_code: japanese ? "JA" : "EN", translation: { en: { name: product.setName } } },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: String(product.tcgplayerId) }], prices: [
      { type: "raw", condition: "NM", currency: "JPY", source_currency: "JPY", market: 15000 },
      { type: "raw", condition: "NM", currency: "USD", source_currency: "USD", market: 24.07 },
    ] }] };
}
const proofFor = (product = feraligatr) => verifyScrydexCatalog(product, { lookup: async () => source(product) });
const code = (value: string) => (error: unknown) => error instanceof ScrydexError && error.code === value;
function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-key"; process.env.SCRYDEX_TEAM_ID = "test-only-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY; else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID; else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("authoritative proof recovers Feraligatr and future unlisted blank-number singles without changing their catalog", async () => {
  for (const product of [feraligatr, { ...feraligatr, tcgplayerId: 900081, name: "Future Feraligatr", setName: "Future Premium File" },
    { ...feraligatr, tcgplayerId: 900082, game: "Pokémon", setName: "Future English Premium File" }]) {
    const before = structuredClone(product);
    const proof = await verifyScrydexCatalog(product, { lookup: async (url, options) => {
      assert.equal(url, `https://www.tcgplayer.com/product/${product.tcgplayerId}`);
      assert.equal(options?.fresh, true);
      return source(product);
    } });
    const quote = selectScrydexPrice(product, [candidate(product)], { catalogProof: proof });
    assert.equal(quote.cents, 2407); assert.equal(quote.matchedName, product.name);
    assert.deepEqual(product, before);
  }
});

test("proof cannot be forged, serialized or reused after any saved identity or condition changes", async () => {
  const proof = await proofFor(), entry = candidate();
  for (const forged of [{}, { verified: true }, { catalogNumberAbsent: true }, JSON.parse(JSON.stringify(proof))]) {
    assert.equal(scrydexCatalogProofMatches(feraligatr, forged), false);
    assert.throws(() => selectScrydexPrice(feraligatr, [entry], { catalogProof: forged as VerifiedScrydexCatalogProof }), code("incomplete_identity"));
  }
  for (const patch of [{ tcgplayerId: 607839 }, { name: "Typhlosion" }, { setName: "Neo Premium File 2" },
    { game: "Pokémon" }, { condition: "Lightly Played" }, { finish: "Reverse Holo" }, { cardNumber: "160" },
    { productType: "Sealed" }, { tcgplayerUrl: "https://www.tcgplayer.com/product/607839" }]) {
    assert.equal(scrydexCatalogProofMatches({ ...feraligatr, ...patch }, proof), false);
  }
});

test("catalog proof rejects source identity conflicts, mismatched finishes and unverified number absence", async () => {
  for (const patch of [{ productId: 607839 }, { categoryId: 3 }, { game: "Pokémon" as const }, { name: "Typhlosion" },
    { setName: "Neo Premium File 2" }, { cardNumber: "160" }, { catalogNumberAbsent: undefined },
    { finishes: ["Reverse Holo"] }, { finishes: ["First Edition Holofoil"] }]) {
    await assert.rejects(verifyScrydexCatalog(feraligatr, { lookup: async () => ({ ...source(), ...patch }) }),
      error => error instanceof ScrydexCatalogProofError && error.code === "not_found");
  }
  const changing = { ...feraligatr };
  await assert.rejects(verifyScrydexCatalog(changing, { lookup: async () => { changing.condition = "Lightly Played"; return source(); } }),
    error => error instanceof ScrydexCatalogProofError && error.code === "not_found");
});

test("an unavailable finish feed remains retryable without issuing a proof or continuing to a price", async () => {
  let prices = 0, lookups = 0;
  await assert.rejects(resolveSkuLinkPrice(feraligatr, async () => {
    prices++;
    throw new ScrydexError("incomplete_identity", "The saved catalog has no number.");
  }, { verifyCatalog: product => verifyScrydexCatalog(product, { lookup: async () => {
    lookups++;
    return { ...source(), finishes: [], warnings: ["The available finishes could not be confirmed."] };
  } }) }), code("upstream_error"));
  assert.equal(lookups, 1);
  assert.equal(prices, 1, "No proof-backed pricing or Shopify continuation can run without a verified finish.");
  await assert.rejects(verifyScrydexCatalog(feraligatr, { lookup: async () => ({ ...source(), name: "Typhlosion", finishes: [] }) }),
    error => error instanceof ScrydexCatalogProofError && error.code === "not_found", "A real identity conflict remains blocked even if finishes are also unavailable.");
});

test("generic proof retains complete translations, explicit language and internally coherent provider collector metadata", async () => {
  const proof = await proofFor(), entry = candidate();
  for (const patch of [{ id: "other_ja-160" }, { name: "" }, { translation: {} }, { translation: { en: { name: "Typhlosion" } } },
    { number: "159" }, { number: null }, { printed_number: "No.159" }, { printed_number: "160/8" },
    { printed_number: "" }, { language_code: "EN" }, { language: "English" }, { is_online_only: true }])
    assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, ...patch }], { catalogProof: proof }), code("not_found"));
  for (const patch of [{ id: "other_ja" }, { name: "" }, { translation: {} }, { translation: { en: { name: "Neo Premium File 2" } } },
    { total: 0 }, { total: undefined }, { printed_total: 10 }, { printed_total: undefined }, { code: undefined },
    { language_code: "EN" }, { language: "English" }, { series: "" }, { is_online_only: true }, { is_foreign_only: true }])
    assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, expansion: { ...entry.expansion, ...patch } }], { catalogProof: proof }), code("not_found"));
  assert.throws(() => selectScrydexPrice(feraligatr, [entry, entry], { catalogProof: proof }), code("ambiguous"));
});

test("generic recovery requires the selected finish's exact ID and a single positive raw native USD quote", async () => {
  const proof = await proofFor(), entry = candidate(), foil = entry.variants[0], usd = foil.prices[1];
  for (const marketplaces of [[], [{ name: "other", product_id: "607838" }], [{ name: "tcgplayer", product_id: "607839" }]])
    assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, variants: [{ ...foil, marketplaces }] }], { catalogProof: proof }), code("not_found"));
  const wrongFoil = { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "607839" }] };
  assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, variants: [wrongFoil, { ...foil, name: "reverseHolofoil" }] }], { catalogProof: proof }), code("price_unavailable"));
  for (const patch of [{ type: "graded" }, { condition: "LP" }, { currency: "JPY" }, { source_currency: "JPY" },
    { source_currency: undefined }, { market: 0 }, { market: -1 }, { is_signed: true }, { is_error: true }])
    assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, variants: [{ ...foil, prices: [{ ...usd, ...patch }] }] }], { catalogProof: proof }), code("price_unavailable"));
  assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, variants: [{ ...foil, prices: [usd, usd] }] }], { catalogProof: proof }), code("ambiguous"));
  assert.throws(() => selectScrydexPrice(feraligatr, [{ ...entry, variants: [foil, foil] }], { catalogProof: proof }), code("ambiguous"));
});

test("source proof never relaxes a reviewed printing exception or named rarity/edition annotation", async () => {
  const typhlosion = { ...feraligatr, name: "Typhlosion", tcgplayerId: 607835 };
  const proof = await proofFor(typhlosion), entry = candidate(typhlosion);
  const exact = { ...entry, id: "neo1pf_ja-157", name: "バクフーン", number: "157", printed_number: "No.157" };
  assert.equal(selectScrydexPrice(typhlosion, [exact], { catalogProof: proof }).cents, 2407);
  for (const patch of [{ code: "NPF1" }, { total: 10 }, { name: "プレミアムファイル2" }])
    assert.throws(() => selectScrydexPrice(typhlosion, [{ ...exact, expansion: { ...exact.expansion, ...patch } }], { catalogProof: proof }), code("not_found"));
  for (const annotation of ["Secret", "Rainbow", "Prime", "First Edition", "Promo"]) {
    const product = { ...feraligatr, name: `Feraligatr (${annotation})` };
    const annotatedProof = await proofFor(product);
    assert.throws(() => selectScrydexPrice(product, [candidate()], { catalogProof: annotatedProof }), code("not_found"));
  }
});

test("numbered Japanese cards can use exact translated sets but cannot discard a saved denominator", async t => {
  config(t);
  const product = { ...feraligatr, name: "Future Card", setName: "Future Japanese Set", cardNumber: "7/9", tcgplayerId: 900083 };
  const proof = await proofFor(product), base = candidate(product);
  const entry = { ...base, id: "future_ja-7", number: "7", printed_number: "7/9", expansion: { ...base.expansion, id: "future_ja" } };
  assert.equal(selectScrydexPrice(product, [entry], { catalogProof: proof }).cents, 2407);
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, printed_number: "7/8" }], { catalogProof: proof }), code("not_found"));
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, printed_number: "7/9", number: "8" }], { catalogProof: proof }), code("not_found"));
  let requests = 0;
  const quote = await resolveScrydexPrice(product, { catalogProof: proof, fresh: true, fetch: async input => {
    requests++;
    const query = new URL(String(input)).searchParams.get("q")!;
    assert.ok(query.includes('number:"7"'));
    assert.ok(!query.includes("expansion.translation.en.name"), "A numbered recovery keeps its original collector-bound query.");
    return Response.json({ data: [entry], total_count: 1 });
  } });
  assert.equal(quote.cents, 2407); assert.equal(requests, 1);
});

test("proof recovery performs one bounded complete set lookup and refuses truncation", async t => {
  config(t);
  const proof = await proofFor();
  for (const total_count of [1, 2]) {
    let calls = 0;
    const request = resolveScrydexPrice(feraligatr, { catalogProof: proof, fresh: true, fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input)), query = url.searchParams.get("q")!;
      assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
      assert.ok(query.includes('expansion.translation.en.name:"Neo Premium File 1"'));
      assert.ok(query.includes('expansion.name:"Neo Premium File 1"'));
      assert.ok(query.includes("AND language_code:JA"));
      assert.ok(query.includes('variants.marketplaces.product_id:"607838"'));
      assert.ok(!query.includes('number:""'));
      assert.equal(url.searchParams.get("page_size"), "100"); assert.equal(url.searchParams.get("page"), "1");
      assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal instanceof AbortSignal);
      return Response.json({ data: [candidate()], total_count });
    } });
    if (total_count === 1) assert.equal((await request).cents, 2407); else await assert.rejects(request, code("ambiguous"));
    assert.equal(calls, 1);
  }
});

test("link pricing verifies only eligible catalog gaps once and never loops or adds real calls to injected resolvers", async () => {
  const proof = await proofFor(), quote = selectScrydexPrice(feraligatr, [candidate()], { catalogProof: proof });
  for (const initial of ["not_found", "incomplete_identity"] as const) {
    let resolves = 0, verifies = 0;
    const actual = await resolveSkuLinkPrice(feraligatr, async (product, options) => {
      resolves++;
      if (!options?.catalogProof) throw new ScrydexError(initial, "Original catalog gap");
      assert.equal(options.fresh, true);
      return selectScrydexPrice(product, [candidate()], { catalogProof: options.catalogProof });
    }, { verifyCatalog: async () => { verifies++; return proof; } });
    assert.deepEqual(actual, quote); assert.equal(resolves, 2); assert.equal(verifies, 1);
  }
  for (const initial of ["ambiguous", "upstream_error", "unsupported", "not_configured", "price_unavailable"] as const) {
    let resolves = 0, verifies = 0;
    await assert.rejects(resolveSkuLinkPrice(feraligatr, async () => { resolves++; throw new ScrydexError(initial, "Original error"); },
      { verifyCatalog: async () => { verifies++; return proof; } }), code(initial));
    assert.equal(verifies, 0); assert.equal(resolves, initial === "price_unavailable" ? 2 : 1);
  }
  let requests = 0;
  await assert.rejects(resolveSkuLinkPrice(feraligatr, async () => { requests++; throw new ScrydexError("not_found", "Still missing"); }), code("not_found"));
  assert.equal(requests, 2);
});

test("fresh source lookups distinguish genuine absence from malformed or missing number data", async () => {
  for (const number of [null, "", 160, {}, undefined]) {
    let requests = 0;
    const card = await lookupTcgplayerCard("https://www.tcgplayer.com/product/607838", { fresh: true, fetch: async (_input, init) => {
      assert.equal(init?.cache, "no-store"); assert.equal("next" in init!, false);
      return Response.json(++requests === 1 ? { productId: 607838, productName: "Feraligatr", productLineId: 85,
        productLineName: "Pokemon Japan", productTypeName: "Cards", setId: 24013, setName: "Neo Premium File 1",
        customAttributes: { number }, sealed: false } : { success: true, results: [{ productId: 607838, subTypeName: "Holofoil" }] });
    } });
    assert.equal(card.catalogNumberAbsent, number === null || number === "" ? true : undefined);
    assert.equal(requests, 2);
  }
});
