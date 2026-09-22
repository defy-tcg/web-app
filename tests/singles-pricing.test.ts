import assert from "node:assert/strict";
import test from "node:test";
import { scrydexSellPriceCents } from "../lib/pricing-policy.ts";
import { previewSingles } from "../lib/singles/intake.ts";
import { previewPricedSingles, validateSinglesPricing, type SinglesPriceResolver } from "../lib/singles/pricing.ts";
import type { Catalog, SinglesIntakeRow } from "../lib/singles/types.ts";

const catalog: Catalog = { fetchedAt: "2026-09-18", sourceUpdatedAt: "2026-09-18", warnings: [], cards: [
  { key: "101:Normal", productId: 101, groupId: 7, name: "Test Card", setName: "Origins", setCode: "OGN", number: "001", rarity: "Rare", finish: "Normal", language: "English", imageUrl: "", productUrl: "https://www.tcgplayer.com/product/101", marketCents: 99999 },
  { key: "101:Foil", productId: 101, groupId: 7, name: "Test Card", setName: "Origins", setCode: "OGN", number: "001", rarity: "Rare", finish: "Foil", language: "English", imageUrl: "", productUrl: "https://www.tcgplayer.com/product/101", marketCents: 99999 },
] };
const row: SinglesIntakeRow = { cardKey: "101:Normal", condition: "Near Mint", quantity: 3, costCents: 100, priceCents: 1 };
const quote = (cents: number) => ({ cents, scrydexId: "ogn-001", variation: "normal-NM", url: "https://scrydex.com/" });

test("Scrydex selling prices add 6% and round to the nearest cent", () => {
  const product = { game: "Riftbound", productType: "Single" };
  assert.equal(scrydexSellPriceCents(1000, product), 1060);
  assert.equal(scrydexSellPriceCents(105, product), 111);
  assert.equal(scrydexSellPriceCents(104, product), 110);
  assert.equal(scrydexSellPriceCents(29, product), 31);
});

test("single review uses the exact catalog identity and selected finish/condition, replacing client and catalog prices", async () => {
  const inputs: Parameters<SinglesPriceResolver>[0][] = [];
  const reviewed = await previewPricedSingles([row, { ...row, cardKey: "101:Foil", condition: "Lightly Played", quantity: 2 }], catalog, async (input) => {
    inputs.push(input);
    return quote(input.finish === "Foil" ? 105 : 1000);
  });
  assert.deepEqual(inputs.map(({ finish, condition }) => ({ finish, condition })), [
    { finish: "Normal", condition: "Near Mint" }, { finish: "Foil", condition: "Lightly Played" },
  ]);
  assert.equal(inputs[0].tcgplayerId, 101);
  assert.equal(inputs[0].tcgplayerUrl, catalog.cards[0].productUrl);
  assert.equal(inputs[0].cardNumber, "001");
  assert.equal(inputs[0].game, "Riftbound");
  assert.equal(inputs[0].productType, "Single");
  assert.deepEqual(reviewed.rows.map((item) => item.priceCents), [1060, 111]);
  assert.deepEqual(reviewed.rows.map((item) => item.pricing.marketCents), [1000, 105]);
  assert.equal(reviewed.rows[0].pricing.source, "scrydex");
  assert.equal(reviewed.totalPriceCents, 3402);
  assert.equal(reviewed.totalCostCents, 500);
  assert.equal(row.priceCents, 1, "preview must not mutate the submitted request");
});

test("missing, invalid or unavailable Scrydex prices block single review without fallback", async () => {
  const maximum = await previewPricedSingles([row], catalog, async () => quote(94_339_623));
  assert.equal(maximum.rows[0].priceCents, 100_000_000);
  for (const result of [null, quote(0), quote(-100), quote(NaN), quote(1.1), quote(94_339_624), quote(100_000_001)]) {
    await assert.rejects(previewPricedSingles([row], catalog, async () => result), { code: "SCRYDEX_PRICE_UNAVAILABLE" });
  }
  await assert.rejects(previewPricedSingles([row], catalog, async () => { throw new Error("private upstream details"); }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private upstream details/);
    assert.match(error.message, /Test Card.*Normal.*Near Mint/);
    return true;
  });
});

test("new receipt rejects altered or changed prices and accepts a current reviewed price", async () => {
  const resolver: SinglesPriceResolver = async () => quote(1000);
  await assert.rejects(validateSinglesPricing(previewSingles([row], catalog), resolver), { code: "PRICE_CHANGED" });
  const reviewed = await previewPricedSingles([row], catalog, resolver);
  await validateSinglesPricing(reviewed, resolver);
  await assert.rejects(validateSinglesPricing(reviewed, async () => quote(2000)), { code: "PRICE_CHANGED" });
});

test("price review bounds requests and limits concurrent Scrydex work", async () => {
  const cards = Array.from({ length: 11 }, (_, index) => ({ ...catalog.cards[0], key: `${index + 1}:Normal`, productId: index + 1 }));
  const batch = cards.map((card) => ({ ...row, cardKey: card.key }));
  const largeCatalog = { ...catalog, cards };
  let active = 0, maximum = 0, calls = 0;
  const resolver: SinglesPriceResolver = async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    active--;
    return quote(1000);
  };
  await assert.rejects(previewPricedSingles(batch, largeCatalog, resolver), { code: "PRICING_BATCH_TOO_LARGE" });
  assert.equal(calls, 0);
  const reviewed = await previewPricedSingles(batch.slice(0, 10), largeCatalog, resolver);
  assert.equal(reviewed.rows.length, 10);
  assert.equal(calls, 10);
  assert.equal(maximum, 4);
  assert.deepEqual(reviewed.rows.map((item) => item.cardKey), batch.slice(0, 10).map((item) => item.cardKey));
});
