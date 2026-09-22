import { after } from "next/server";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import { SkuLabelInventoryError } from "@/lib/sku-label-inventory";
import { linkSavedSkuLabels, pendingSkuLink, readSavedSkuLinks, skuLinkOriginAllowed, skuLinkRequestSkus } from "@/lib/sku-label-shopify-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const skus = skuLinkRequestSkus(new URL(request.url).searchParams.get("skus")?.split(","));
    return Response.json({ links: await readSavedSkuLinks(skus) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof SkuLabelInventoryError ? error.message : "Shopify link status is unavailable. Your saved QR codes are safe." },
      { status: error instanceof SkuLabelInventoryError ? error.status : 503 });
  }
}

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!skuLinkOriginAllowed(request)) return Response.json({ error: "Open QR labels on this website to link cards to Shopify." }, { status: 403 });
  try {
    let payload: { skus?: unknown } | null;
    try { payload = await request.json() as { skus?: unknown } | null; }
    catch { return Response.json({ error: "Send a valid JSON list of saved QR SKUs." }, { status: 400 }); }
    const skus = skuLinkRequestSkus(payload?.skus);
    const first = skus.slice(0, 3), remaining = skus.slice(3);
    const links = await linkSavedSkuLabels(first, 45_000);
    if (remaining.length) after(async () => { await linkSavedSkuLabels(remaining); });
    return Response.json({ links: [...links, ...remaining.map(pendingSkuLink)] }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof SkuLabelInventoryError ? error.message : "Shopify linking is not confirmed. Retry the saved QR codes; starting stock will not be added twice." },
      { status: error instanceof SkuLabelInventoryError ? error.status : 503 });
  }
}
