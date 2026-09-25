import { getAuthorizedSession } from "@/lib/auth/authorization";
import { reviewOrCorrectSkuLabelCatalog, validateSkuLabelCatalogRequest } from "@/lib/sku-label-catalog-correction";
import { skuLinkOriginAllowed } from "@/lib/sku-label-shopify-service";
import { SkuLabelInventoryError } from "@/lib/sku-label-inventory";
import { TcgplayerCardLookupError } from "@/lib/tcgplayer-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!skuLinkOriginAllowed(request)) return Response.json({ error: "Open QR labels on this website to correct a saved card." }, { status: 403 });
  try {
    let payload: unknown;
    try { payload = await request.json(); } catch { return Response.json({ error: "Send a valid catalog correction request." }, { status: 400 }); }
    const input = validateSkuLabelCatalogRequest(payload);
    const result = await reviewOrCorrectSkuLabelCatalog(input);
    return Response.json({ ...result, ...(result.product ? { link: { sku: result.product.sku, status: "blocked",
      message: "Catalog details corrected. Retry Shopify linking with this same QR; the original starting quantity is retained." } } : {}) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const known = error instanceof SkuLabelInventoryError || error instanceof TcgplayerCardLookupError;
    return Response.json({ error: known ? error.message : "The catalog correction could not be confirmed. Retry the same reviewed card and finish; keep its original QR." },
      { status: known ? error.status : 503 });
  }
}
