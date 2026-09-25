import assert from "node:assert/strict";
import test from "node:test";
import { selectScrydexPrice, ScrydexError, type ScrydexProduct } from "../lib/scrydex.ts";

const rawPrice = (market: number, condition = "LP", currency = "USD", source_currency = currency) => ({ type: "raw", condition, currency, source_currency, market });
const variant = (name: string, id: number, market: number, condition = "LP") => ({ name, marketplaces: [{ name: "tcgplayer", product_id: String(id) }], prices: [rawPrice(market, condition)] });
const product = (name: string, setName: string, cardNumber: string, tcgplayerId: number): ScrydexProduct => ({
  name, setName, cardNumber, tcgplayerId, game: "Pokémon", productType: "Single", condition: "Lightly Played", finish: "Normal",
});
const kadabra = product("Kadabra", "Base Set", "032/102", 42374);
const abra = product("Abra", "Base Set", "043/102", 42386);
const articuno = { ...product("Articuno", "SV9: Battle Partners", "102/100", 614978), game: "Pokémon Japanese", condition: "Near Mint", finish: "Foil" };
const pikachuMcd = { ...product("Pikachu", "McDonald's Promos 2023", "006/015", 516517), finish: "Foil" };
const pikachuWotc = product("Pikachu (1)", "WoTC Promo", "01/53", 121772);

// Relevant fields of live Scrydex records verified 2026-09-24. Edition variants
// intentionally coexist in these fixtures so tests detect unsafe fallback.
function baseCandidate(card: ScrydexProduct) {
  const isKadabra = card.tcgplayerId === 42374;
  const number = isKadabra ? "32" : "43";
  const shadowlessId = isKadabra ? 107029 : 107040;
  return {
    id: `base1-${number}`, name: card.name, number, printed_number: `${number}/102`, language: "English", language_code: "EN",
    expansion: { id: "base1", name: "Base", series: "Base", code: "BS", printed_total: 102, language: "English", language_code: "EN" },
    variants: [variant("unlimited", card.tcgplayerId!, isKadabra ? 0.94 : 0.64),
      variant("firstEditionShadowless", shadowlessId, isKadabra ? 52.37 : 29.1), variant("unlimitedShadowless", shadowlessId, isKadabra ? 11.25 : 3.38),
      { name: "unlimitedFourthPrint", marketplaces: [], prices: [] }],
  };
}
function articunoCandidate() {
  return {
    id: "sv9_ja-102", name: "フリーザー", translation: { en: { name: "Articuno" } }, number: "102", printed_number: "102/100",
    language: "Japanese", language_code: "JA",
    expansion: { id: "sv9_ja", name: "バトルパートナーズ", series: "Scarlet & Violet", code: "SV9", printed_total: 100,
      language: "Japanese", language_code: "JA", translation: { en: { name: "Battle Partners" } } },
    variants: [{ ...variant("holofoil", 614978, 9.07, "NM"), prices: [rawPrice(1400, "NM", "JPY"), rawPrice(9.07, "NM"), rawPrice(7.53)] }],
  };
}
function mcdCandidate() {
  return {
    id: "mcd23-6", name: "Pikachu", number: "6", printed_number: "006/015", language: "English", language_code: "EN",
    expansion: { id: "mcd23", name: "McDonald's Collection 2023", series: "Other", code: null as string | null, printed_total: 15, language: "English", language_code: "EN" },
    variants: [variant("holofoil", 516517, 4.14)],
  };
}
function wotcCandidate() {
  return {
    id: "basep-1", name: "Pikachu", number: "1", printed_number: "1", language: "English", language_code: "EN",
    expansion: { id: "basep", name: "Wizards Black Star Promos", series: "Base", code: "PR", printed_total: 53, language: "English", language_code: "EN" },
    variants: [variant("normal", 121772, 25.7), variant("firstEdition", 88065, 100)],
  };
}
const blocked = (error: unknown) => error instanceof ScrydexError;

