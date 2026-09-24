import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Kha'Zix, Voidreaver (Overnumbered)", game: "Riftbound", setName: "Unleashed",
  cardNumber: "236/219", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 684507,
};

function candidate() {
  // Sanitized identity and NM quote from the live UNL-236 response. Scrydex
  // stores this Legend's champion in subtypes and its title in name.
  return {
    id: "UNL-236", name: "Voidreaver", number: "236", printed_number: "236/219",
    type: "Legend", subtypes: ["Kha'Zix"], rarity: "Showcase",
    language: "English", language_code: "EN",
    expansion: { id: "UNL", name: "Unleashed", code: "UNL", printed_total: 219, language: "English", language_code: "EN" },
    variants: [{ name: "foil", marketplaces: [{ name: "tcgplayer", product_id: "684507" }],
      prices: [{ type: "raw", condition: "NM", market: 112.45, currency: "USD", source_currency: "USD" }] }],
  };
}

function signature() {
  // The live signature sibling has a different collector suffix, marketplace
  // ID, and quote despite sharing its title, champion and Showcase rarity.
  const entry = candidate();
  return {
    ...entry, id: "UNL-236s", number: "236*", printed_number: "236*/219",
    variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "684210" }],
      prices: [{ ...entry.variants[0].prices[0], market: 395.47 }] }],
  };
}

function errorCode(code: ScrydexErrorCode) {
  return (error: unknown) => error instanceof ScrydexError && error.code === code;
}

function config(t: TestContext) {
  const key = process.env.SCRYDEX_API_KEY, team = process.env.SCRYDEX_TEAM_ID;
  process.env.SCRYDEX_API_KEY = "test-only-legends-key";
  process.env.SCRYDEX_TEAM_ID = "test-only-legends-team";
  t.after(() => {
    if (key === undefined) delete process.env.SCRYDEX_API_KEY;
    else process.env.SCRYDEX_API_KEY = key;
    if (team === undefined) delete process.env.SCRYDEX_TEAM_ID;
    else process.env.SCRYDEX_TEAM_ID = team;
  });
}

test("Kha'Zix Overnumbered resolves the verified Legend printing in one bounded request", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async (input, options) => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/riftbound/v1/cards");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.equal(url.searchParams.get("include"), "prices");
    assert.ok(query.includes('(number:"236") AND (expansion.name:"Unleashed" OR expansion.code:"Unleashed" OR expansion.id:"Unleashed") AND language_code:EN'));
    assert.ok(query.includes('variants.marketplaces.product_id:"684507"'));
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json({ data: [signature(), candidate()], total_count: 2 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "UNL-236");
  assert.equal(result.cents, 11245);
  assert.equal(result.matchedName, "Voidreaver");
  assert.equal(result.groupName, "Unleashed");
  assert.equal(result.variation, "foil / NM");
});

