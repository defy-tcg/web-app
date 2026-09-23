import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { getScrydexConfig, resolveScrydexPrice, ScrydexError, scrydexConfigured, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Void Gate", game: "Riftbound", setName: "Origins", cardNumber: "296/298",
  productType: "Single", condition: "Near Mint", finish: "Normal",
};
function price(overrides: Record<string, unknown> = {}) {
  return { type: "raw", currency: "USD", condition: "NM", market: 0.29, ...overrides };
}
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "OGN-296", name: "Void Gate", number: "296", printed_number: "296/298",
    language_code: "EN", language: "English",
    expansion: { id: "OGN", name: "Origins", code: "OGN", printed_total: 298 },
    images: [{ type: "front", medium: "https://images.scrydex.com/riftbound/OGN-296/medium" }],
    variants: [{ name: "normal", prices: [price()] }, { name: "foil", prices: [price({ market: 2.55 })] }],
    ...overrides,
  };
}
const pokemonProduct: ScrydexProduct = {
  name: "Nidoking - 174/165", game: "Pokémon", setName: "SV: Scarlet & Violet 151", cardNumber: "174/165",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 517029,
};
function pokemonCandidate(overrides: Record<string, unknown> = {}) {
  // Identity/finish/price fields verified against Scrydex's English sv3pt5-174 response.
  return candidate({
    id: "sv3pt5-174", name: "Nidoking", number: "174", printed_number: "174/165",
    expansion: { id: "sv3pt5", name: "151", series: "Scarlet & Violet", code: "MEW", printed_total: 165, language: "English", language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "517029" }], prices: [price({ market: 17.02 })] }],
    ...overrides,
  });
}
const pokemonPromos = [
  { name: "Mewtwo", number: "052", id: "svp-52", tcgplayerId: 518872, market: 43.93, cents: 4393 },
  { name: "Mew ex", number: "053", id: "svp-53", tcgplayerId: 518871, market: 68.75, cents: 6875 },
];
function pokemonPromoCandidate(promo: typeof pokemonPromos[number]) {
  return pokemonCandidate({
    id: promo.id, name: promo.name, number: String(Number(promo.number)), printed_number: promo.number,
    expansion: { id: "svp", name: "Scarlet & Violet Black Star Promos", series: "Scarlet & Violet", code: "SVP", printed_total: 224, language: "English", language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: String(promo.tcgplayerId) }], prices: [price({ market: promo.market })] }],
  });
}
const megaLatiasProduct: ScrydexProduct = {
  name: "Mega Latias ex - 181/132", game: "Pokémon", setName: "ME01: Mega Evolution", cardNumber: "181/132",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 654520,
};
function megaLatiasCandidate() {
  // Sanitized printing metadata and raw USD quotes from Scrydex's live me1-181 response.
  return {
    id: "me1-181", name: "Mega Latias ex", number: "181", printed_number: "181/132", language: "English", language_code: "EN",
    expansion: { id: "me1", name: "Mega Evolution", series: "Mega Evolution", code: "MEG", printed_total: 132, language: "English", language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "654520" }], prices: [
      price({ market: 76.5 }), price({ condition: "LP", market: 85.85 }), price({ condition: "MP", market: 77.37 }),
      price({ condition: "HP", market: 60 }), price({ condition: "DM", market: 52.5 }),
    ] }],
  };
}
const japaneseProduct: ScrydexProduct = {
  name: "Charmander - 168/165", game: "Pokémon (Japanese)", setName: "SV2a: Pokemon Card 151", cardNumber: "168/165",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 566513,
};
const seismitoadProduct: ScrydexProduct = {
  name: "Seismitoad - 105/086", game: "Pokémon", setName: "SV: Black Bolt", cardNumber: "105/086",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 642558,
};
function seismitoadCandidate() {
  // Sanitized identity and NM quote from the live zsv10pt5-105 response.
  return {
    id: "zsv10pt5-105", name: "Seismitoad", number: "105", printed_number: "105/086", language: "English", language_code: "EN",
    expansion: { id: "zsv10pt5", name: "Black Bolt", series: "Scarlet & Violet", code: "BLK", printed_total: 86, language: "English", language_code: "EN" },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "642558" }], prices: [price({ market: 221.32 })] }],
  };
}
function japaneseCandidate(overrides: Record<string, unknown> = {}) {
  // Sanitized identity and native USD/JPY quotes from Scrydex's sv2a_ja-168 response.
  return {
    id: "sv2a_ja-168", name: "ヒトカゲ", number: "168", printed_number: "168/165",
    language: "Japanese", language_code: "JA", translation: { en: { name: "Charmander" } },
    expansion: {
      id: "sv2a_ja", name: "ポケモンカード151", series: "Scarlet & Violet", code: "SV2a", printed_total: 165,
      language: "Japanese", language_code: "JA", translation: { en: { name: "Pokémon Card 151" } },
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "566513" }], prices: [
      price({ currency: "JPY", source_currency: "JPY", market: 4980 }),
      price({ currency: "USD", source_currency: "USD", market: 27.73 }),
      price({ condition: "LP", currency: "USD", source_currency: "USD", market: 26.31 }),
    ] }],
    ...overrides,
  };
}
function errorCode(code: ScrydexErrorCode) {
  return (error: unknown) => error instanceof ScrydexError && error.code === code;
}
function config(t: TestContext, apiKey = "test-only-key", teamId = "test-only-team") {
  const originalKey = process.env.SCRYDEX_API_KEY;
  const originalTeam = process.env.SCRYDEX_TEAM_ID;
  t.after(() => {
    if (originalKey === undefined) delete process.env.SCRYDEX_API_KEY;
    else process.env.SCRYDEX_API_KEY = originalKey;
    if (originalTeam === undefined) delete process.env.SCRYDEX_TEAM_ID;
    else process.env.SCRYDEX_TEAM_ID = originalTeam;
  });
  process.env.SCRYDEX_API_KEY = apiKey;
  process.env.SCRYDEX_TEAM_ID = teamId;
}

