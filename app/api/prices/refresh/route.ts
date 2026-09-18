import { asc, eq, gt } from "drizzle-orm";
import { getDb } from "../../../../db";
import { products } from "../../../../db/schema";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import { tcgplayerImageUrl } from "@/lib/catalog-image";
import { getScrydexConfig, resolveScrydexPrice } from "@/lib/scrydex";
import { saveScrydexQuote } from "@/lib/pricing-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const BATCH_SIZE = 3;
type InventoryProduct = typeof products.$inferSelect;

async function refreshProduct(product: InventoryProduct) {
  const match = await resolveScrydexPrice(product);
  const updatedProduct = await saveScrydexQuote(product, match.cents);
  return {
    product: { ...updatedProduct, imageUrl: tcgplayerImageUrl(updatedProduct.tcgplayerId, updatedProduct.tcgplayerUrl) || match.imageUrl },
    match,
  };
}

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Open Defy on this website to refresh prices." }, { status: 403 });
  }
  let payload: { productId?: number; afterId?: number };
  try {
    payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    if (payload.productId !== undefined && (!Number.isSafeInteger(payload.productId) || payload.productId < 1)) throw new Error();
    if (payload.afterId !== undefined && (!Number.isSafeInteger(payload.afterId) || payload.afterId < 0)) throw new Error();
  } catch {
    return Response.json({ error: "Provide a valid product ID or price-refresh cursor." }, { status: 400 });
  }
  try { getScrydexConfig(); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scrydex is not configured." }, { status: 503 });
  }
  const db = getDb();
  if (payload.productId !== undefined) {
    const [product] = await db.select().from(products).where(eq(products.id, payload.productId)).limit(1);
    if (!product) return Response.json({ error: "Product not found" }, { status: 404 });
    try {
      return Response.json({ checked: 1, updated: 1, failed: 0, ...await refreshProduct(product) });
    } catch (error) {
      return Response.json({ checked: 1, updated: 0, failed: 1, error: error instanceof Error ? error.message : "Scrydex price refresh failed." }, { status: 422 });
    }
  }
  const candidates = await db.select().from(products).where(gt(products.id, payload.afterId ?? 0)).orderBy(asc(products.id)).limit(BATCH_SIZE + 1);
  const batch = candidates.slice(0, BATCH_SIZE);
  const failures: { productId: number; name: string; error: string }[] = [];
  let updated = 0;
  for (const product of batch) {
    try { await refreshProduct(product); updated++; }
    catch (error) {
      failures.push({ productId: product.id, name: product.name, error: error instanceof Error ? error.message : "Price unavailable." });
    }
  }
  return Response.json({
    checked: batch.length, updated, failed: failures.length, failures,
    nextAfterId: candidates.length > BATCH_SIZE ? batch.at(-1)!.id : null,
    note: failures.length ? "Unmatched or unavailable Scrydex prices were left unchanged. Review the listed products." : undefined,
  });
}