test("Base Set Normal cards match only their verified Unlimited edition and LP quote", () => {
  for (const card of [kadabra, abra]) {
    const result = selectScrydexPrice(card, [baseCandidate(card)]);
    assert.equal(result.cents, card === kadabra ? 94 : 64);
    assert.equal(result.variation, "unlimited / LP");
    for (const change of [
      { tcgplayerId: null }, { tcgplayerId: card === kadabra ? 107029 : 107040 }, { setName: "Base Set 2" }, { cardNumber: "032/130" },
      { finish: "Foil" }, { name: `${card.name} (First Edition)` }, { name: `${card.name} (Shadowless)` },
    ]) assert.throws(() => selectScrydexPrice({ ...card, ...change }, [baseCandidate(card)]), blocked);
    const absent = baseCandidate(card); absent.variants = absent.variants.slice(1);
    assert.throws(() => selectScrydexPrice(card, [absent]), blocked);
    const wrongSet = baseCandidate(card); wrongSet.expansion.id = "base2";
    assert.throws(() => selectScrydexPrice(card, [wrongSet]), blocked);
    const noId = baseCandidate(card); noId.variants[0].marketplaces = [];
    assert.throws(() => selectScrydexPrice(card, [noId]), blocked);
  }
});

test("Japanese Articuno verifies native and translated SV9 identity and native USD pricing", () => {
  assert.equal(selectScrydexPrice(articuno, [articunoCandidate()]).cents, 907);
  assert.equal(selectScrydexPrice({ ...articuno, condition: "Lightly Played" }, [articunoCandidate()]).cents, 753);
  for (const change of [
    { tcgplayerId: null }, { tcgplayerId: 614979 }, { game: "Pokémon" }, { setName: "SV2a: Pokemon Card 151" },
    { cardNumber: "102/101" }, { finish: "Normal" },
  ]) assert.throws(() => selectScrydexPrice({ ...articuno, ...change }, [articunoCandidate()]), blocked);
  for (const field of ["id", "name", "series", "code", "language_code"] as const) {
    const wrongSet = articunoCandidate(); wrongSet.expansion[field] = "different";
    assert.throws(() => selectScrydexPrice(articuno, [wrongSet]), blocked);
  }
  const wrongTranslation = articunoCandidate(); wrongTranslation.expansion.translation.en.name = "Journey Together";
  assert.throws(() => selectScrydexPrice(articuno, [wrongTranslation]), blocked);
  const noTranslation = articunoCandidate(); noTranslation.translation.en.name = "";
  assert.throws(() => selectScrydexPrice(articuno, [noTranslation]), blocked);
  const converted = articunoCandidate(); converted.variants[0].prices[1].source_currency = "JPY";
  assert.throws(() => selectScrydexPrice(articuno, [converted]), blocked);
});

test("McDonald's 2023 and WotC Pikachu retain exact year, set, number, edition and condition", () => {
  assert.equal(selectScrydexPrice(pikachuMcd, [mcdCandidate()]).cents, 414);
  assert.equal(selectScrydexPrice(pikachuWotc, [wotcCandidate()]).cents, 2570);
  for (const change of [
    { tcgplayerId: null }, { tcgplayerId: 121772 }, { setName: "McDonald's Promos 2022" },
    { cardNumber: "006/025" }, { finish: "Normal" },
  ]) assert.throws(() => selectScrydexPrice({ ...pikachuMcd, ...change }, [mcdCandidate()]), blocked);
  const wrongYear = mcdCandidate(); wrongYear.expansion.id = "mcd22";
  assert.throws(() => selectScrydexPrice(pikachuMcd, [wrongYear]), blocked);
  const wrongCode = mcdCandidate(); wrongCode.expansion.code = "MCD22";
  assert.throws(() => selectScrydexPrice(pikachuMcd, [wrongCode]), blocked);
  for (const change of [
    { tcgplayerId: null }, { tcgplayerId: 88065 }, { setName: "Base Set" }, { cardNumber: "02/53" },
    { name: "Pikachu (1) (First Edition)" }, { finish: "Foil" },
  ]) assert.throws(() => selectScrydexPrice({ ...pikachuWotc, ...change }, [wotcCandidate()]), blocked);
  const wrongSeries = wotcCandidate(); wrongSeries.expansion.series = "Other";
  assert.throws(() => selectScrydexPrice(pikachuWotc, [wrongSeries]), blocked);
  const noLp = wotcCandidate(); noLp.variants[0].prices[0].condition = "NM";
  assert.throws(() => selectScrydexPrice(pikachuWotc, [noLp]), blocked);
});
