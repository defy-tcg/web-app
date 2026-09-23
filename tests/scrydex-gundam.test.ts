import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const product: ScrydexProduct = {
  name: "Amuro Ray (R+)", game: "Gundam", setName: "Freedom Ascension", cardNumber: "GD05-085",
  productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 707579,
};
function price(market: number) {
  return { type: "raw", condition: "NM", market, currency: "USD", source_currency: "USD" };
}
function candidate() {
  // Sanitized identity and NM prices from the live GD05-085 Scrydex response.
  return {
    id: "GD05-085", name: "Amuro Ray", number: "85", printed_number: "GD05-085", rarity_code: "R",
    language: "English", language_code: "EN", printings: ["GD05"],
    expansion: { id: "GD05", name: "Freedom Ascension", code: "GD05", language: "English", language_code: "EN" },
    variants: [
      { name: "holofoil", printings: ["GD05"], marketplaces: [{ name: "tcgplayer", product_id: "705621" }], prices: [price(0.92)] },
      { name: "altArt", printings: ["GD05"], marketplaces: [{ name: "tcgplayer", product_id: "707579" }], prices: [price(65.21)],
        images: [{ type: "front", medium: "https://images.scrydex.com/gundam/GD05-085A/medium" }] },
    ],
  };
}
function otherAmuro() {
  // Same character, different card, with a later premium reprint: never a fallback.
  return {
    id: "ST01-010", name: "Amuro Ray", number: "10", printed_number: "ST01-010", rarity_code: "C",
    language: "English", language_code: "EN", printings: ["ST01", "GD05"],
    expansion: { id: "ST01", name: "Heroic Beginnings", code: "ST01", language: "English", language_code: "EN" },
    variants: [
      { name: "normal", printings: ["ST01"], marketplaces: [{ name: "tcgplayer", product_id: "641445" }], prices: [price(1.26)] },
      { name: "altArt", printings: ["ST01"], marketplaces: [{ name: "tcgplayer", product_id: "641461" }], prices: [price(40.05)] },
      { name: "beta", printings: ["ST01"], marketplaces: [{ name: "tcgplayer", product_id: "616603" }], prices: [price(5.45)] },
      { name: "premiumAltArt", printings: ["GD05"], marketplaces: [{ name: "tcgplayer", product_id: "707597" }], prices: [price(160.5)] },
    ],
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

test("Gundam Amuro R+ resolves its exact alternate variant with one bounded base-name request", async t => {
  config(t);
  let calls = 0;
  const result = await resolveScrydexPrice(product, { fetch: async input => {
    calls++;
    const url = new URL(String(input)), query = url.searchParams.get("q")!;
    assert.equal(url.origin, "https://api.scrydex.com");
    assert.equal(url.pathname, "/gundam/v1/cards");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "100");
    assert.ok(query.includes('!name:"Amuro Ray"'));
    assert.ok(query.includes('variants.marketplaces.product_id:"707579"'));
    return Response.json({ data: [otherAmuro(), candidate()], total_count: 2 });
  } });
  assert.equal(calls, 1);
  assert.equal(result.scrydexId, "GD05-085");
  assert.equal(result.cents, 6521);
  assert.equal(result.variation, "altArt / NM");
  assert.equal(result.imageUrl, "https://images.scrydex.com/gundam/GD05-085A/medium");
});

test("Gundam recognized C+, U+, R+, LR+ labels verify the same base rarity and alternate variant", () => {
  for (const rarity of ["C", "U", "R", "LR"]) {
    // Synthetic rarities check the rule without another upstream request or whitelist.
    const entry = { ...candidate(), rarity_code: rarity };
    const saved = { ...product, name: `Amuro Ray (${rarity}+)` };
    assert.equal(selectScrydexPrice(saved, [entry]).cents, 6521, rarity);
    assert.throws(() => selectScrydexPrice(saved, [{ ...entry, rarity_code: rarity === "C" ? "R" : "C" }]), errorCode("not_found"));
  }
});

test("Gundam unit names retain their literal Gundam word while explicit game prefixes remain supported", async t => {
  config(t);
  for (const [name, baseName, rarity] of [
    ["Gundam (R+)", "Gundam", "R"],
    ["Gundam Aerial (LR+)", "Gundam Aerial", "LR"],
    ["Gundam: Gundam Aerial (LR+)", "Gundam Aerial", "LR"],
  ]) {
    const saved = { ...product, name };
    const entry = { ...candidate(), name: baseName, rarity_code: rarity };
    let calls = 0;
    const result = await resolveScrydexPrice(saved, { fetch: async input => {
      calls++;
      const query = new URL(String(input)).searchParams.get("q")!;
      assert.ok(query.includes(`!name:"${baseName}"`), name);
      assert.equal(query.includes('!name:"Aerial"'), false);
      return Response.json({ data: [entry], total_count: 1 });
    } });
    assert.equal(calls, 1);
    assert.equal(result.matchedName, baseName);
    assert.equal(result.cents, 6521);
  }
});

test("Gundam regular rarity labels price only the exact standard variant", () => {
  for (const rarity of ["C", "U", "R", "LR"]) {
    const saved = { ...product, name: `Amuro Ray (${rarity})`, tcgplayerId: 705621 };
    const entry = { ...candidate(), rarity_code: rarity };
    assert.equal(selectScrydexPrice(saved, [entry]).cents, 92);
    assert.equal(selectScrydexPrice(saved, [entry]).variation, "holofoil / NM");
    assert.throws(() => selectScrydexPrice({ ...saved, tcgplayerId: 707579 }, [entry]), errorCode("price_unavailable"));
  }
  // A bare name does not authorize a Foil -> altArt finish substitution either.
  assert.throws(() => selectScrydexPrice({ ...product, name: "Amuro Ray" }, [candidate()]), errorCode("price_unavailable"));
});

test("Gundam plus rarity never falls back to regular foil, beta, or premium alternate artwork", () => {
  const entry = candidate(), alternate = entry.variants[1];
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: 705621 }, [entry]), errorCode("price_unavailable"));
  for (const name of ["holofoil", "normal", "beta", "premiumAltArt"]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...alternate, name }] }]), errorCode("price_unavailable"), name);
  }
  // A premium GD05 reprint of ST01-010 is still a different numbered card.
  assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId: 707597 }, [otherAmuro()]), errorCode("not_found"));
});

