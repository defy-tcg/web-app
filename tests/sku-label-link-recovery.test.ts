import assert from "node:assert/strict";
import test from "node:test";
import { canAutomaticallyRecoverSkuLink, SkuLinkRecoveryQueue } from "../lib/sku-label-link-recovery.ts";
import { resolveSkuLinkPrice } from "../lib/sku-label-link-price.ts";
import { ScrydexError, type ScrydexErrorCode, type ScrydexProduct } from "../lib/scrydex.ts";

const sku = "DEFY-2835238275";
const waiting = { sku, status: "blocked" as const, automaticRetry: true };
const product: ScrydexProduct = { name: "Eevee", game: "Pokémon", setName: "SWSH09: Brilliant Stars Trainer Gallery", cardNumber: "TG11/TG30", productType: "Single", condition: "Near Mint", finish: "Foil", tcgplayerId: 264218 };
const quote = { cents: 1784, matchedName: "Eevee", groupName: "Brilliant Stars Trainer Gallery", variation: "holofoil / NM", scrydexId: "swsh9tg-TG11", url: "https://api.scrydex.com/pokemon/v1/cards/swsh9tg-TG11" };

test("status reads never grant linking, and human-review blockers stop granted recovery", () => {
  const queue = new SkuLinkRecoveryQueue();
  queue.observe([waiting, { sku: "DEFY-1234567890", status: "pending" }]);
  assert.deepEqual(queue.take([sku], 15_000), []);
  for (const link of [{ sku, status: "ready" as const }, { sku, status: "blocked" as const }, { ...waiting, catalogCorrectionPending: true }, { sku, status: "pending" as const, catalogCorrectionPending: true }]) {
    assert.equal(canAutomaticallyRecoverSkuLink(link), false);
    queue.grant([waiting], 0);
    queue.observe([link]);
    assert.deepEqual(queue.take([sku], 15_000), []);
  }
});

test("a saved pricing failure gets three delayed attempts without status polling resetting its budget", () => {
  const queue = new SkuLinkRecoveryQueue();
  queue.grant([waiting], 0);
  assert.deepEqual(queue.take([sku], 14_999), []);
  assert.deepEqual(queue.take([sku, sku], 15_000), [sku]);
  queue.observe([waiting]);
  assert.deepEqual(queue.take([sku], 44_999), []);
  assert.deepEqual(queue.take([sku], 45_000), [sku]);
  queue.observe([{ sku, status: "pending" }]);
  assert.deepEqual(queue.take([sku], 104_999), []);
  assert.deepEqual(queue.take([sku], 105_000), [sku]);
  queue.observe([waiting]);
  assert.deepEqual(queue.take([sku], 250_000), []);
  assert.deepEqual(queue.skus(), []);
  queue.grant([waiting], 250_000); // An explicit staff retry can start a new window.
  assert.deepEqual(queue.take([sku], 265_000), [sku]);
});

test("recovery expires after five minutes and batches fairly without starving later cards", () => {
  const queue = new SkuLinkRecoveryQueue();
  const cards = Array.from({ length: 5 }, (_, index) => ({ sku: `DEFY-${1234567890 + index}`, status: "pending" as const }));
  const skus = cards.map(card => card.sku);
  queue.grant(cards, 0);
  assert.deepEqual(queue.take(skus, 15_000), skus.slice(0, 3));
  assert.deepEqual(queue.take(skus, 20_000), skus.slice(3));
  queue.expire(300_000);
  assert.deepEqual(queue.skus(), []);
  assert.deepEqual(queue.take(skus, 300_000), []);
  assert.deepEqual(queue.skus(), []);
});

test("missing cached catalog or price gets exactly one fresh check of the unchanged printing", async () => {
  for (const code of ["not_found", "price_unavailable"] as const) {
    const calls: { fresh?: boolean }[] = [];
    const result = await resolveSkuLinkPrice(product, async (card, options) => {
      assert.deepEqual(card, product);
      calls.push(options ?? {});
      if (!options?.fresh) throw new ScrydexError(code, "Cached result");
      return quote;
    });
    assert.deepEqual(calls, [{}, { fresh: true }]);
    assert.deepEqual(result, quote);
  }
});

test("success, ambiguity, missing configuration and upstream failures do not trigger a fresh lookup loop", async () => {
  let calls = 0;
  assert.deepEqual(await resolveSkuLinkPrice(product, async () => { calls++; return quote; }), quote);
  assert.equal(calls, 1);
  for (const code of ["not_configured", "unsupported", "incomplete_identity", "ambiguous", "upstream_error"] as ScrydexErrorCode[]) {
    calls = 0;
    await assert.rejects(resolveSkuLinkPrice(product, async () => { calls++; throw new ScrydexError(code, "Private provider error"); }), error => error instanceof ScrydexError && error.code === code);
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(resolveSkuLinkPrice(product, async () => { calls++; throw new ScrydexError("not_found", "Still missing"); }), error => error instanceof ScrydexError && error.code === "not_found");
  assert.equal(calls, 2);
});
