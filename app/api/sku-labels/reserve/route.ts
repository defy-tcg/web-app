import { getAuthorizedSession } from "@/lib/auth/authorization";
import { SkuLabelInventoryError, validateSkuLabelReservation } from "@/lib/sku-label-inventory";
import { reserveSkuLabel } from "@/lib/sku-label-inventory-storage";
import { linkSavedSkuLabels, pendingSkuLink, skuLinkOriginAllowed } from "@/lib/sku-label-shopify-service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!skuLinkOriginAllowed(request)) return Response.json({ error: "Open QR labels on this website to save cards." }, { status: 403 });
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Send a valid JSON card label." }, { status: 400 });
    }
    const label = validateSkuLabelReservation(payload);
    const result = await reserveSkuLabel(label);
    let shopify = pendingSkuLink(result.product.sku);
    try { [shopify] = await linkSavedSkuLabels([result.product.sku]); } catch { /* The durable Defy card remains queued for automatic recovery. */ }
    return Response.json({ ...result, shopify }, { status: result.created ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SkuLabelInventoryError) {
      return Response.json({ error: error.message, ...(error.existingSku ? { existingSku: error.existingSku } : {}) }, { status: error.status });
    }
    return Response.json({ error: "The QR code could not be saved. Retry the same card; its saved SKU will be reused." }, { status: 500 });
  }
}