test("exact English printing, finish and condition produce raw market cents without a store markup", () => {
  const result = selectScrydexPrice(product, [candidate()]);
  assert.equal(result.cents, 29);
  assert.equal(result.variation, "normal / NM");
  assert.equal(result.scrydexId, "OGN-296");
  assert.equal(result.url, "https://api.scrydex.com/riftbound/v1/cards/OGN-296");
  assert.equal(result.imageUrl, "https://images.scrydex.com/riftbound/OGN-296/medium");
  assert.equal(selectScrydexPrice({ ...product, finish: "Foil" }, [candidate()]).cents, 255);
  assert.equal(selectScrydexPrice({ ...product, setName: "OGN", condition: "NM", finish: "Non-foil" }, [candidate()]).cents, 29);
});

test("collector-number formatting tolerates leading zeroes without discarding denominator or suffix", () => {
  assert.equal(selectScrydexPrice({ ...product, cardNumber: "0296/0298" }, [candidate()]).cents, 29);
  assert.equal(selectScrydexPrice({ ...product, cardNumber: "296" }, [candidate()]).cents, 29);
  assert.equal(selectScrydexPrice(product, [candidate({ printed_number: undefined })]).cents, 29);
  for (const cardNumber of ["296/300", "296a", "297", "296/298a"]) {
    assert.throws(() => selectScrydexPrice({ ...product, cardNumber }, [candidate()]), errorCode("not_found"));
  }
});

test("a known game-name prefix may differ between store and provider without weakening product identity", () => {
  assert.equal(selectScrydexPrice({ ...product, name: "Riftbound: Void Gate" }, [candidate()]).cents, 29);
  assert.throws(() => selectScrydexPrice({ ...product, name: "Riftbound: Void Gate (Promo)" }, [candidate()]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, name: "Pokémon: Void Gate" }, [candidate()]), errorCode("not_found"));
});

test("mismatched metadata, non-English or online-only cards cannot supply a price", () => {
  const mismatches = [
    { name: "Void Gate (Alternate Art)" }, { name: "Void Gate!" }, { number: "295", printed_number: "295/298" },
    { expansion: { name: "Spiritforged", id: "SFD" } }, { language: "Japanese", language_code: "JA" },
    { language: "English", language_code: "JA" }, { language: undefined, language_code: undefined },
    { is_online_only: true }, { expansion: { name: "Origins", is_online_only: true } },
  ];
  for (const mismatch of mismatches) {
    assert.throws(() => selectScrydexPrice(product, [candidate(mismatch)]), errorCode("not_found"));
  }
  assert.throws(() => selectScrydexPrice({ ...product, name: "Void Gate (Japanese)" }, []), errorCode("unsupported"));
});

test("unknown or missing identity is rejected instead of using default single conditions and finishes", () => {
  for (const override of [{ name: "" }, { setName: "" }, { cardNumber: "" }, { finish: "" }]) {
    assert.throws(() => selectScrydexPrice({ ...product, ...override }, [candidate()]), errorCode("incomplete_identity"));
  }
  for (const condition of ["", "Mint", "PSA 10", "CGC 9.5", "Unknown"]) {
    assert.throws(() => selectScrydexPrice({ ...product, condition }, [candidate()]), errorCode("unsupported"));
  }
  assert.throws(() => selectScrydexPrice({ ...product, finish: "Unknown" }, [candidate()]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, game: "Dragon Ball" }, []), errorCode("unsupported"));
  assert.throws(() => selectScrydexPrice({ ...product, productType: "Slab" }, []), errorCode("unsupported"));
});

test("price matching rejects currency, condition, grade, missing and invalid market values", () => {
  for (const changes of [
    { currency: "JPY" }, { currency: undefined }, { condition: "LP" }, { condition: undefined },
    { type: "graded", grade: "10" }, { type: undefined }, { is_signed: true }, { is_error: true },
    { market: null, low: 2 }, { market: "2.50" }, { market: 0 }, { market: -1 },
    { market: NaN }, { market: Infinity }, { market: 0.001 }, { market: 21_474_836.48 },
  ]) {
    assert.throws(() => selectScrydexPrice(product, [candidate({ variants: [{ name: "normal", prices: [price(changes)] }] })]), errorCode("price_unavailable"));
  }
  const damaged = candidate({ variants: [{ name: "normal", prices: [price({ condition: "DM", market: 1.25 })] }] });
  assert.equal(selectScrydexPrice({ ...product, condition: "Damaged" }, [damaged]).cents, 125);
  assert.throws(() => selectScrydexPrice(product, [damaged]), errorCode("price_unavailable"));
});

