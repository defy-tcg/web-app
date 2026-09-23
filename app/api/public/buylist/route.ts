import { unstable_cache } from "next/cache";
import { buildBuylistSnapshot, BUYLIST_TTL_SECONDS, currentBuylist } from "@/lib/buylist";
import { resolveScrydexPrice } from "@/lib/scrydex";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Cache the complete fixed buylist across requests/deployments. The cache key
// changes when its approved catalog or payout policy changes. Refreshes read
// Scrydex freshly so a second cache layer cannot extend the quote's lifetime.
const readBuylist = unstable_cache(() => buildBuylistSnapshot(product => resolveScrydexPrice(product, {
  fetch: (input, options) => fetch(input, { ...options, cache: "no-store", next: { revalidate: 0 } }),
})), ["defy-public-buylist-v1"], { revalidate: BUYLIST_TTL_SECONDS });

export async function GET() {
  try {
    return Response.json(currentBuylist(await readBuylist()), { headers: {
      "Cache-Control": "public, max-age=0, s-maxage=60", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "Buylist offers are temporarily unavailable. Please visit us for a quote." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
