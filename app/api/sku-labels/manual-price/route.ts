import { getAuthorizedSession } from "@/lib/auth/authorization";
import { SkuLabelInventoryError } from "@/lib/sku-label-inventory";
import { approveSkuLabelManualPrice, validateSkuLabelManualPriceRequest } from "@/lib/sku-label-manual-price";
import { linkSavedSkuLabels, skuLinkOriginAllowed } from "@/lib/sku-label-shopify-service";
import type { SkuLabelShopifyStatus } from "@/lib/sku-label-shopify";
import { TcgplayerCardLookupError } from "@/lib/tcgplayer-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!skuLinkOriginAllowed(request)) return Response.json({ error: "Open QR labels on this website to confirm a store selling price." }, { status: 403 });
  try {
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Send a valid store selling price request." }, { status: 400 });
    }
    const approved = await approveSkuLabelManualPrice(validateSkuLabelManualPriceRequest(payload));
    let link: SkuLabelShopifyStatus = { sku: approved.product.sku, status: "pending",
      message: "The store price is saved. Retry this original QR to confirm Shopify POS readiness; its starting receipt stays the same." };
    try { link = (await linkSavedSkuLabels([approved.product.sku]))[0] ?? link; }
    catch { /* The confirmed journal approval remains available for retry with the original QR and starting receipt. */ }
    return Response.json({ link }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const known = error instanceof SkuLabelInventoryError || error instanceof TcgplayerCardLookupError;
    return Response.json({ error: known ? error.message : "The store price approval could not be confirmed. Retry this same saved QR and price; keep its original label." },
      { status: known ? error.status : 503 });
  }
}