test("duplicate printings, variants and prices are rejected even when only one has usable pricing", () => {
  assert.throws(() => selectScrydexPrice(product, [candidate(), candidate({ id: "other", variants: [] })]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(product, [candidate({ variants: [{ name: "normal", prices: [price()] }, { name: "Normal", prices: [] }] })]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(product, [candidate({ variants: [{ name: "normal", prices: [price(), price({ market: 5 })] }] })]), errorCode("ambiguous"));
});

test("editions and art variants are never inferred from a generic foil finish", () => {
  for (const name of ["unlimitedHolofoil", "firstEditionShadowlessHolofoil", "altArt", "mangaAltArt", "coldFoil"]) {
    const entry = candidate({ variants: [{ name, prices: [price()] }] });
    assert.throws(() => selectScrydexPrice({ ...product, finish: "Foil" }, [entry]), errorCode("price_unavailable"));
    assert.equal(selectScrydexPrice({ ...product, finish: name }, [entry]).cents, 29);
  }
});

test("TCGplayer marketplace ID can confirm an explicit art annotation but cannot override finish or metadata", () => {
  const withId = { ...product, name: "Void Gate (Alternate Art)", tcgplayerId: 123 };
  const entry = candidate({ variants: [{ name: "normal", marketplaces: [{ name: "tcgplayer", product_id: "123" }], prices: [price()] }] });
  assert.equal(selectScrydexPrice(withId, [entry]).cents, 29);
  assert.throws(() => selectScrydexPrice({ ...withId, tcgplayerId: 456 }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...withId, finish: "Foil" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...withId, setName: "Different" }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...withId, name: "A different card" }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: 456 }, [entry]), errorCode("price_unavailable"));
});

test("Pokémon's numbered name and verified 151 set label match the exact Nidoking printing", () => {
  const result = selectScrydexPrice(pokemonProduct, [pokemonCandidate()]);
  assert.equal(result.scrydexId, "sv3pt5-174"); assert.equal(result.cents, 1702); assert.equal(result.variation, "holofoil / NM");
  assert.equal(selectScrydexPrice({ ...pokemonProduct, name: "Pokémon: Nidoking - 174/165" }, [pokemonCandidate()]).cents, 1702);
  assert.equal(selectScrydexPrice({ ...pokemonProduct, name: "Nidoking - 0174/0165" }, [pokemonCandidate()]).cents, 1702);
  for (const patch of [
    { name: "Nidoking - 175/165" }, { name: "Nidoking - 174/166" }, { name: "Nidoking - 174a/165" }, { name: "Nidoqueen - 174/165" },
    { name: "Nidoking (Promo) - 174/165" }, { cardNumber: "174/166" }, { cardNumber: "174a/165" },
    { tcgplayerId: 516024 }, { tcgplayerId: undefined }, { tcgplayerId: null }, { tcgplayerId: 0 },
    { setName: "SV: Scarlet & Violet 152" }, { setName: "SWSH: Scarlet & Violet 151" }, { game: "Riftbound" },
  ]) assert.throws(() => selectScrydexPrice({ ...pokemonProduct, ...patch }, [pokemonCandidate()]), errorCode("not_found"));
});

