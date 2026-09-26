import test from "node:test";
import assert from "node:assert/strict";
import { isRiftboundSinglePricingProduct, preserveScrydexPricing, samePricingIdentity, scrydexSellPriceCents } from "../lib/pricing-policy.ts";
import { TCG_GAME_REGISTRY } from "../lib/tcg-games.ts";

const riftboundSingle = { game: "Riftbound", productType: "Single" };

test("Riftbound single sell prices use a 6.5% markup with nearest-cent rounding", () => {
  assert.equal(scrydexSellPriceCents(1000, riftboundSingle), 1065);
  assert.equal(scrydexSellPriceCents(999, riftboundSingle), 1064);
  assert.equal(scrydexSellPriceCents(100, riftboundSingle), 107);
  assert.equal(scrydexSellPriceCents(300, riftboundSingle), 320);
  assert.equal(scrydexSellPriceCents(5, riftboundSingle), 5);
  assert.equal(scrydexSellPriceCents(1, riftboundSingle), 1);
  assert.equal(scrydexSellPriceCents(25, riftboundSingle), 27);
  assert.equal(scrydexSellPriceCents(100_000_000, riftboundSingle), 106_500_000);
});

test("English and Japanese Pokémon singles add 1.5% to raw market with half-up cent rounding", () => {
  for (const game of ["Pokémon", "Pokémon (Japanese)"]) {
    for (const [market, expected] of [[1000, 1015], [999, 1014], [100, 102], [300, 305], [33, 33], [34, 35], [1, 1], [100_000_000, 101_500_000]]) {
      assert.equal(scrydexSellPriceCents(market, { game, productType: "Single" }), expected, `${game}/${market}`);
    }
  }
});

test("game aliases and single casing select the matching policy while other games and products stay at market", () => {
  for (const game of TCG_GAME_REGISTRY) {
    for (const alias of [game.key, game.name, ...game.aliases]) {
      for (const productType of ["Single", " single ", "\tSINGLE\n", "\u00a0Single\ufeff"]) {
        const product = { game: ` ${alias.toUpperCase()} `, productType };
        assert.equal(isRiftboundSinglePricingProduct(product), game.key === "riftbound", `${alias}/${productType}`);
        const expected = game.key === "riftbound" ? 1065 : game.key === "pokemon" || game.key === "pokemon-japanese" ? 1015 : 1000;
        assert.equal(scrydexSellPriceCents(1000, product), expected, `${alias}/${productType}`);
      }
      for (const productType of ["Sealed", " sealed ", "Accessory", "", "Singles"]) {
        const product = { game: alias, productType };
        assert.equal(isRiftboundSinglePricingProduct(product), false, `${alias}/${productType}`);
        assert.equal(scrydexSellPriceCents(1000, product), 1000, `${alias}/${productType}`);
      }
    }
  }
  assert.equal(scrydexSellPriceCents(1000, { game: "Ríftbound: League of Legends Trading Card Game", productType: "Single" }), 1065);
  for (const game of ["Unknown", "Riftbound-like", "Riftbound singles", "Pokémon-like", "Pokémon singles", ""]) {
    assert.equal(scrydexSellPriceCents(1000, { game, productType: "Single" }), 1000);
  }
});

test("missing, nonfinite, negative and fractional-cent market prices cannot become sale prices", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 100_000_001]) {
    for (const product of [riftboundSingle, { game: "Pokémon", productType: "Single" }, { game: "Riftbound", productType: "Sealed" }]) {
      assert.throws(() => scrydexSellPriceCents(value, product), /positive USD/);
    }
  }
});

test("spreadsheet or CSV prices cannot undo a verified Scrydex price or compound the markup", () => {
  const pricing = { marketPriceCents: 1000, listPriceCents: 1065, priceSource: "scrydex", priceUpdatedAt: "2026-09-18T00:00:00Z" };
  const current = { ...riftboundSingle, ...pricing, listPriceCents: 1100 };
  const incoming = { marketPriceCents: 700, listPriceCents: 700, priceSource: "master-sheet", priceUpdatedAt: "2026-09-19T00:00:00Z", quantity: 4 };
  assert.deepEqual(preserveScrydexPricing(current, incoming), { ...incoming, ...pricing });
  assert.deepEqual(preserveScrydexPricing(current, preserveScrydexPricing(current, incoming)), { ...incoming, ...pricing });
  assert.equal(preserveScrydexPricing({ ...current, priceSource: "manual" }, incoming), incoming);
});

test("preservation reapplies the stored game's rule without compounding or using an incoming identity", () => {
  for (const [identity, expected] of [
    [{ game: "Pokémon", productType: "Single" }, 1015],
    [{ game: "Pokémon (Japanese)", productType: "Single" }, 1015],
    [{ game: "One Piece", productType: "Single" }, 1000],
    [{ game: "Pokémon", productType: "Sealed" }, 1000],
    [{ game: "Riftbound", productType: "Sealed" }, 1000],
  ] as const) {
    const current = { ...identity, marketPriceCents: 1000, listPriceCents: 1100, priceSource: "scrydex", priceUpdatedAt: "2026-09-18T00:00:00Z" };
    const incoming = { ...riftboundSingle, marketPriceCents: 700, listPriceCents: 770, priceSource: "master-sheet", priceUpdatedAt: null };
    const preserved = preserveScrydexPricing(current, incoming);
    assert.equal(preserved.marketPriceCents, 1000);
    assert.equal(preserved.listPriceCents, expected);
    assert.equal(preserved.priceSource, "scrydex");
    assert.equal(preserved.priceUpdatedAt, current.priceUpdatedAt);
    assert.equal(preserveScrydexPricing({ ...current, ...preserved, ...identity }, preserved).listPriceCents, expected);
  }
});

test("managed quotes are tied to every exact card identity field", () => {
  const product = {
    name: "Ahri", game: "Riftbound", productType: "Single", setName: "Origins",
    cardNumber: "001", condition: "Near Mint", finish: "Foil", tcgplayerId: 123,
    quantity: 2, costCents: 100, location: "A1", tcgplayerUrl: "https://www.tcgplayer.com/product/123",
  };
  assert.equal(samePricingIdentity(product, { ...product }), true);
  for (const [key, value] of Object.entries({
    name: "Annie", game: "Pokémon", productType: "Sealed", setName: "Spiritforged",
    cardNumber: "002", condition: "Lightly Played", finish: "Normal", tcgplayerId: 456,
  })) {
    assert.equal(samePricingIdentity(product, { ...product, [key]: value }), false, key);
  }
  assert.equal(samePricingIdentity(product, { ...product, tcgplayerId: null }), false);
  assert.equal(samePricingIdentity(
    { ...product, tcgplayerId: null }, { ...product, tcgplayerId: null },
  ), true);
});

test("stock, cost, location and reference URL changes do not invalidate a quote", () => {
  const product = {
    name: "Ahri", game: "Riftbound", productType: "Single", setName: "Origins",
    cardNumber: "001", condition: "Near Mint", finish: "Foil", tcgplayerId: 123,
    quantity: 2, costCents: 100, location: "A1", tcgplayerUrl: "https://www.tcgplayer.com/product/123",
  };
  const updated = { ...product, quantity: 10, costCents: 200, location: "B2", tcgplayerUrl: "https://images.example/card.jpg" };
  assert.equal(samePricingIdentity(product, updated), true);
});
