import { cronAuthorized } from "@/lib/shopify/price-sync-core";
import { repairSavedSkuLinks } from "@/lib/sku-label-shopify-repair";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!cronAuthorized(request, process.env.CRON_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await repairSavedSkuLinks(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Automatic QR linking could not complete. Saved QR codes and confirmed stock receipts will be reused on retry." }, { status: 503 });
  }
}
