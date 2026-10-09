import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveScrydexPrice, ScrydexError, selectScrydexPrice, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const plasmaStorm: ScrydexProduct = {
  name: "Giratina (Team Plasma)", game: "Pokémon", setName: "Plasma Storm", cardNumber: "62/135",
  productType: "Single", condition: "Near Mint", finish: "Normal", tcgplayerId: 85738,
};
const promo: ScrydexProduct = {
  ...plasmaStorm, setName: "BW Black Star Promos", cardNumber: "BW74", finish: "Foil", tcgplayerId: 85739,
};

function stormCandidate() {
  // Sanitized live Scrydex bw8-62 identity and NM quotes verified 2026-10-08.
  return {
    id: "bw8-62", name: "Giratina", number: "62", printed_number: "62/135", subtypes: ["Basic", "Team Plasma"],
    rarity: "Rare", rarity_code: "R", language: "English", language_code: "EN",
    expansion: {
      id: "bw8", name: "Plasma Storm", series: "Black & White", code: "PLS", printed_total: 135,
      language: "English", language_code: "EN",
    },
    variants: [
      { name: "normal", marketplaces: [{ name: "tcgplayer", product_id: "85738" }],
        prices: [{ type: "raw", condition: "NM", currency: "USD", market: 6.25 }] },
      { name: "reverseHolofoil", marketplaces: [{ name: "tcgplayer", product_id: "85738" }],
        prices: [{ type: "raw", condition: "NM", currency: "USD", market: 37.26 }] },
      { name: "crackedIceHolofoil", marketplaces: [{ name: "tcgplayer", product_id: "91388" }],
        prices: [{ type: "raw", condition: "NM", currency: "USD", market: 16.22 }] },
    ],
  };
}
function promoCandidate() {
  // Sanitized live Scrydex bwp-BW74 identity and NM quote verified 2026-10-08.
  return {
    id: "bwp-BW74", name: "Giratina", number: "BW74", printed_number: "BW74", subtypes: ["Basic", "Team Plasma"],
    rarity: "Promo", rarity_code: "PROMO", language: "English", language_code: "EN",
    expansion: {
      id: "bwp", name: "BW Black Star Promos", series: "Black & White", code: "PR-BLW", printed_total: 101,
      language: "English", language_code: "EN",
    },
    variants: [{ name: "holofoil", marketplaces: [{ name: "tcgplayer", product_id: "85739" }],
      prices: [{ type: "raw", condition: "NM", currency: "USD", market: 331.31 }] }],
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

test("Team Plasma Giratina resolves its exact Plasma Storm and BW74 printings", () => {
  const candidates = [stormCandidate(), promoCandidate()];
  const normal = selectScrydexPrice(plasmaStorm, candidates);
  assert.equal(normal.scrydexId, "bw8-62");
  assert.equal(normal.cents, 625);
  assert.equal(normal.variation, "normal / NM");
  const reverse = selectScrydexPrice({ ...plasmaStorm, finish: "Reverse Holofoil" }, candidates);
  assert.equal(reverse.cents, 3726);
  assert.equal(reverse.variation, "reverseHolofoil / NM");
  const foil = selectScrydexPrice(promo, candidates);
  assert.equal(foil.scrydexId, "bwp-BW74");
  assert.equal(foil.cents, 33131);
  assert.equal(foil.variation, "holofoil / NM");
});

test("Team Plasma and verified collector annotations can appear in either order", () => {
  for (const [product, entry, cents] of [[plasmaStorm, stormCandidate(), 625], [promo, promoCandidate(), 33131]] as const) {
    for (const name of [
      `Giratina (Team Plasma) - ${product.cardNumber}`, `Giratina - ${product.cardNumber} (Team Plasma)`,
      `Giratina (Team Plasma) (${product.cardNumber})`, `Giratina (${product.cardNumber}) (Team Plasma)`,
    ]) assert.equal(selectScrydexPrice({ ...product, name }, [entry]).cents, cents, name);
  }
});

test("Team Plasma subtype and marketplace proof are mandatory even for exact annotated names", () => {
  for (const [product, entry] of [[plasmaStorm, stormCandidate()], [promo, promoCandidate()]] as const) {
    for (const name of [entry.name, product.name]) {
      for (const subtypes of [undefined, null, [], ["Basic"], ["Team Rocket"], ["Team Plasma EX"], "Team Plasma", [42]]) {
        assert.throws(() => selectScrydexPrice(product, [{ ...entry, name, subtypes }]), errorCode("not_found"));
      }
      for (const tcgplayerId of [undefined, null, 0, -1, 1.5, 999999]) {
        assert.throws(() => selectScrydexPrice({ ...product, tcgplayerId }, [{ ...entry, name }]), errorCode("not_found"));
      }
      const noId = { ...entry, name, variants: entry.variants.map(variant => ({ ...variant, marketplaces: [] })) };
      assert.throws(() => selectScrydexPrice(product, [noId]), errorCode("not_found"));
    }
  }
});

test("Team Plasma matching retains name, set, collector number and language identity", () => {
  const entry = stormCandidate();
  for (const patch of [
    { name: "Giratina (Team Rocket)" }, { name: "Giratina (Team Plasma) (First Edition)" },
    { name: "Giratina (Team Plasma) - 63/135" }, { name: "Giratina - 62/136 (Team Plasma)" },
    { name: "Giratina (Team Plasma) (Promo)" }, { name: "Different Pokémon (Team Plasma)" },
    { setName: "BW Black Star Promos" }, { cardNumber: "63/135" }, { cardNumber: "62/136" },
    { tcgplayerId: 85739 }, { game: "Riftbound" },
  ]) assert.throws(() => selectScrydexPrice({ ...plasmaStorm, ...patch }, [entry]), errorCode("not_found"));
  for (const patch of [
    { name: "Different Pokémon" }, { number: "63", printed_number: "63/135" }, { printed_number: "62/136" },
    { language_code: "JA" }, { language: "Japanese" }, { is_online_only: true },
    { expansion: { ...entry.expansion, name: "Different Set" } },
    { expansion: { ...entry.expansion, language_code: "JA" } },
    { expansion: { ...entry.expansion, is_foreign_only: true } },
  ]) assert.throws(() => selectScrydexPrice(plasmaStorm, [{ ...entry, ...patch }]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(promo, [entry]), errorCode("not_found"));
  assert.throws(() => selectScrydexPrice(plasmaStorm, [promoCandidate()]), errorCode("not_found"));
});

test("Team Plasma pricing requires the selected finish's exact ID and a matching USD condition quote", () => {
  const entry = stormCandidate();
  // The annotated exact name must not let an ID on reverse foil verify Normal.
  const wrongFinishId = { ...entry, name: plasmaStorm.name, variants: [
    { ...entry.variants[0], marketplaces: [] }, entry.variants[1],
  ] };
  assert.throws(() => selectScrydexPrice(plasmaStorm, [wrongFinishId]), errorCode("price_unavailable"));
  const wrongProductId = { ...entry, name: plasmaStorm.name, variants: [
    { ...entry.variants[0], marketplaces: [{ name: "tcgplayer", product_id: "91388" }] }, entry.variants[1],
  ] };
  assert.throws(() => selectScrydexPrice(plasmaStorm, [wrongProductId]), errorCode("price_unavailable"));
  for (const patch of [{ finish: "Foil" }, { finish: "Cracked Ice Holofoil" }, { condition: "Lightly Played" }]) {
    assert.throws(() => selectScrydexPrice({ ...plasmaStorm, ...patch }, [entry]), errorCode("price_unavailable"));
  }
  for (const quote of [
    { ...entry.variants[0].prices[0], currency: "JPY" },
    { ...entry.variants[0].prices[0], condition: "LP" },
    { ...entry.variants[0].prices[0], type: "graded" },
    { ...entry.variants[0].prices[0], market: 0 },
    { ...entry.variants[0].prices[0], is_signed: true },
  ]) {
    const badQuote = { ...entry, variants: [{ ...entry.variants[0], prices: [quote] }] };
    assert.throws(() => selectScrydexPrice(plasmaStorm, [badQuote]), errorCode("price_unavailable"));
  }
  const noQuote = { ...entry, variants: [{ ...entry.variants[0], prices: [] }] };
  assert.throws(() => selectScrydexPrice(plasmaStorm, [noQuote]), errorCode("price_unavailable"));
});

test("Team Plasma lookup retrieves the base name in one bounded collector and language request", async t => {
  config(t);
  for (const [product, entry, number, cents] of [
    [plasmaStorm, stormCandidate(), "62", 625], [promo, promoCandidate(), "BW74", 33131],
  ] as const) {
    let calls = 0;
    const result = await resolveScrydexPrice(product, { fetch: async input => {
      calls++;
      const url = new URL(String(input)), query = url.searchParams.get("q")!;
      assert.equal(url.origin + url.pathname, "https://api.scrydex.com/pokemon/v1/cards");
      assert.ok(query.includes('!name:"Giratina"'));
      assert.ok(query.includes(`number:"${number}"`));
      assert.ok(query.includes("AND language_code:EN"));
      assert.ok(query.includes(`variants.marketplaces.product_id:"${product.tcgplayerId}"`));
      assert.equal(url.searchParams.get("page"), "1");
      assert.equal(url.searchParams.get("page_size"), "100");
      assert.equal(url.searchParams.get("include"), "prices");
      return Response.json({ data: [entry], total_count: 1 });
    } });
    assert.equal(calls, 1);
    assert.equal(result.cents, cents);
  }
});

test("Team Plasma lookup without a marketplace ID never retrieves the unverified base name or retries", async t => {
  config(t);
  for (const tcgplayerId of [undefined, 85738]) {
    let calls = 0;
    await assert.rejects(resolveScrydexPrice({ ...plasmaStorm, tcgplayerId }, { fetch: async input => {
      calls++;
      const query = new URL(String(input)).searchParams.get("q")!;
      assert.equal(query.includes('!name:"Giratina"'), Boolean(tcgplayerId));
      return Response.json({ data: [], total_count: 0 });
    } }), errorCode("not_found"));
    assert.equal(calls, 1);
  }
});

test("Team Plasma lookup rejects duplicate cards, variants and condition quotes", () => {
  const entry = stormCandidate(), normal = entry.variants[0];
  assert.throws(() => selectScrydexPrice(plasmaStorm, [entry, entry]), errorCode("ambiguous"));
  assert.throws(() => selectScrydexPrice(plasmaStorm, [{ ...entry, variants: [normal, normal] }]), errorCode("ambiguous"));
  const duplicateQuote = { ...entry, variants: [{ ...normal, prices: [normal.prices[0], normal.prices[0]] }] };
  assert.throws(() => selectScrydexPrice(plasmaStorm, [duplicateQuote]), errorCode("ambiguous"));
});
