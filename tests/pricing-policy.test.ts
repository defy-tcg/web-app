import test from "node:test";
import assert from "node:assert/strict";
import { preserveScrydexPricing, samePricingIdentity, scrydexSellPriceCents } from "../lib/pricing-policy.ts";

test("Scrydex sell prices use a 10% markup with nearest-cent rounding", () => {
  assert.equal(scrydexSellPriceCents(1000), 1100);
  assert.equal(scrydexSellPriceCents(999), 1099);
  assert.equal(scrydexSellPriceCents(5), 6);
  assert.equal(scrydexSellPriceCents(1), 1);
  assert.equal(scrydexSellPriceCents(100_000_000), 110_000_000);
});

test("missing, nonfinite, negative and fractional-cent market prices cannot become sale prices", () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 100_000_001]) {
    assert.throws(() => scrydexSellPriceCents(value), /positive USD/);
  }
});

test("spreadsheet or CSV prices cannot undo a verified Scrydex price or compound the markup", () => {
  const current = { marketPriceCents: 1000, listPriceCents: 1100, priceSource: "scrydex", priceUpdatedAt: "2026-09-18T00:00:00Z" };
  const incoming = { marketPriceCents: 700, listPriceCents: 700, priceSource: "master-sheet", priceUpdatedAt: "2026-09-19T00:00:00Z", quantity: 4 };
  assert.deepEqual(preserveScrydexPricing(current, incoming), { ...incoming, ...current });
  assert.deepEqual(preserveScrydexPricing(current, preserveScrydexPricing(current, incoming)), { ...incoming, ...current });
  assert.equal(preserveScrydexPricing({ ...current, priceSource: "manual" }, incoming), incoming);
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
