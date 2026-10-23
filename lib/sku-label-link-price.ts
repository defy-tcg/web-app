import { resolveScrydexPrice, ScrydexError, type ScrydexPrice, type ScrydexProduct } from "./scrydex.ts";
import { canVerifyScrydexCatalog, ScrydexCatalogProofError, verifyScrydexCatalog, type VerifiedScrydexCatalogProof } from "./scrydex-catalog-proof.ts";

export type SkuLinkPriceResolver = (product: ScrydexProduct, options?: { fresh?: boolean; catalogProof?: VerifiedScrydexCatalogProof }) => Promise<ScrydexPrice>;

/** One fresh check; catalog gaps additionally require independent, unchanged source identity. */
export async function resolveSkuLinkPrice(product: ScrydexProduct, resolve: SkuLinkPriceResolver = resolveScrydexPrice, options: {
  verifyCatalog?: (product: ScrydexProduct) => Promise<VerifiedScrydexCatalogProof>;
} = {}): Promise<ScrydexPrice> {
  try { return await resolve(product); }
  catch (error) {
    if (!(error instanceof ScrydexError)) throw error;
    // An injected resolver owns its upstream dependencies; never add real
    // network calls behind a test or another trusted server-side override.
    const verify = options.verifyCatalog ?? (resolve === resolveScrydexPrice ? verifyScrydexCatalog : undefined);
    if (["incomplete_identity", "not_found"].includes(error.code) && verify && canVerifyScrydexCatalog(product)) {
      let proof: VerifiedScrydexCatalogProof;
      try { proof = await verify(product); }
      catch (failure) {
        if (failure instanceof ScrydexCatalogProofError && failure.code === "upstream_error") {
          throw new ScrydexError("upstream_error", failure.message);
        }
        throw error;
      }
      return resolve(product, { fresh: true, catalogProof: proof });
    }
    if (!["not_found", "price_unavailable"].includes(error.code)) throw error;
    return resolve(product, { fresh: true });
  }
}
