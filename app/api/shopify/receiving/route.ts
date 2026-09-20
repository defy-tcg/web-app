import { getAuthorizedSession } from "@/lib/auth/authorization";
import { getReceivingHistory, ReceivingHistoryError } from "@/lib/shopify/receiving-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => key !== "cursor") || params.getAll("cursor").length > 1) {
    return Response.json({ error: "Only one optional receiving-history cursor is accepted.", code: "INVALID_QUERY" }, { status: 400, headers });
  }
  try {
    return Response.json(await getReceivingHistory(params.has("cursor") ? params.get("cursor") : undefined), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof ReceivingHistoryError ? error.message : "Receiving history could not be loaded. Retry shortly.",
      code: error instanceof ReceivingHistoryError ? error.code : "HISTORY_UNAVAILABLE" },
    { status: error instanceof ReceivingHistoryError ? error.status : 503, headers });
  }
}
