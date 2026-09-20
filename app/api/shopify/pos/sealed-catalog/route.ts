import { searchSealedCatalog, getSealedCatalogProduct } from "@/lib/scrydex-sealed-catalog";
import { handlePosSealedCatalogRequest } from "@/lib/shopify/pos-sealed-catalog-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const handle = (request: Request) => handlePosSealedCatalogRequest(request, {
  search: searchSealedCatalog,
  get: getSealedCatalogProduct,
});

export const POST = handle;
export const OPTIONS = handle;