test("Gundam rarity aliases retain exact card, set, number, marketplace, and language requirements", () => {
  const entry = candidate();
  for (const patch of [
    { name: "Amuro Ray (C+)" }, { setName: "Heroic Beginnings" }, { cardNumber: "ST01-010" },
    { cardNumber: "GD05-086" }, { tcgplayerId: 999999 }, { tcgplayerId: undefined },
  ]) assert.throws(() => selectScrydexPrice({ ...product, ...patch }, [entry]), errorCode("not_found"));
  for (const patch of [
    { name: "Another Pilot" }, { rarity_code: "U" }, { rarity_code: "" }, { printed_number: "GD05-086" },
    { language_code: "JA" }, { language: "Japanese" },
    { expansion: { ...entry.expansion, name: "Another Set" } },
    { expansion: { ...entry.expansion, language_code: "JA" } },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, ...patch }]), errorCode("not_found"));
});

test("Gundam alternate variant must have one verified printing in the card's own expansion", () => {
  const entry = candidate(), alternate = entry.variants[1];
  for (const printings of [undefined, [], ["ST01"], ["GD05", "ST01"], [""], [null]]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...alternate, printings }] }]), errorCode("price_unavailable"));
  }
  for (const expansion of [
    { ...entry.expansion, id: "ST01" }, { ...entry.expansion, code: "ST01" },
    { ...entry.expansion, id: "" }, { ...entry.expansion, code: "" },
    { ...entry.expansion, id: "ST01", code: "ST01" },
  ]) assert.throws(() => selectScrydexPrice(product, [{ ...entry, expansion }]), errorCode("price_unavailable"));
});

test("Gundam exact TCGplayer proof on a different finish cannot supply an alternate quote", () => {
  const entry = candidate();
  const variants = [
    { ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "707579" }] },
    { ...entry.variants[1], marketplaces: [{ name: "tcgplayer", product_id: "705621" }] },
  ];
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants }]), errorCode("price_unavailable"));
  for (const finish of ["Normal", "Reverse Holo", "Beta", "Premium Alt Art", "First Edition Holofoil"]) {
    assert.throws(() => selectScrydexPrice({ ...product, finish }, [entry]), errorCode("price_unavailable"));
  }
  assert.throws(() => selectScrydexPrice({ ...product, condition: "Lightly Played" }, [entry]), errorCode("price_unavailable"));
  for (const quote of [price(0), { ...price(65.21), currency: "JPY" }]) {
    assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [{ ...entry.variants[1], prices: [quote] }] }]), errorCode("price_unavailable"));
  }
});

test("duplicate Gundam card or exact alternate-variant matches remain ambiguous", () => {
  const entry = candidate();
  assert.throws(() => selectScrydexPrice(product, [entry, entry]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(product, [{ ...entry, variants: [entry.variants[1], entry.variants[1]] }]), errorCode("ambiguous"));
});

test("unknown Gundam name annotations and rarity annotations for other games remain strict", () => {
  for (const annotation of ["Promo", "First Edition", "Champion", "SR+", "SSR", "R++", "Rare+", "Beta"]) {
    assert.throws(() => selectScrydexPrice({ ...product, name: `Amuro Ray (${annotation})` }, [candidate()]), errorCode("not_found"));
  }
  for (const game of ["Riftbound", "Pokémon", "One Piece"]) {
    assert.throws(() => selectScrydexPrice({ ...product, game }, [candidate()]), errorCode("not_found"));
  }
});

test("Gundam rarity alias queries require a marketplace ID and failed matches make no extra requests", async t => {
  config(t);
  for (const tcgplayerId of [undefined, 707579]) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice({ ...product, tcgplayerId }, { fetch: async input => {
      calls++;
      const query = new URL(String(input)).searchParams.get("q")!;
      if (!tcgplayerId) {
        assert.equal(query.includes('!name:"Amuro Ray"'), false);
        assert.equal(query.includes("variants.marketplaces.product_id"), false);
      }
      return Response.json({ data: [], total_count: 0 });
    } }), errorCode("not_found"));
    assert.equal(calls, 1);
  }
});