test("Pokémon aliases require verified provider set, language, collector and selected-variant identity", () => {
  const entry = pokemonCandidate();
  for (const expansion of [
    { ...entry.expansion, id: "other" }, { ...entry.expansion, name: "other" }, { ...entry.expansion, series: "Sword & Shield" },
    { ...entry.expansion, code: "other" }, { ...entry.expansion, language_code: "JA" }, { ...entry.expansion, is_online_only: true },
  ]) assert.throws(() => selectScrydexPrice(pokemonProduct, [pokemonCandidate({ expansion })]), errorCode("not_found"));
  for (const patch of [{ printed_number: "174/166" }, { printed_number: "174a/165" }, { language_code: "JA", language: "Japanese" }, { variants: [{ name: "holofoil", prices: [price()] }] }]) {
    assert.throws(() => selectScrydexPrice(pokemonProduct, [pokemonCandidate(patch)]), errorCode("not_found"));
  }
  const wrongFinishIdentity = pokemonCandidate({ variants: [
    { name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "516024" }], prices: [price()] },
    { name: "reverseHolofoil", marketplaces: [{ name: "tcgplayer", product_id: "517029" }], prices: [price()] },
  ] });
  for (const name of [pokemonProduct.name, "Nidoking"]) {
    assert.throws(() => selectScrydexPrice({ ...pokemonProduct, name }, [wrongFinishIdentity]), errorCode("price_unavailable"));
  }
  assert.throws(() => selectScrydexPrice(pokemonProduct, [entry, entry]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice({ ...pokemonProduct, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
});

test("plain holofoil aliases preserve reverse finishes and named Pokémon editions", () => {
  for (const [saved, provider] of [["Foil", "holofoil"], ["Holofoil", "foil"], ["Reverse Holo", "reverseHolofoil"], ["Reverse Holofoil", "reverseHolo"]]) {
    const entry = pokemonCandidate({ variants: [{ name: provider, marketplaces: [{ name: "tcgplayer", product_id: "517029" }], prices: [price({ market: 17.02 })] }] });
    assert.equal(selectScrydexPrice({ ...pokemonProduct, finish: saved }, [entry]).cents, 1702);
    assert.throws(() => selectScrydexPrice({ ...pokemonProduct, finish: saved.startsWith("Reverse") ? "Foil" : "Reverse Holo" }, [entry]), errorCode("price_unavailable"));
  }
  for (const name of ["unlimitedHolofoil", "firstEditionHolofoil", "firstEditionShadowlessHolofoil", "reverseHolofoil", "stampedHolofoil", "pokeballHolofoil"]) {
    const entry = pokemonCandidate({ variants: [{ name, marketplaces: [{ name: "tcgplayer", product_id: "517029" }], prices: [price()] }] });
    assert.throws(() => selectScrydexPrice(pokemonProduct, [entry]), errorCode("price_unavailable"));
  }
  const duplicate = pokemonCandidate({ variants: ["foil", "holofoil"].map(name => ({ name, marketplaces: [{ name: "tcgplayer", product_id: "517029" }], prices: [price()] })) });
  assert.throws(() => selectScrydexPrice(pokemonProduct, [duplicate]), errorCode("ambiguous"));
});

test("verified Scarlet & Violet promo labels preserve exact Mewtwo and Mew ex identities", () => {
  const candidates = pokemonPromos.map(pokemonPromoCandidate);
  for (const promo of pokemonPromos) {
    const saved = { ...pokemonProduct, name: `${promo.name} - ${promo.number}`, cardNumber: promo.number, tcgplayerId: promo.tcgplayerId, setName: "SV: Scarlet & Violet Promo Cards" };
    const result = selectScrydexPrice(saved, candidates);
    assert.equal(result.scrydexId, promo.id); assert.equal(result.cents, promo.cents); assert.equal(result.variation, "holofoil / NM");
    for (const patch of [{ tcgplayerId: undefined }, { tcgplayerId: 1 }, { name: "Mew" }, { cardNumber: `${promo.number}/165` }, { setName: "SWSH: Sword & Shield Promo Cards" }]) {
      assert.throws(() => selectScrydexPrice({ ...saved, ...patch }, candidates), errorCode("not_found"));
    }
    const entry = pokemonPromoCandidate(promo);
    for (const expansion of [
      { ...entry.expansion, id: "swshp" }, { ...entry.expansion, name: "151" },
      { ...entry.expansion, series: "Sword & Shield" }, { ...entry.expansion, code: "SWSHP" },
    ]) assert.throws(() => selectScrydexPrice(saved, [{ ...entry, expansion }]), errorCode("not_found"));
    assert.throws(() => selectScrydexPrice({ ...saved, finish: "Reverse Holo" }, candidates), errorCode("price_unavailable"));
  }
});

test("Mega Latias's ME01 set label resolves its exact Scrydex printing and condition price", async (t) => {
  config(t);
  let calls = 0;
  const fetcher: typeof fetch = async input => {
    calls += 1;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/pokemon/v1/cards");
    assert.ok(url.searchParams.get("q")!.includes('!name:"Mega Latias ex"'));
    assert.ok(url.searchParams.get("q")!.includes('number:"181"'));
    assert.ok(url.searchParams.get("q")!.includes('variants.marketplaces.product_id:"654520"'));
    return Response.json({ data: [megaLatiasCandidate()], total_count: 1 });
  };
  const result = await resolveScrydexPrice(megaLatiasProduct, { fetch: fetcher });
  assert.equal(calls, 1); assert.equal(result.scrydexId, "me1-181"); assert.equal(result.cents, 7650);
  assert.equal(result.groupName, "Mega Evolution"); assert.equal(result.variation, "holofoil / NM");
  assert.equal(selectScrydexPrice({ ...megaLatiasProduct, condition: "Lightly Played" }, [megaLatiasCandidate()]).cents, 8585);
});

test("Mega Evolution alias still requires verified set, collector number, language and marketplace identity", () => {
  const entry = megaLatiasCandidate();
  for (const patch of [
    { setName: "ME02: Mega Evolution" }, { name: "Mega Latios ex - 181/132" }, { cardNumber: "181/133" },
    { tcgplayerId: 654521 }, { tcgplayerId: undefined },
  ]) assert.throws(() => selectScrydexPrice({ ...megaLatiasProduct, ...patch }, [entry]), errorCode("not_found"));
  for (const patch of [{ id: "me2" }, { name: "Mega Evolution Promos" }, { series: "XY" }, { code: "XY" }, { language_code: "JA" }]) {
    assert.throws(() => selectScrydexPrice(megaLatiasProduct, [{ ...entry, expansion: { ...entry.expansion, ...patch } }]), errorCode("not_found"));
  }
  const wrongSelectedVariant = { ...entry, variants: [
    { ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "654521" }] },
    { ...entry.variants[0], name: "reverseHolofoil" },
  ] };
  assert.throws(() => selectScrydexPrice(megaLatiasProduct, [wrongSelectedVariant]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...megaLatiasProduct, finish: "Reverse Holo" }, [entry]), errorCode("price_unavailable"));
  for (const changes of [{ currency: "JPY" }, { condition: "LP" }, { market: 0 }]) {
    const variant = { ...entry.variants[0], prices: [price({ market: 76.5, ...changes })] };
    assert.throws(() => selectScrydexPrice(megaLatiasProduct, [{ ...entry, variants: [variant] }]), errorCode("price_unavailable"));
  }
});

test("new Pokémon series-prefixed set labels resolve Seismitoad in one bounded request", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(seismitoadProduct, { fetch: async input => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/pokemon/v1/cards");
    assert.ok(url.searchParams.get("q")!.includes('!name:"Seismitoad"'));
    assert.ok(url.searchParams.get("q")!.includes('number:"105"'));
    assert.ok(url.searchParams.get("q")!.includes("language_code:EN"));
    assert.ok(url.searchParams.get("q")!.includes('variants.marketplaces.product_id:"642558"'));
    return Response.json({ data: [seismitoadCandidate()], total_count: 1 });
  } });
  assert.equal(calls, 1); assert.equal(result.cents, 22132);
  assert.equal(result.scrydexId, "zsv10pt5-105"); assert.equal(result.groupName, "Black Bolt");
});

test("unlisted Pokémon sets match their series and exact title without a per-set release", () => {
  const entry = seismitoadCandidate();
  // Deliberately synthetic titles prove the rule is driven by provider metadata, not a new whitelist.
  for (const [prefix, series, id] of [
    ["SV", "Scarlet & Violet", "sv99"], ["SWSH", "Sword & Shield", "swsh99"],
    ["SM", "Sun & Moon", "sm99"], ["XY", "XY", "xy99"], ["BW", "Black & White", "bw99"],
    ["ME", "Mega Evolution", "me99"], ["ME099", "Mega Evolution", "me99"],
    ["Scarlet & Violet", "Scarlet & Violet", "sv99"],
  ]) {
    const expansion = { ...entry.expansion, id, name: "Future Set Fixture", series };
    const saved = { ...seismitoadProduct, setName: `${prefix}: Future Set Fixture` };
    assert.equal(selectScrydexPrice(saved, [{ ...entry, expansion }]).cents, 22132);
    assert.throws(() => selectScrydexPrice({ ...saved, setName: `${prefix}: Different Set` }, [{ ...entry, expansion }]), errorCode("not_found"));
  }
});

