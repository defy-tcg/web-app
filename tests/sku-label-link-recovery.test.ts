import assert from "node:assert/strict";
import test from "node:test";
import { canAutomaticallyRecoverSkuLink, SkuLinkRecoveryQueue, SkuLinkVerificationQueue } from "../lib/sku-label-link-recovery.ts";
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
  queue.grant([waiting], 20_000); // Reloading or focusing the library preserves the same attempt budget.
  assert.deepEqual(queue.take([sku], 44_999), []);
  assert.deepEqual(queue.take([sku], 45_000), [sku]);
  queue.observe([{ sku, status: "pending" }]);
  assert.deepEqual(queue.take([sku], 104_999), []);
  assert.deepEqual(queue.take([sku], 105_000), [sku]);
  queue.observe([waiting]);
  assert.deepEqual(queue.take([sku], 250_000), []);
  assert.deepEqual(queue.skus(), []);
  queue.grant([waiting], 250_000);
  assert.deepEqual(queue.take([sku], 265_000), []);
  queue.grant([waiting], 250_000, { reset: true }); // An explicit staff retry can start a new window.
  assert.deepEqual(queue.take([sku], 265_000), [sku]);
});

test("recovery batches fairly and expires five minutes after each card starts", () => {
  const queue = new SkuLinkRecoveryQueue();
  const cards = Array.from({ length: 5 }, (_, index) => ({ sku: `DEFY-${1234567890 + index}`, status: "pending" as const }));
  const skus = cards.map(card => card.sku);
  queue.grant(cards, 0);
  assert.deepEqual(queue.take(skus, 15_000), skus.slice(0, 3));
  assert.deepEqual(queue.take(skus, 20_000), skus.slice(3));
  queue.expire(320_000);
  assert.deepEqual(queue.skus(), []);
  assert.deepEqual(queue.take(skus, 320_000), []);
  queue.grant(cards, 400_000);
  assert.deepEqual(queue.take(skus, 415_000), []);
  assert.deepEqual(queue.skus(), []);
});

test("stored links awaiting verification never grant relinking or claim an automatic recovery slot", () => {
  const queue = new SkuLinkRecoveryQueue();
  const stored = { sku, status: "pending" as const, verificationPending: true, automaticRetry: true };
  assert.equal(canAutomaticallyRecoverSkuLink(stored), false);
  queue.grant([stored], 0);
  queue.observe([stored]);
  assert.deepEqual(queue.take([sku], 15_000), []);
  queue.grant([waiting], 20_000); // A subsequent live check can discover a genuinely unfinished link.
  assert.deepEqual(queue.take([sku], 35_000), [sku]);
});

test("completed and review-only cards cannot block the remaining pending cards in a mixed batch", () => {
  const queue = new SkuLinkRecoveryQueue();
  const cards = Array.from({ length: 6 }, (_, index) => ({ sku: `DEFY-${1234567890 + index}`, status: "pending" as const }));
  const skus = cards.map(card => card.sku);
  queue.grant(cards, 0);
  assert.deepEqual(queue.take(skus, 15_000), skus.slice(0, 3));
  const checked = [{ ...cards[0], status: "ready" as const }, { ...cards[1], status: "blocked" as const }, cards[2]];
  queue.observe(checked);
  assert.deepEqual(checked.filter(canAutomaticallyRecoverSkuLink).map(card => card.sku), [skus[2]]);
  assert.deepEqual(queue.take(queue.skus(), 20_000), skus.slice(3));
  assert.deepEqual(queue.take(queue.skus(), 45_000), [skus[2]]);
});

test("a large library gives waiting cards their own window instead of expiring them in the backlog", () => {
  const queue = new SkuLinkRecoveryQueue();
  const cards = Array.from({ length: 100 }, (_, index) => ({ sku: `DEFY-${1234567890 + index}`, status: "pending" as const }));
  const skus = cards.map(card => card.sku);
  queue.grant(cards, 0);
  assert.deepEqual(queue.take(skus, 15_000), skus.slice(0, 3));
  queue.grant(cards, 400_000); // Neither expired retries nor waiting cards receive a new grant window.
  assert.deepEqual(queue.take(skus, 400_000), skus.slice(3, 6));
  assert.equal(queue.has(skus[0]), false);
  assert.equal(queue.has(skus[99]), true);
  assert.deepEqual(queue.take(skus, 405_000), skus.slice(6, 9));
});

test("unavailable selected labels get bounded read-only verification retries without reset on focus", () => {
  const queue = new SkuLinkVerificationQueue();
  const unavailable = { sku, status: "pending" as const, verificationPending: true };
  queue.observe([unavailable], 0);
  assert.deepEqual(queue.take([sku], 14_999), []);
  assert.deepEqual(queue.take([sku], 15_000), [sku]);
  queue.observe([unavailable], 20_000);
  assert.deepEqual(queue.take([sku], 44_999), []);
  assert.deepEqual(queue.take([sku], 45_000), [sku]);
  queue.observe([unavailable], 50_000);
  assert.deepEqual(queue.take([sku], 105_000), [sku]);
  queue.observe([unavailable], 110_000);
  assert.deepEqual(queue.take([sku], 250_000), []);
  assert.equal(queue.has(sku, 250_000), false);
  assert.equal(canAutomaticallyRecoverSkuLink(unavailable), false);
});

test("verification stops after confirmation or five minutes and stays targeted to selected labels", () => {
  const queue = new SkuLinkVerificationQueue();
  const cards = [sku, "DEFY-1234567890"].map(sku => ({ sku, status: "pending" as const, verificationPending: true }));
  queue.observe(cards, 0);
  assert.deepEqual(queue.take([sku], 15_000), [sku]);
  queue.observe([{ sku, status: "ready" }], 20_000);
  assert.deepEqual(queue.take([sku], 45_000), []);
  assert.deepEqual(queue.take(cards.map(card => card.sku), 300_000), []);
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
