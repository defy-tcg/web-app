import { after } from "next/server";
import { syncConfig } from "@/lib/shopify/read-client";
import { ShopifySyncRepository } from "@/lib/shopify/repository";
import { drainInbox, requireSync, syncErrorMessage } from "@/lib/shopify/service";
import { MAX_WEBHOOK_BYTES, parseDelivery, readBoundedBody, ShopifySyncError, verifyWebhookHmac } from "@/lib/shopify/sync-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const config = syncConfig();
    requireSync(config);
    const raw = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
    if (!verifyWebhookHmac(raw, request.headers.get("x-shopify-hmac-sha256"), config.webhookSecret)) return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { throw new ShopifySyncError("INVALID_JSON", "Webhook body is not valid JSON.", 400); }
    const delivery = parseDelivery(request.headers, payload, config.shop, config.ordersEnabled);
    if (!delivery) return new Response(null, { status: 204 });
    // Persist only IDs/topic/time. Customer payloads and signing secrets are never stored.
    await new ShopifySyncRepository().enqueue(config.shop, delivery);
    after(async () => {
      try { await drainInbox(config); } catch { /* Inbox is durable; scheduled/manual drains retry without logging payloads. */ }
    });
    return Response.json({ accepted: true });
  } catch (error) {
    // A database failure does not acknowledge delivery: Shopify should retry it.
    return Response.json({ error: syncErrorMessage(error) }, { status: error instanceof ShopifySyncError ? error.status : 503 });
  }
}