test("general set matching rejects conflicting series, numbering, language and card identity", () => {
  const entry = seismitoadCandidate();
  for (const patch of [
    { setName: "SWSH: Black Bolt" }, { setName: "Unknown: Black Bolt" }, { setName: "SV11: Black Bolt" },
    { setName: "SV: Black Bolt Promos" }, { setName: "SV: White Flare" }, { name: "Seismitoad (Promo) - 105/086" },
    { cardNumber: "105/087" }, { cardNumber: "105a/086" }, { tcgplayerId: undefined }, { tcgplayerId: 642559 },
  ]) assert.throws(() => selectScrydexPrice({ ...seismitoadProduct, ...patch }, [entry]), errorCode("not_found"));
  for (const expansion of [
    { ...entry.expansion, name: "White Flare" }, { ...entry.expansion, series: "Sword & Shield" },
    { ...entry.expansion, series: "" }, { ...entry.expansion, language_code: "JA" },
  ]) assert.throws(() => selectScrydexPrice(seismitoadProduct, [{ ...entry, expansion }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(seismitoadProduct, [{ ...entry, language_code: "JA" }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(seismitoadProduct, [{ ...entry, printed_number: "105/087" }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(seismitoadProduct, [entry, entry]), errorCode("ambiguous"));
  const numbered = { ...entry, expansion: { ...entry.expansion, id: "me2", name: "Future Set Fixture", series: "Mega Evolution" } };
  assert.throws(() => selectScrydexPrice({ ...seismitoadProduct, setName: "ME03: Future Set Fixture" }, [numbered]), errorCode("not_found"));
});

test("general set matching requires marketplace proof on the selected finish and its positive condition quote", () => {
  const entry = seismitoadCandidate();
  const foil = entry.variants[0];
  const wrongFinish = { ...entry, variants: [
    { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "1" }] },
    { ...foil, name: "reverseHolofoil" },
  ] };
  // A bare exact card name must not allow another finish's marketplace ID to verify the set.
  for (const name of [seismitoadProduct.name, "Seismitoad"]) {
    assert.throws(() => selectScrydexPrice({ ...seismitoadProduct, name }, [wrongFinish]), errorCode("price_unavailable"));
    assert.throws(() => selectScrydexPrice({ ...seismitoadProduct, name, tcgplayerId: undefined }, [entry]), errorCode("not_found"));
  }
  for (const patch of [{ finish: "Reverse Holo" }, { finish: "First Edition Holofoil" }, { condition: "Lightly Played" }]) {
    assert.throws(() => selectScrydexPrice({ ...seismitoadProduct, ...patch }, [entry]), errorCode("price_unavailable"));
  }
  for (const quote of [price({ market: 0 }), price({ currency: "JPY", market: 221.32 })]) {
    assert.throws(() => selectScrydexPrice(seismitoadProduct, [{ ...entry, variants: [{ ...foil, prices: [quote] }] }]), errorCode("price_unavailable"));
  }
});

test("explicit Japanese Pokémon identity selects the verified translated Charmander and native USD quote", () => {
  const result = selectScrydexPrice(japaneseProduct, [japaneseCandidate()]);
  assert.equal(result.cents, 2773); assert.equal(result.scrydexId, "sv2a_ja-168");
  assert.equal(result.matchedName, "Charmander"); assert.equal(result.groupName, "Pokémon Card 151");
  assert.equal(result.url, "https://api.scrydex.com/pokemon/v1/cards/sv2a_ja-168");
  assert.equal(result.variation, "holofoil / NM");
  assert.equal(selectScrydexPrice({ ...japaneseProduct, condition: "Lightly Played" }, [japaneseCandidate()]).cents, 2631);
  assert.equal(selectScrydexPrice({ ...japaneseProduct, name: "Charmander - 0168/0165", cardNumber: "0168/0165" }, [japaneseCandidate()]).cents, 2773);
});

test("Japanese support never infers language from a title or reuses an English or unknown-language candidate", () => {
  for (const game of ["Pokémon", "Other"]) {
    assert.throws(() => selectScrydexPrice({ ...japaneseProduct, game }, [japaneseCandidate()]), ScrydexError);
  }
  const entry = japaneseCandidate();
  for (const patch of [
    { language: "English", language_code: "EN" }, { language: "English" },
    { language_code: undefined }, { language_code: "KO", language: "Korean" },
    { expansion: { ...entry.expansion, language: "English", language_code: "EN" } },
    { expansion: { ...entry.expansion, language_code: undefined } },
    { expansion: { ...entry.expansion, language: "English" } },
  ]) assert.throws(() => selectScrydexPrice(japaneseProduct, [japaneseCandidate(patch)]), errorCode("not_found"));
  for (const tcgplayerId of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectScrydexPrice({ ...japaneseProduct, tcgplayerId }, [entry]), errorCode("unsupported"));
  }
  assert.throws(() => selectScrydexPrice({ ...japaneseProduct, productType: "Sealed" }, [entry]), errorCode("unsupported"));
});

test("Japanese translated names, native set metadata, collector and marketplace remain mandatory", () => {
  const entry = japaneseCandidate();
  for (const patch of [
    { translation: undefined }, { translation: { en: { name: "Charmeleon" } } },
    { number: "169", printed_number: "169/165" }, { printed_number: "168/166" },
    { printed_number: "168a/165" }, { is_online_only: true },
    { variants: [{ ...entry.variants[0], marketplaces: [] }] },
    { variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "517029" }] }] },
  ]) assert.throws(() => selectScrydexPrice(japaneseProduct, [japaneseCandidate(patch)]), errorCode("not_found"));
  for (const patch of [
    { id: "sv3pt5" }, { name: "151" }, { series: "Sword & Shield" }, { code: "MEW" },
    { translation: undefined }, { translation: { en: { name: "Pokémon Card 152" } } }, { is_online_only: true },
  ]) assert.throws(() => selectScrydexPrice(japaneseProduct, [japaneseCandidate({ expansion: { ...entry.expansion, ...patch } })]), errorCode("not_found"));
  for (const patch of [
    { name: "Charmander - 169/165" }, { name: "Charmeleon - 168/165" }, { name: "Charmander (Promo) - 168/165" },
    { setName: "SV: Scarlet & Violet 151" }, { setName: "SV2a: Pokemon Card 152" }, { tcgplayerId: 517029 },
  ]) assert.throws(() => selectScrydexPrice({ ...japaneseProduct, ...patch }, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(japaneseProduct, [entry, entry]), errorCode("ambiguous"));
});

