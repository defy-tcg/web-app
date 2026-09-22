import { after } from "next/server";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import { SkuLabelInventoryError, validateInventoryLabels } from "@/lib/sku-label-inventory";
import { saveSkuLabelsToInventory } from "@/lib/sku-label-inventory-storage";
import { linkSavedSkuLabels, pendingSkuLink, skuLinkOriginAllowed } from "@/lib/sku-label-shopify-service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!skuLinkOriginAllowed(request)) return Response.json({ error: "Open QR labels on this website to save cards." }, { status: 403 });
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Send a valid JSON label batch." }, { status: 400 });
    }
    const labels = validateInventoryLabels(payload);
    const result = await saveSkuLabelsToInventory(labels);
    const first = result.products.slice(0, 3).map(product => product.sku);
    const remaining = result.products.slice(3).map(product => product.sku);
    let shopify = first.map(pendingSkuLink);
    try { shopify = await linkSavedSkuLabels(first, 45_000); } catch { /* Saved identities are recovered by the automatic retry pass. */ }
    if (remaining.length) after(async () => { await linkSavedSkuLabels(remaining); });
    return Response.json({ ...result, shopify: [...shopify, ...remaining.map(pendingSkuLink)] },
      { status: result.createdCount > 0 ? 201 : 200, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SkuLabelInventoryError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Inventory could not be saved. Retry with the same SKUs; existing saved products will not be added again." }, { status: 500 });
  }
}
