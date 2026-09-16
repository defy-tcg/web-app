import { getAuthorizedSession } from "@/lib/auth/authorization";
import { getSinglesConnectionStatus } from "@/lib/singles/intake";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const status = await getSinglesConnectionStatus();
    return Response.json({ ...status, connected: status.ready, error: status.blockers.join(" ") || undefined }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ connected: false, canPublish: false, error: "Shopify could not be reached. Your stock has not changed." }, { status: 503 });
  }
}