test("Japanese selected finish must own the TCGplayer ID and preserve named editions", () => {
  const entry = japaneseCandidate();
  const wrongFinishId = japaneseCandidate({ variants: [
    { ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "1" }] },
    { ...entry.variants[0], name: "reverseHolofoil" },
  ] });
  for (const name of [japaneseProduct.name, "Charmander"]) {
    assert.throws(() => selectScrydexPrice({ ...japaneseProduct, name }, [wrongFinishId]), errorCode("price_unavailable"));
  }
  for (const name of ["reverseHolofoil", "pokeballHolofoil", "masterballHolofoil", "firstEditionHolofoil"]) {
    assert.throws(() => selectScrydexPrice(japaneseProduct, [japaneseCandidate({ variants: [{ ...entry.variants[0], name }] })]), errorCode("price_unavailable"));
  }
  assert.throws(() => selectScrydexPrice({ ...japaneseProduct, condition: "Moderately Played" }, [entry]), errorCode("price_unavailable"));
});

test("Japanese pricing never converts JPY or uses a USD quote sourced from another currency", () => {
  const entry = japaneseCandidate();
  for (const changes of [
    { currency: "JPY", source_currency: "JPY", market: 4980 }, { source_currency: "JPY" },
    { source_currency: undefined }, { currency: "EUR", source_currency: "EUR" },
    { condition: "LP" }, { type: "graded" }, { is_signed: true }, { is_error: true }, { is_perfect: true },
  ]) {
    const prices = [price({ source_currency: "USD", market: 27.73, ...changes })];
    assert.throws(() => selectScrydexPrice(japaneseProduct, [japaneseCandidate({ variants: [{ ...entry.variants[0], prices }] })]), errorCode("price_unavailable"));
  }
  const duplicate = [price({ source_currency: "USD" }), price({ source_currency: "USD", market: 27.73 })];
  assert.throws(() => selectScrydexPrice(japaneseProduct, [japaneseCandidate({ variants: [{ ...entry.variants[0], prices: duplicate }] })]), errorCode("ambiguous"));
});

test("sealed supports only documented games, exact names and sets, unopened condition and explicit editions", () => {
  const sealed = { ...product, name: "Origins Booster Pack", productType: "Sealed", cardNumber: "", condition: "", finish: "" };
  const entry = candidate({ name: sealed.name, variants: [{ name: "normal", prices: [price({ condition: "U", market: 13.32 })] }] });
  for (const game of ["Pokémon", "One Piece", "Riftbound"]) {
    assert.equal(selectScrydexPrice({ ...sealed, game }, [entry]).cents, 1332);
  }
  for (const game of ["MTG", "Lorcana", "Gundam"]) {
    assert.throws(() => selectScrydexPrice({ ...sealed, game }, [entry]), errorCode("unsupported"));
  }
  assert.throws(() => selectScrydexPrice({ ...sealed, condition: "Damaged" }, [entry]), errorCode("unsupported"));
  assert.throws(() => selectScrydexPrice(sealed, [candidate({ name: sealed.name })]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...sealed, name: "Origins Booster Box" }, [entry]), errorCode("not_found"));
});

test("Lorcana requires the documented character version in the full name", () => {
  const entry = candidate({ name: "Minnie Mouse", version: "Daring Defender" });
  assert.equal(selectScrydexPrice({ ...product, game: "Lorcana", name: "Minnie Mouse - Daring Defender" }, [entry]).cents, 29);
  assert.throws(() => selectScrydexPrice({ ...product, game: "Lorcana", name: "Minnie Mouse" }, [entry]), errorCode("not_found"));
});

test("missing and unsafe image URLs do not escape the verified Scrydex image host", () => {
  for (const medium of ["javascript:alert(1)", "https://other.example/card", "https://secret@images.scrydex.com/card", "bad"]) {
    assert.equal(selectScrydexPrice(product, [candidate({ images: [{ type: "front", medium }] })]).imageUrl, undefined);
  }
});

