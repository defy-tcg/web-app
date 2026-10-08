export const PUBLIC_RESTOCK_SHOP = "n4a7aa-fi.myshopify.com";
export const PUBLIC_RESTOCK_LOCATION = "gid://shopify/Location/85590147158";
export const PUBLIC_RESTOCK_LIMIT = 1000;
export interface PublicRestock { productId: string; lastRestockedAt: string }

/** This projection exposes identities and dates only; never forward inventory JSON. */
export async function publicRestocksResponse(request: Request, config: { enabled: boolean; shop: string; locationId: string }, read: () => Promise<unknown[]>): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (new URL(request.url).search) return Response.json({ error: "This endpoint accepts no query parameters." }, { status: 400, headers });
  if (!config.enabled || config.shop !== PUBLIC_RESTOCK_SHOP || config.locationId !== PUBLIC_RESTOCK_LOCATION) {
    return Response.json({ error: "Stock arrival dates are temporarily unavailable." }, { status: 503, headers });
  }
  try {
    const rows = await read();
    if (!Array.isArray(rows) || rows.length > PUBLIC_RESTOCK_LIMIT) throw new Error("Incomplete public projection");
    const seen = new Set<string>();
    const restocks: PublicRestock[] = rows.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid projection");
      const row = value as Record<string, unknown>;
      if (typeof row.productId !== "string" || !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(row.productId) || seen.has(row.productId)
        || typeof row.lastRestockedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(row.lastRestockedAt)
        || !Number.isFinite(Date.parse(row.lastRestockedAt)) || new Date(row.lastRestockedAt).toISOString().slice(0, 19) !== row.lastRestockedAt.slice(0, 19)) throw new Error("Invalid projection");
      seen.add(row.productId);
      return { productId: row.productId, lastRestockedAt: new Date(row.lastRestockedAt).toISOString() };
    });
    return Response.json({ locationId: PUBLIC_RESTOCK_LOCATION, restocks }, { headers: { ...headers, "Cache-Control": "public, max-age=0, s-maxage=30" } });
  } catch {
    return Response.json({ error: "Stock arrival dates are temporarily unavailable." }, { status: 503, headers });
  }
}
