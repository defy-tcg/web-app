import { resolveScrydexPrice, ScrydexError, type ScrydexPrice, type ScrydexProduct } from "./scrydex.ts";

export type SkuLinkPriceResolver = (product: ScrydexProduct, options?: { fresh?: boolean }) => Promise<ScrydexPrice>;

/** A cached missing quote gets one fresh check, using the same exact selector. */
export async function resolveSkuLinkPrice(product: ScrydexProduct, resolve: SkuLinkPriceResolver = resolveScrydexPrice): Promise<ScrydexPrice> {
  try { return await resolve(product); }
  catch (error) {
    if (!(error instanceof ScrydexError) || !["not_found", "price_unavailable"].includes(error.code)) throw error;
    return resolve(product, { fresh: true });
  }
}