test("configuration is read at call time, and missing configuration never makes an API request", async (t) => {
  config(t, "", "");
  assert.equal(scrydexConfigured(), false);
  assert.throws(getScrydexConfig, errorCode("not_configured"));
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("must not fetch"); };
  await assert.rejects(resolveScrydexPrice(product, { fetch: fetcher }), errorCode("not_configured"));
  assert.equal(calls, 0);
  process.env.SCRYDEX_API_KEY = "test-only-key";
  assert.equal(scrydexConfigured(), false);
  process.env.SCRYDEX_TEAM_ID = "test-only-team";
  assert.deepEqual(getScrydexConfig(), { apiKey: "test-only-key", teamId: "test-only-team" });
});

test("request authenticates only in headers, includes prices, uses daily cache, and never follows redirects", async (t) => {
  config(t);
  let calls = 0;
  const fetcher: typeof fetch = async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/riftbound/v1/cards");
    assert.equal(url.searchParams.get("include"), "prices");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.href.includes("test-only"), false);
    assert.equal(new Headers(options?.headers).get("X-Team-ID"), "test-only-team");
    assert.equal(new Headers(options?.headers).get("X-Api-Key"), "test-only-key");
    assert.equal(options?.redirect, "error");
    assert.equal((options as RequestInit & { next: { revalidate: number } }).next.revalidate, 86_400);
    assert.ok(options?.signal);
    return Response.json({ data: [candidate()], page: 1, page_size: 100, total_count: 1 });
  };
  assert.equal((await resolveScrydexPrice(product, { fetch: fetcher })).cents, 29);
  assert.equal(calls, 1);
});

test("alternate-art search includes the provider base name and still selects Rengar's exact printing", async (t) => {
  config(t);
  const rengar: ScrydexProduct = {
    name: "Rengar, Trophy Hunter (Alternate Art)", game: "Riftbound", setName: "Unleashed",
    cardNumber: "120a/219", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 684216,
  };
  // Identity and price fields from the English Scrydex UNL-120a response.
  const alternate = candidate({
    id: "UNL-120a", name: "Rengar, Trophy Hunter", number: "120a", printed_number: "120a/219",
    expansion: { id: "UNL", name: "Unleashed", code: "UNL", printed_total: 219, language: "English", language_code: "EN" },
    variants: [{ name: "foil", marketplaces: [{ name: "tcgplayer", product_id: "684216" }], prices: [price({ market: 42.94 })] }],
  });
  const regular = {
    ...alternate, id: "UNL-120", number: "120", printed_number: "120/219",
    variants: [{ name: "foil", marketplaces: [{ name: "tcgplayer", product_id: "684215" }], prices: [price({ market: 41.28 })] }],
  };
  for (const name of [rengar.name, "Rengar, Trophy Hunter (Alt Art)", `Riftbound: ${rengar.name}`]) {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls++;
      const url = new URL(String(input));
      const query = url.searchParams.get("q") ?? "";
      assert.ok(query.includes('variants.marketplaces.product_id:"684216"'));
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("page_size"), "100");
      // The original full-name/marketplace query returns no results for this card.
      const data = query.includes('!name:"Rengar, Trophy Hunter"') ? [regular, alternate] : [];
      return Response.json({ data, total_count: data.length });
    };
    const result = await resolveScrydexPrice({ ...rengar, name }, { fetch: fetcher });
    assert.equal(result.scrydexId, "UNL-120a");
    assert.equal(result.cents, 4294);
    assert.equal(calls, 1);
  }
  const fetcher: typeof fetch = async () => Response.json({ data: [regular, alternate], total_count: 2 });
  for (const override of [{ tcgplayerId: 684215 }, { cardNumber: "120/219" }, { setName: "Origins" }, { name: "Rengar, Trophy Hunter (Champion)" }]) {
    await assert.rejects(resolveScrydexPrice({ ...rengar, ...override }, { fetch: fetcher }), errorCode("not_found"));
  }
  for (const override of [{ finish: "Normal" }, { condition: "Lightly Played" }]) {
    await assert.rejects(resolveScrydexPrice({ ...rengar, ...override }, { fetch: fetcher }), errorCode("price_unavailable"));
  }
});

test("alternate-art search never removes an annotation without a valid marketplace ID", async (t) => {
  config(t);
  for (const tcgplayerId of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls++;
      const query = new URL(String(input)).searchParams.get("q") ?? "";
      assert.equal(query.includes('!name:"Void Gate"'), false);
      assert.equal(query.includes("variants.marketplaces.product_id:"), false);
      return Response.json({ data: [candidate()], total_count: 1 });
    };
    await assert.rejects(resolveScrydexPrice({ ...product, name: "Void Gate (Alternate Art)", tcgplayerId }, { fetch: fetcher }), errorCode("not_found"));
    assert.equal(calls, 1);
  }
});

test("Pokémon lookup includes its verified collector-free name in one bounded search", async (t) => {
  config(t);
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    const url = new URL(String(input)); const q = url.searchParams.get("q") ?? "";
    assert.equal(url.pathname, "/pokemon/v1/cards"); assert.equal(url.searchParams.get("page_size"), "100"); assert.equal(url.searchParams.get("page"), "1");
    assert.ok(q.includes('variants.marketplaces.product_id:"517029"'));
    const data = q.includes('!name:"Nidoking"') ? [pokemonCandidate(), pokemonCandidate({ id: "sv3pt5-34", number: "34", printed_number: "034/165" })] : [];
    return Response.json({ data, total_count: data.length });
  };
  assert.equal((await resolveScrydexPrice(pokemonProduct, { fetch: fetcher })).cents, 1702); assert.equal(calls, 1);
  for (const patch of [{ tcgplayerId: undefined }, { name: "Nidoking - 174/166" }, { game: "Riftbound" }]) {
    let requests = 0;
    const noAlias: typeof fetch = async input => {
      requests++; assert.equal((new URL(String(input)).searchParams.get("q") ?? "").includes('!name:"Nidoking"'), false);
      return Response.json({ data: [], total_count: 0 });
    };
    await assert.rejects(resolveScrydexPrice({ ...pokemonProduct, ...patch }, { fetch: noAlias }), errorCode("not_found")); assert.equal(requests, 1);
  }
});

