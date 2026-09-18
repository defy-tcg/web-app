import { getAuthorizedSession } from "@/lib/auth/authorization";
import { getPriceSyncStatus, priceSyncEnabled, priceSyncError, publicPriceState, refreshShopifyPrices } from "@/lib/shopify/price-sync";
import { PriceSyncError } from "@/lib/shopify/price-sync-core";
import { hasSyncOrigin, readBoundedBody } from "@/lib/shopify/sync-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!priceSyncEnabled()) return Response.json({ enabled: false, state: null }, { headers });
  try { return Response.json(await getPriceSyncStatus(), { headers }); }
  catch (error) { return Response.json({ enabled: true, state: null, error: priceSyncError(error) }, { status: 503, headers }); }
}
export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!hasSyncOrigin(request, process.env.SHOPIFY_SYNC_ORIGIN, process.env.NODE_ENV === "production")) return Response.json({ error: "Open Shopify prices on the configured Defy OS website." }, { status: 403, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "A JSON request is required." }, { status: 415, headers });
  try {
    const body = JSON.parse(Buffer.from(await readBoundedBody(request, 2048)).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "runId")
      || (body.runId !== undefined && (typeof body.runId !== "string" || !/^[a-f0-9-]{36}$/.test(body.runId)))) return Response.json({ error: "Provide a valid pricing run ID, or an empty object to start." }, { status: 400, headers });
    const state = await refreshShopifyPrices({ runId: body.runId });
    return Response.json({ enabled: true, state: publicPriceState(state) }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof SyntaxError ? "Invalid JSON request." : priceSyncError(error) },
      { status: error instanceof SyntaxError ? 400 : error instanceof PriceSyncError && ["SYNC_BUSY", "RUN_CHANGED"].includes(error.code) ? 409 : 503, headers });
  }
}
