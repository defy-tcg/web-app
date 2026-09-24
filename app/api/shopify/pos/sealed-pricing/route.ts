import { getSealedCatalogProduct } from "@/lib/scrydex-sealed-catalog";
import { createShopifyGraphQL } from "@/lib/singles/shopify";
import { handlePosSealedPricingRequest } from "@/lib/shopify/pos-sealed-pricing-handler";
import { linkSealedPrice, lookupSealedPrice } from "@/lib/shopify/pos-sealed-pricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function dependencies() {
  const { graphql } = await createShopifyGraphQL({ apiVersion: "2026-10" });
  return { graphql, getProduct: (id: string) => getSealedCatalogProduct({ game: "pokemon", id }, { fresh: true }) };
}

const handle = (request: Request) => handlePosSealedPricingRequest(request, {
  scan: async code => lookupSealedPrice(code, await dependencies()),
  link: async input => ({ status: "quoted", quote: await linkSealedPrice(input, await dependencies()) }),
});

export const POST = handle;
export const OPTIONS = handle;
