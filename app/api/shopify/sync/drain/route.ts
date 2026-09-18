import { timingSafeEqual } from "node:crypto";
import { syncConfig } from "@/lib/shopify/read-client";
import { drainInbox, syncErrorMessage } from "@/lib/shopify/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
async function drain(request: Request) {
  const secret = process.env.SHOPIFY_SYNC_CRON_SECRET || process.env.CRON_SECRET || "";
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const config = syncConfig();
  if (!config.enabled) return Response.json({ enabled: false, processed: 0 });
  try { return Response.json(await drainInbox(config, 3)); }
  catch (error) { return Response.json({ error: syncErrorMessage(error) }, { status: 503 }); }
}
export const GET = drain;
export const POST = drain;
