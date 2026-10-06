import test from "node:test";
import assert from "node:assert/strict";
import { isRiftboundSinglePricingProduct, preserveScrydexPricing, samePricingIdentity, scrydexSellPriceCents } from "../lib/pricing-policy.ts";
import { TCG_GAME_REGISTRY } from "../lib/tcg-games.ts";

const riftboundSingle = { game: "Riftbound", productType: "Single" };

test("Riftbound singles from $2 through $10 use 11%, with 8% elsewhere below $40 and half-up rounding", () => {
  assert.equal(scrydexSellPriceCents(1000, riftboundSingle), 1110);
  assert.equal(scrydexSellPriceCents(999, riftboundSingle), 1109);
  assert.equal(scrydexSellPriceCents(100, riftboundSingle), 108);
  assert.equal(scrydexSellPriceCents(300, riftboundSingle), 333);
  assert.equal(scrydexSellPriceCents(250, riftboundSingle), 278);
  assert.equal(scrydexSellPriceCents(950, riftboundSingle), 1055);
  assert.equal(scrydexSellPriceCents(5, riftboundSingle), 5);
  assert.equal(scrydexSellPriceCents(1, riftboundSingle), 1);
  assert.equal(scrydexSellPriceCents(25, riftboundSingle), 27);
  assert.equal(scrydexSellPriceCents(100_000_000, riftboundSingle), 106_500_000);
});

test("Riftbound tiers use raw market cents with inclusive $2 and $10 boundaries and 6.5% at $40", () => {
  for (const [market, expected] of [[199, 215], [200, 222], [201, 223], [999, 1109], [1000, 1110], [1001, 1081], [3800, 4104], [3999, 4319], [4000, 4260], [4001, 4261], [5000, 5325]]) {
    assert.equal(scrydexSellPriceCents(market, riftboundSingle), expected, `market ${market}`);
  }
});

test("import preservation updates old Riftbound markup from raw market without compounding across any tier", () => {
  for (const [market, oldPrice, expected] of [[199, 215, 215], [200, 216, 222], [201, 217, 223], [950, 1026, 1055], [1000, 1080, 1110], [1001, 1081, 1081], [3800, 4047, 4104], [3999, 4259, 4319], [4000, 4260, 4260], [4001, 4261, 4261]]) {
    const current = { ...riftboundSingle, marketPriceCents: market, listPriceCents: oldPrice, priceSource: "scrydex", priceUpdatedAt: "2026-09-18T00:00:00Z" };
    const incoming = { marketPriceCents: 700, listPriceCents: 700, priceSource: "master-sheet", priceUpdatedAt: null };
    const preserved = preserveScrydexPricing(current, incoming);
    assert.equal(preserved.marketPriceCents, market);
    assert.equal(preserved.listPriceCents, expected);
    assert.equal(preserveScrydexPricing({ ...current, ...preserved }, incoming).listPriceCents, expected);
  }
});

test("English and Japanese Pokémon singles add 1.7% to raw market with half-up cent rounding", () => {
  for (const game of ["Pokémon", "Pokémon (Japanese)"]) {
    for (const [market, expected] of [[1000, 1017], [999, 1016], [100, 102], [300, 305], [499, 507], [500, 509], [501, 510], [29, 29], [30, 31], [33, 34], [34, 35], [1, 1], [100_000_000, 101_700_000]]) {
      assert.equal(scrydexSellPriceCents(market, { game, productType: "Single" }), expected, `${game}/${market}`);
    }
  }
});

test("Pokémon import preservation updates old retail prices from raw market without compounding", () => {
  for (const game of ["Pokémon", "Pokémon (Japanese)"]) {
    for (const [market, oldPrice, expected] of [[29, 29, 29], [30, 30, 31], [500, 508, 509], [1000, 1015, 1017], [4802, 4874, 4884]]) {
      const current = { game, productType: "Single", marketPriceCents: market, listPriceCents: oldPrice, priceSource: "scrydex", priceUpdatedAt: "2026-10-06T00:00:00Z" };
      const incoming = { marketPriceCents: 700, listPriceCents: 700, priceSource: "master-sheet", priceUpdatedAt: null };
      const preserved = preserveScrydexPricing(current, incoming);
      assert.equal(preserved.marketPriceCents, market);
      assert.equal(preserved.listPriceCents, expected, `${game}/${market}`);
      assert.deepEqual(preserveScrydexPricing({ ...current, ...preserved }, incoming), preserved);
    }
  }
});

test("game aliases and single casing select the matching policy while other games and products stay at market", () => {
  for (const game of TCG_GAME_REGISTRY) {
    for (const alias of [game.key, game.name, ...game.aliases]) {
      for (const productType of ["Single", " single ", "\tSINGLE\n", "\u00a0Single\ufeff"]) {
        const product = { game: ` ${alias.toUpperCase()} `, productType };
        assert.equal(isRiftboundSinglePricingProduct(product), game.key === "riftbound", `${alias}/${productType}`);
        const expected = game.key === "riftbound" ? 1110 : game.key === "pokemon" || game.key === "pokemon-japanese" ? 1017 : 1000;
        assert.equal(scrydexSellPriceCents(1000, product), expected, `${alias}/${productType}`);
      }
      for (const productType of ["Sealed", " sealed ", "Accessory", "", "Singles"]) {
        const product = { game: alias, productType };
        assert.equal(isRiftboundSinglePricingProduct(product), false, `${alias}/${productType}`);
        assert.equal(scrydexSellPriceCents(1000, product), 1000, `${alias}/${productType}`);
      }
    }
  }
  assert.equal(scrydexSellPriceCents(1000, { game: "Ríftbound: League of Legends Trading Card Game", productType: "Single" }), 1110);
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
  const pricing = { marketPriceCents: 1000, listPriceCents: 1110, priceSource: "scrydex", priceUpdatedAt: "2026-09-18T00:00:00Z" };
  const current = { ...riftboundSingle, ...pricing, listPriceCents: 1100 };
  const incoming = { marketPriceCents: 700, listPriceCents: 700, priceSource: "master-sheet", priceUpdatedAt: "2026-09-19T00:00:00Z", quantity: 4 };
  assert.deepEqual(preserveScrydexPricing(current, incoming), { ...incoming, ...pricing });
  assert.deepEqual(preserveScrydexPricing(current, preserveScrydexPricing(current, incoming)), { ...incoming, ...pricing });
  assert.equal(preserveScrydexPricing({ ...current, priceSource: "manual" }, incoming), incoming);
});

test("preservation reapplies the stored game's rule without compounding or using an incoming identity", () => {
  for (const [identity, expected] of [
    [{ game: "Pokémon", productType: "Single" }, 1017],
    [{ game: "Pokémon (Japanese)", productType: "Single" }, 1017],
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
