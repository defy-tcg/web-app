import { getAuthorizedSession } from "@/lib/auth/authorization";
import { lookupTcgplayerCard, TcgplayerCardLookupError } from "@/lib/tcgplayer-card";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Send a valid JSON object with a TCGplayer card URL." }, { status: 400 });
    }
    const url = payload !== null && typeof payload === "object" && "url" in payload ? payload.url : undefined;
    const card = await lookupTcgplayerCard(url);
    return Response.json({ card }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof TcgplayerCardLookupError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "The card could not be looked up. Please try again shortly." }, { status: 500 });
  }
}
