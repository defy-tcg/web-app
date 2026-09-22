import { SCRYDEX_PRICE_SOURCE, scrydexSellPriceCents } from "../pricing-policy.ts";
import { resolveScrydexPrice, ScrydexError } from "../scrydex.ts";
import { previewSingles, SinglesError, type PlannedSingle, type SinglesPreview } from "./intake.ts";
import type { Catalog, SinglesIntakeRow } from "./types.ts";

// The client divides larger batches into bounded requests, preserving the
// existing 100-row receiving workflow without a long API waterfall.
export const SINGLES_QUOTE_BATCH_SIZE = 10;
const QUOTE_CONCURRENCY = 4;

type QuoteInput = {
  name: string; game: string; setName: string; cardNumber: string;
  productType: string; condition: string; finish: string;
  tcgplayerId: number; tcgplayerUrl: string;
};
type Quote = { cents: number; scrydexId: string; url: string; variation: string };
export type SinglesPriceResolver = (input: QuoteInput) => Promise<Quote | null>;
export type PricedSingle = PlannedSingle & {
  pricing: { source: typeof SCRYDEX_PRICE_SOURCE; marketCents: number; scrydexId: string; url: string; variation: string };
};
export type PricedSinglesPreview = Omit<SinglesPreview, "rows"> & { rows: PricedSingle[] };

const resolvePrice: SinglesPriceResolver = resolveScrydexPrice;

async function pricePreview(preview: SinglesPreview, resolve: SinglesPriceResolver): Promise<PricedSinglesPreview> {
  if (preview.rows.length > SINGLES_QUOTE_BATCH_SIZE) {
    throw new SinglesError("PRICING_BATCH_TOO_LARGE", `Check at most ${SINGLES_QUOTE_BATCH_SIZE} prices per request. Split this price review into smaller groups.`);
  }
  const rows: PricedSingle[] = new Array(preview.rows.length);
  let next = 0;
  let failure: SinglesError | null = null;
  await Promise.all(Array.from({ length: Math.min(QUOTE_CONCURRENCY, preview.rows.length) }, async () => {
    while (!failure && next < preview.rows.length) {
      const index = next++;
      const row = preview.rows[index];
      const card = row.card;
      let quote: Quote | null;
      try {
        quote = await resolve({ name: card.name, game: "Riftbound", setName: card.setName, cardNumber: card.number,
          productType: "Single", condition: row.condition, finish: card.finish,
          tcgplayerId: card.productId, tcgplayerUrl: card.productUrl });
      } catch (error) {
        const detail = error instanceof ScrydexError ? ` ${error.message}` : " Check its exact printing and retry the price review.";
        failure = new SinglesError("SCRYDEX_PRICE_UNAVAILABLE", `Scrydex could not confirm a price for ${card.name} (${card.finish}, ${row.condition}).${detail}`);
        return;
      }
      if (!quote || !Number.isSafeInteger(quote.cents) || quote.cents <= 0 || quote.cents > 100_000_000 ||
        scrydexSellPriceCents(quote.cents, { game: "Riftbound", productType: "Single" }) > 100_000_000) {
        failure = new SinglesError("SCRYDEX_PRICE_UNAVAILABLE", `No supported Scrydex price is available for ${card.name} (${card.finish}, ${row.condition}). This row cannot be received until its price can be confirmed.`);
        return;
      }
      rows[index] = { ...row, priceCents: scrydexSellPriceCents(quote.cents, { game: "Riftbound", productType: "Single" }),
        pricing: { source: SCRYDEX_PRICE_SOURCE, marketCents: quote.cents, scrydexId: quote.scrydexId, url: quote.url, variation: quote.variation } };
    }
  }));
  if (failure) throw failure;
  return { ...preview, rows, totalPriceCents: rows.reduce((total, row) => total + row.priceCents * row.quantity, 0) };
}

/** Submitted prices and catalog benchmarks never determine the reviewed sale price. */
export async function previewPricedSingles(rows: SinglesIntakeRow[], catalog: Catalog, resolve: SinglesPriceResolver = resolvePrice): Promise<PricedSinglesPreview> {
  return pricePreview(previewSingles(rows, catalog), resolve);
}

/** Reject a stale or altered new request before any stock/product mutation. */
export async function validateSinglesPricing(preview: SinglesPreview, resolve: SinglesPriceResolver = resolvePrice): Promise<void> {
  const current = await pricePreview(preview, resolve);
  const changed = current.rows.find((row, index) => row.priceCents !== preview.rows[index].priceCents);
  if (changed) throw new SinglesError("PRICE_CHANGED", `${changed.card.name}'s price has changed. Review its current Scrydex market price again before receiving.`);
}
