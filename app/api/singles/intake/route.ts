import { getAuthorizedSession } from "@/lib/auth/authorization";
import { readRiftboundCatalog } from "@/lib/singles/catalog";
import { previewSingles, receiveSingles, SinglesError } from "@/lib/singles/intake";
import type { SinglesIntakeRow } from "@/lib/singles/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Open singles intake on this website to save stock." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "A JSON intake request is required." }, { status: 415 });
  }
  try {
    const raw = await request.text();
    if (raw.length > 128_000) return Response.json({ error: "This batch is too large. Use at most 100 rows." }, { status: 413 });
    const payload = JSON.parse(raw) as { action?: string; requestId?: string; rows?: SinglesIntakeRow[]; publish?: boolean };
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.rows) || !payload.rows.length || payload.rows.length > 100 || typeof payload.publish !== "boolean") {
      return Response.json({ error: "Provide 1–100 stock rows and a publishing choice." }, { status: 400 });
    }
    const catalog = await readRiftboundCatalog();
    if (payload.action === "preview") {
      const preview = previewSingles(payload.rows, catalog);
      if (payload.publish && preview.rows.some((row) => row.priceCents <= 0)) {
        return Response.json({ error: "Every published single needs a sale price greater than zero." }, { status: 400 });
      }
      return Response.json(preview);
    }
    if (payload.action !== "receive" || typeof payload.requestId !== "string" || payload.rows.length !== 1) {
      return Response.json({ error: "Save one reviewed row per receipt with its original request ID." }, { status: 400 });
    }
    const receipt = await receiveSingles({ requestId: payload.requestId, rows: payload.rows, publish: payload.publish }, catalog);
    return Response.json(receipt, { status: receipt.status === "pending" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SinglesError) {
      return Response.json({ error: { code: error.code, message: error.message, retryable: error.retryable, uncertain: error.uncertain } }, { status: error.uncertain ? 409 : 400 });
    }
    if (error instanceof SyntaxError) return Response.json({ error: "The intake request is not valid JSON." }, { status: 400 });
    return Response.json({ error: { message: "The save could not be confirmed. Keep this receipt and retry the same request.", retryable: true, uncertain: true } }, { status: 503 });
  }
}