test("Legend composition preserves champion, title, game, type and subtype identity", () => {
  const entry = candidate();
  for (const patch of [
    { name: "Different Title" }, { type: "Unit" }, { type: undefined },
    { subtypes: ["Rengar"] }, { subtypes: [] }, { subtypes: [""] },
    { subtypes: ["Kha'Zix", "Kha'Zix"] }, { subtypes: ["Kha'Zix", "Assassin"] },
    { subtypes: ["Kha'Zix", ""] }, { subtypes: "Kha'Zix" }, { subtypes: [42] },
    { subtypes: undefined }, { language_code: "JA" }, { language: "Japanese" },
    { expansion: { ...entry.expansion, language_code: "JA" } },
    { expansion: { ...entry.expansion, name: "Origins", id: "OGN", code: "OGN" } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
  for (const patch of [
    { name: "Rengar, Voidreaver (Overnumbered)" }, { name: "Kha'Zix, Different Title (Overnumbered)" },
    { game: "Pokémon" }, { game: "Gundam" }, { game: "One Piece" },
    { productType: "Sealed", condition: "Sealed" },
  ]) assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("not_found"));
});

test("Overnumbered requires Showcase and a consistent full numeric collector above the set total", () => {
  const entry = candidate();
  for (const patch of [
    { rarity: "Rare" }, { rarity: "Epic" }, { rarity: undefined },
    { number: "236*", printed_number: "236*/219" }, { number: "236a", printed_number: "236a/219" },
    { number: "235" }, { printed_number: "236/220" }, { printed_number: "236*/219" },
    { printed_number: undefined }, { printed_number: "236" },
    { expansion: { ...entry.expansion, printed_total: 220 } },
    { expansion: { ...entry.expansion, printed_total: undefined } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
  for (const cardNumber of ["236*/219", "236a/219", "236/220", "236", "236/0"]) {
    assert.throws(() => selectScrydexPrice({ ...product, cardNumber }, [entry]), errorCode("not_found"));
  }
  for (const numerator of ["219", "218"]) {
    const cardNumber = `${numerator}/219`;
    assert.throws(() => selectScrydexPrice({ ...product, cardNumber }, [{ ...entry, number: numerator, printed_number: cardNumber }]), errorCode("not_found"));
  }
  assert.equal(selectScrydexPrice({ ...product, cardNumber: "0236/0219" }, [entry]).cents, 11245);
});

test("Overnumbered cannot select the signature or a regular printing", () => {
  const entry = candidate();
  // Synthetic regular printing is deliberately a cheaper distractor.
  const regular = { ...entry, id: "UNL-218", number: "218", printed_number: "218/219", rarity: "Rare",
    variants: [{ ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "999999" }],
      prices: [{ ...entry.variants[0].prices[0], market: 1.23 }] }] };
  assert.equal(selectScrydexPrice(product, [regular, signature(), entry]).cents, 11245);
  assert.throws(() => selectScrydexPrice(product, [regular, signature()]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: 684210 }, [signature(), entry]), errorCode("not_found"));
  for (const name of [
    "Kha'Zix, Voidreaver (Signature)", "Kha'Zix, Voidreaver (Promo)",
    "Kha'Zix, Voidreaver (Metal) (Prize Wall)", "Kha'Zix, Voidreaver (Overnumbered) (Promo)",
    "Kha'Zix, Voidreaver (Promo) (Overnumbered)",
  ]) assert.throws(() => selectScrydexPrice({ ...product, name }, [signature(), entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
});

test("Legend aliases require exact marketplace proof on the selected finish", () => {
  const entry = candidate(), foil = entry.variants[0];
  for (const tcgplayerId of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 684210]) {
    assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId }, [entry]), errorCode("not_found"));
  }
  for (const marketplaces of [[], [{ name: "tcgplayer", product_id: "684210" }], [{ name: "other", product_id: "684507" }]]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...foil, marketplaces }] }]), errorCode("not_found"));
  }
  const wrongFinish = { ...entry, variants: [
    { ...foil, marketplaces: [{ name: "tcgplayer", product_id: "684210" }] },
    { ...foil, name: "normal" },
  ] };
  assert.throws(() => selectScrydexPrice(product, [wrongFinish]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, finish: "Normal" }, [entry]), errorCode("price_unavailable"));
  assert.throws(() => selectScrydexPrice({ ...product, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
  for (const patch of [{ market: 0 }, { market: -1 }, { currency: "JPY" }, { type: "graded" }, { is_signed: true }]) {
    const variants = [{ ...foil, prices: [{ ...foil.prices[0], ...patch }] }];
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants }]), errorCode("price_unavailable"));
  }
});

test("Legend composition and Overnumbered annotation work independently with marketplace proof", () => {
  const entry = candidate();
  const composed: ScrydexProduct = { ...product, name: "Kha'Zix, Voidreaver" };
  assert.equal(selectScrydexPrice(composed, [entry]).cents, 11245);
  assert.throws(() => selectScrydexPrice({ ...composed, tcgplayerId: undefined }, [entry]), errorCode("not_found"));
  const otherFinish = { ...entry, variants: [
    { ...entry.variants[0], marketplaces: [] },
    { ...entry.variants[0], name: "normal" },
  ] };
  assert.throws(() => selectScrydexPrice(composed, [otherFinish]), errorCode("price_unavailable"));

  const fullName = { ...entry, name: "Kha'Zix, Voidreaver", type: "Unit", subtypes: [] };
  assert.equal(selectScrydexPrice(product, [fullName]).cents, 11245);
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: undefined }, [fullName]), errorCode("not_found"));
  const seal = { ...entry, name: "Seal Of Discord", type: "Spell", subtypes: [] };
  assert.equal(selectScrydexPrice({ ...product, name: "Seal of Discord (Overnumbered)" }, [seal]).cents, 11245);
});

test("ordinary literal Riftbound names keep their existing matching behavior", () => {
  const entry = candidate();
  // A product already stored under the provider's literal name needs no alias.
  const literal = { ...product, name: "Voidreaver", tcgplayerId: undefined };
  assert.equal(selectScrydexPrice(literal, [{ ...entry, variants: [{ ...entry.variants[0], marketplaces: [] }] }]).cents, 11245);
  assert.throws(() => selectScrydexPrice(literal, [{ ...entry, name: "Voidreaver (Overnumbered)" }]), errorCode("not_found"));
});
