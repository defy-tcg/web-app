import { getAuthorizedSession } from "@/lib/auth/authorization";
import { readRiftboundCatalog } from "@/lib/singles/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await readRiftboundCatalog(), { headers: { "Cache-Control": "private, no-store" } });
}
