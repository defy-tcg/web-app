import { handlePosPricingRequest } from "@/lib/shopify/pos-handler";
import { refreshPosPrice } from "@/lib/shopify/pos-pricing";
import { createShopifyGraphQL } from "@/lib/singles/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function handle(request: Request) {
  return handlePosPricingRequest(request, {
    refresh: async (code) => {
      // Authentication and bounded input validation happen before app-token use.
      const { graphql } = await createShopifyGraphQL();
      return refreshPosPrice(code, { graphql });
    },
  });
}

export const POST = handle;
export const OPTIONS = handle;
