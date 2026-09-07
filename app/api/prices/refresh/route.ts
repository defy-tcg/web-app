import { eq, isNotNull, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { priceHistory, products } from "../../../../db/schema";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import { tcgplayerImageUrl } from "@/lib/catalog-image";
import { inferGameFromName, tcgplayerCategoryIdForGame } from "@/lib/tcg-games";

type InventoryProduct = typeof products.$inferSelect;
type TcgGroup = { groupId: number; name: string };
type TcgProduct = { productId: number; name: string; cleanName?: string; url?: string; imageUrl?: string; groupId?: number };
type TcgPrice = { productId: number; marketPrice: number | null; lowPrice?: number | null; midPrice?: number | null; subTypeName?: string };
type TcgResponse<T> = { success?: boolean; results?: T[] };

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/league of legends|trading card game|tcg/g, " ")
    .replace(/booster display box|booster box|display box/g, "booster display")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreName(left: string, right: string) {
  const a = new Set(normalize(left).split(" ").filter(Boolean));
  const b = new Set(normalize(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  const base = intersection / union;
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  return leftNormalized === rightNormalized ? 1 : (leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized) ? Math.max(.82, base) : base);
}

function productUrl(id: number | null, url: string | null) {
  if (url && /^https:\/\/(www\.)?tcgplayer\.com\/product\//i.test(url)) return url;
  return id ? `https://www.tcgplayer.com/product/${id}` : null;
}

async function tcgFetch<T>(path: string) {
  const response = await fetch(`https://tcgcsv.com/tcgplayer/${path}`, {
    headers: { accept: "application/json", "user-agent": "DefyTCGStoreOS/1.1 (daily TCGplayer market sync)" },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`TCG pricing feed returned ${response.status}`);
  const body = await response.json() as TcgResponse<T>;
  if (!Array.isArray(body.results)) throw new Error("TCG pricing feed was unavailable");
  return body.results;
}

function choosePrice(product: InventoryProduct, prices: TcgPrice[]) {
  const available = prices.filter(price => Number.isFinite(price.marketPrice) && Number(price.marketPrice) > 0);
  if (!available.length) return null;
  const desired = normalize(product.finish || (product.productType === "Sealed" ? "Normal" : ""));
  const exact = available.find(price => desired && normalize(price.subTypeName || "") === desired);
  const normal = available.find(price => normalize(price.subTypeName || "") === "normal");
  return exact || normal || available[0];
}

async function resolveFromTcgplayerFeed(product: InventoryProduct) {
  const categoryId = tcgplayerCategoryIdForGame(product.game) ||
    tcgplayerCategoryIdForGame(inferGameFromName(`${product.name} ${product.setName}`));
  if (!categoryId) throw new Error(`Automatic TCG pricing is not set up for ${product.game || "this game"}`);

  const groups = await tcgFetch<TcgGroup>(`${categoryId}/groups`);
  const rankedGroups = groups
    .map(group => ({ group, score: product.setName ? scoreName(product.setName, group.name) : 0 }))
    .sort((a, b) => b.score - a.score);
  const candidates = product.setName
    ? rankedGroups.filter(item => item.score >= .45).slice(0, 3).map(item => item.group)
    : (groups.length <= 30 ? groups : []);
  if (!candidates.length) throw new Error("Add the product set name or TCGplayer ID so Defy can match its price");

  let best: { item: TcgProduct; group: TcgGroup; score: number } | null = null;
  let bestPrices: TcgPrice[] = [];
  for (const group of candidates) {
    const [catalog, prices] = await Promise.all([
      tcgFetch<TcgProduct>(`${categoryId}/${group.groupId}/products`),
      tcgFetch<TcgPrice>(`${categoryId}/${group.groupId}/prices`),
    ]);
    const ranked = catalog.map(candidate => ({ candidate, score: scoreName(product.name, candidate.name) })).sort((a, b) => b.score - a.score);
    const item = product.tcgplayerId ? catalog.find(candidate => candidate.productId === product.tcgplayerId) : ranked[0]?.candidate;
    if (!item) continue;
    const score = product.tcgplayerId ? 1 : scoreName(product.name, item.name);
    if (!best || score > best.score) { best = { item, group, score }; bestPrices = prices.filter(price => price.productId === item.productId); }
  }
  if (!best || best.score < .9) throw new Error("Defy could not verify one exact TCGplayer product for this item");
  const price = choosePrice({ ...product, tcgplayerId: best.item.productId }, bestPrices);
  if (!price?.marketPrice) throw new Error("TCGplayer does not have a market price for this product yet");
  return {
    cents: Math.round(price.marketPrice * 100),
    productId: best.item.productId,
    url: best.item.url || `https://www.tcgplayer.com/product/${best.item.productId}`,
    matchedName: best.item.name,
    groupName: best.group.name,
    variation: price.subTypeName || "Normal",
    imageUrl: tcgplayerImageUrl(best.item.productId, best.item.imageUrl),
  };
}

function extractMarketPrice(html: string) {
  const patterns = [
    /"marketPrice"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i,
    /"market_price"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)/i,
    /Market Price[\s\S]{0,180}?\$\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return Math.round(Number(match[1].replaceAll(",", "")) * 100);
  }
  return null;
}

async function resolveFromProductPage(product: InventoryProduct) {
  const url = productUrl(product.tcgplayerId, product.tcgplayerUrl);
  if (!url) throw new Error("This product is not linked to TCGplayer yet");
  const response = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; DefyTCGInventory/1.1)" }, redirect: "follow", signal: AbortSignal.timeout(9000) });
  if (!response.ok) throw new Error(`TCGplayer returned ${response.status}`);
  const cents = extractMarketPrice(await response.text());
  if (!cents) throw new Error("TCGplayer market price was unavailable");
  return { cents, productId: product.tcgplayerId, url, matchedName: product.name, groupName: product.setName, variation: product.finish || "Normal", imageUrl: tcgplayerImageUrl(product.tcgplayerId) };
}

async function refreshProduct(product: InventoryProduct) {
  let match;
  try { match = await resolveFromTcgplayerFeed(product); }
  catch (feedError) {
    try { match = await resolveFromProductPage(product); }
    catch { throw feedError; }
  }
  const now = new Date().toISOString();
  const db = getDb();
  const [updatedProduct] = await db.update(products).set({
    marketPriceCents: match.cents,
    tcgplayerId: match.productId,
    tcgplayerUrl: match.url,
    priceSource: "tcgplayer-daily",
    priceUpdatedAt: now,
    updatedAt: now,
  }).where(eq(products.id, product.id)).returning();
  await db.insert(priceHistory).values({ productId: product.id, marketPriceCents: match.cents, source: "tcgplayer-daily" });
  return { product: { ...updatedProduct, imageUrl: match.imageUrl || tcgplayerImageUrl(updatedProduct.tcgplayerId) }, match };
}

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const db = getDb();
  const payload = await request.json().catch(() => ({})) as { productId?: number; tcgplayerId?: number };
  if (payload.productId) {
    const [product] = await db.select().from(products).where(eq(products.id, Math.round(payload.productId))).limit(1);
    if (!product) return Response.json({ error: "Product not found" }, { status: 404 });
    try {
      const forcedId = Number(payload.tcgplayerId) > 0 ? Math.round(Number(payload.tcgplayerId)) : null;
      const result = await refreshProduct(forcedId ? { ...product, tcgplayerId: forcedId, tcgplayerUrl: `https://www.tcgplayer.com/product/${forcedId}` } : product);
      return Response.json({ checked: 1, updated: 1, failed: 0, ...result });
    } catch (error) {
      return Response.json({ checked: 1, updated: 0, failed: 1, error: error instanceof Error ? error.message : "Price refresh failed" }, { status: 422 });
    }
  }

  const linked = await db.select().from(products).where(or(isNotNull(products.tcgplayerId), isNotNull(products.tcgplayerUrl)));
  let updated = 0;
  let failed = 0;
  for (const product of linked.filter(product => product.priceSource !== "manual").slice(0, 100)) {
    try { await refreshProduct(product); updated += 1; }
    catch { failed += 1; }
  }
  return Response.json({ checked: linked.length, updated, failed, note: failed ? "Some products need a set name or TCGplayer ID before they can sync." : undefined });
}