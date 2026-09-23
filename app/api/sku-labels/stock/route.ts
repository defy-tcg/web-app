import { getAuthorizedSession } from "@/lib/auth/authorization";
import { loadSkuLabelProducts } from "@/lib/sku-label-inventory-storage";
import { skuLinkOriginAllowed } from "@/lib/sku-label-shopify-service";
import { addSkuLabelStock, parseSkuLabelStockRequest, SkuLabelStockInputError } from "@/lib/sku-label-stock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!skuLinkOriginAllowed(request)) return Response.json({ error: "Open QR labels on this website to change stock." }, { status: 403 });
  try {
    let payload: unknown;
    try { payload = await request.json(); }
    catch { return Response.json({ error: "Send a valid JSON stock receipt." }, { status: 400 }); }
    const input = parseSkuLabelStockRequest(payload);
    const products = await loadSkuLabelProducts({ skus: [input.sku] });
    if (products.length !== 1 || products[0].sku !== input.sku) return Response.json({ error: "This saved QR card is unavailable. Keep the stock request ID and review its inventory record." }, { status: 404 });
    return Response.json(await addSkuLabelStock(products[0], input), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof SkuLabelStockInputError ? error.message : "Stock receipt is not confirmed. Retry the same request ID before starting another receipt." },
      { status: error instanceof SkuLabelStockInputError ? 400 : 503 });
  }
}
