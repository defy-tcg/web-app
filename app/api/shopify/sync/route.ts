import { getAuthorizedSession } from "@/lib/auth/authorization";
import { configBlockers, syncConfig } from "@/lib/shopify/read-client";
import { ShopifySyncRepository } from "@/lib/shopify/repository";
import { reconcilePage, syncErrorMessage } from "@/lib/shopify/service";
import { hasSyncOrigin, readBoundedBody, ShopifySyncError } from "@/lib/shopify/sync-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const config = syncConfig();
  const blockers = configBlockers(config);
  const base = { configured: blockers.length === 0, enabled: config.enabled, shop: config.shop, locationId: config.locationId, blockers,
    inventory: [], orders: [], summary: { products: 0, variants: 0, inventory: 0, orders: 0, pending: 0, failed: 0, lastSyncedAt: null }, recentErrors: [] };
  if (!config.enabled || blockers.length) return Response.json({ ...base, status: !config.enabled ? "disabled" : "setup_required" }, { headers });
  try {
    const dashboard = await new ShopifySyncRepository().dashboard(config.shop, config.locationId);
    return Response.json({ ...base, ...dashboard, status: dashboard.recentErrors.length ? "error" : "ready" }, { headers });
  } catch {
    return Response.json({ ...base, status: "setup_required", blockers: ["The Shopify sync tables are unavailable. Apply the reviewed additive migration before syncing."] }, { headers });
  }
}
export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  if (!hasSyncOrigin(request, process.env.SHOPIFY_SYNC_ORIGIN, process.env.NODE_ENV === "production")) return Response.json({ error: "Open Shopify sync on the configured DefyOS website to reconcile." }, { status: 403, headers });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "A JSON request is required." }, { status: 415, headers });
  try {
    const raw = await readBoundedBody(request, 8192);
    const body = JSON.parse(Buffer.from(raw).toString("utf8")) as { cursor?: unknown };
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShopifySyncError("INVALID_PAYLOAD", "Provide a reconciliation request object.", 400);
    return Response.json(await reconcilePage(syncConfig(), body.cursor), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof SyntaxError ? "Invalid JSON request." : syncErrorMessage(error) }, { status: error instanceof SyntaxError ? 400 : error instanceof ShopifySyncError ? error.status : 503, headers });
  }
}
