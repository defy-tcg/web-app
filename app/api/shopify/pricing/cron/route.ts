import { cronAuthorized } from "@/lib/shopify/price-sync-core";
import { priceSyncEnabled, priceSyncError, publicPriceState, refreshShopifyPrices } from "@/lib/shopify/price-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  if (!cronAuthorized(request, process.env.CRON_SECRET)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!priceSyncEnabled()) return Response.json({ enabled: false });
  const started = Date.now();
  try {
    let state = await refreshShopifyPrices({ automatic: true });
    // Allow enough time for the bounded page's upstream timeouts and checkpoint.
    while (!state.finishedAt && Date.now() - started < 120_000) state = await refreshShopifyPrices({ automatic: true, runId: state.runId });
    return Response.json({ enabled: true, state: publicPriceState(state), paused: !state.finishedAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: priceSyncError(error) }, { status: 503 }); }
}