test("numbered Pokémon promos search their exact base names without merging Mew and Mew ex", async (t) => {
  config(t);
  for (const promo of pokemonPromos) {
    let calls = 0;
    const fetcher: typeof fetch = async input => {
      calls++; const url = new URL(String(input)); const query = url.searchParams.get("q") ?? "";
      assert.ok(query.includes(`!name:"${promo.name}"`));
      assert.equal(query.includes('!name:"Mew"'), false);
      assert.equal(url.searchParams.get("page_size"), "100"); assert.equal(url.searchParams.get("page"), "1");
      return Response.json({ data: pokemonPromos.map(pokemonPromoCandidate), total_count: 2 });
    };
    const result = await resolveScrydexPrice({ ...pokemonProduct, name: `${promo.name} - ${promo.number}`, cardNumber: promo.number, tcgplayerId: promo.tcgplayerId, setName: "SV: Scarlet & Violet Promo Cards" }, { fetch: fetcher });
    assert.equal(result.scrydexId, promo.id); assert.equal(result.cents, promo.cents); assert.equal(calls, 1);
  }
});

test("common English Pokémon names use collector number and language to avoid truncated pricing searches", async (t) => {
  config(t);
  const pikachu = { ...pokemonProduct, name: "Pikachu - 173/165", cardNumber: "173/165", tcgplayerId: 513721 };
  const exact = pokemonCandidate({ id: "sv3pt5-173", name: "Pikachu", number: "173", printed_number: "173/165",
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "513721" }], prices: [price({ market: 79.71 })] }] });
  for (const cardNumber of ["173/165", "0173/0165"]) {
    let calls = 0;
    const fetcher: typeof fetch = async input => {
      calls++;
      const q = new URL(String(input)).searchParams.get("q") ?? "";
      assert.ok(q.includes('variants.marketplaces.product_id:"513721"'));
      const bounded = q.includes('AND (number:"173"') || q.includes('AND (number:"0173" OR number:"173")');
      assert.ok(q.includes("AND language_code:EN"));
      return Response.json({ data: [exact], total_count: bounded ? 1 : 340 });
    };
    const quote = await resolveScrydexPrice({ ...pikachu, cardNumber }, { fetch: fetcher });
    assert.equal(quote.scrydexId, "sv3pt5-173"); assert.equal(quote.cents, 7971); assert.equal(calls, 1);
  }
  for (const patch of [{ tcgplayerId: 513722 }, { cardNumber: "173/166" }, { setName: "Different set" }]) {
    await assert.rejects(resolveScrydexPrice({ ...pikachu, ...patch }, { fetch: async () => Response.json({ data: [exact], total_count: 1 }) }), ScrydexError);
  }
});

test("Japanese lookup uses one collector-number and JA search with exact marketplace proof", async (t) => {
  config(t);
  for (const cardNumber of ["168/165", "0168/0165"]) {
    let calls = 0;
    const fetcher: typeof fetch = async input => {
      calls++; const url = new URL(String(input)); const query = url.searchParams.get("q") ?? "";
      assert.equal(url.pathname, "/pokemon/v1/cards");
      assert.equal(url.searchParams.get("page_size"), "100"); assert.equal(url.searchParams.get("page"), "1");
      assert.ok(query.includes('number:"168"')); assert.ok(query.includes("AND language_code:JA"));
      assert.ok(query.includes('variants.marketplaces.product_id:"566513"'));
      assert.equal(query.includes("name:"), false);
      if (cardNumber.startsWith("0")) assert.ok(query.includes('number:"0168"'));
      return Response.json({ data: [japaneseCandidate(), japaneseCandidate({ id: "other-ja", translation: { en: { name: "Pikachu" } } })], total_count: 2 });
    };
    assert.equal((await resolveScrydexPrice({ ...japaneseProduct, cardNumber }, { fetch: fetcher })).cents, 2773);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const incomplete: typeof fetch = async () => { calls++; return Response.json({ data: [japaneseCandidate()], total_count: 101 }); };
  await assert.rejects(resolveScrydexPrice(japaneseProduct, { fetch: incomplete }), errorCode("ambiguous"));
  assert.equal(calls, 1);
});

test("malformed, truncated and duplicate search results fail without a second request", async (t) => {
  config(t);
  for (const payload of [
    { data: [candidate()], total_count: 101 }, { data: [candidate()], totalCount: 2 },
    { data: [candidate()] }, { data: [candidate()], total_count: 0 }, { data: {}, total_count: 0 },
    { data: [candidate()], total_count: 1, status: "error" }, { data: [candidate(), candidate()], total_count: 2 },
  ]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json(payload); };
    await assert.rejects(resolveScrydexPrice(product, { fetch: fetcher }), ScrydexError);
    assert.equal(calls, 1);
  }
});

test("upstream errors and bodies never leak request credentials or retry", async (t) => {
  config(t);
  for (const mode of ["throw", "http", "json"]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (mode === "throw") throw new Error("test-only-key test-only-team");
      return new Response("test-only-key test-only-team", { status: mode === "http" ? 401 : 200 });
    };
    await assert.rejects(resolveScrydexPrice(product, { fetch: fetcher }), (error: unknown) => {
      assert.ok(error instanceof ScrydexError);
      assert.equal(error.code, "upstream_error");
      assert.equal(error.message.includes("test-only"), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
