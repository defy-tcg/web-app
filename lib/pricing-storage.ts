import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { products } from "../db/schema";
import { SCRYDEX_PRICE_SOURCE, scrydexSellPriceCents, type PricingIdentity, type StoredPricing } from "./pricing-policy";
import { TCG_GAME_REGISTRY } from "./tcg-games";

// PostgreSQL btrim defaults to spaces; this is the whitespace set used by JS trim.
const JS_TRIM_CHARACTERS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

/** Save a quote and its history together, including identity-edit re-quotes. */
export async function saveScrydexQuote(current: typeof products.$inferSelect, marketCents: number, changes: Partial<typeof products.$inferInsert> = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  // Drizzle ignores undefined update fields, so preserve their current identity.
  const identity = {
    game: changes.game ?? current.game,
    productType: changes.productType ?? current.productType,
  };
  const update = db.update(products).set({
    ...changes,
    marketPriceCents: marketCents,
    listPriceCents: scrydexSellPriceCents(marketCents, identity),
    priceSource: SCRYDEX_PRICE_SOURCE,
    priceUpdatedAt: now,
    updatedAt: now,
  }).where(and(
    eq(products.id, current.id), eq(products.updatedAt, current.updatedAt),
    eq(products.priceSource, current.priceSource), pricingIdentityMatches(current),
  )).returning();
  const result = await db.execute<{ product: Record<string, unknown> }>(sql`
    WITH updated AS (${update.getSQL()}), history AS (
      INSERT INTO price_history (product_id, market_price_cents, source)
      SELECT id, ${marketCents}, ${SCRYDEX_PRICE_SOURCE} FROM updated
    ) SELECT row_to_json(updated) AS product FROM updated
  `);
  if (!result.rows.length) throw new Error("This product changed during the price lookup. Reload inventory and try again.");
  return Object.fromEntries(Object.entries(result.rows[0].product)
    .map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])) as typeof products.$inferSelect;
}

export function pricingIdentityMatches(incoming: PricingIdentity) {
  return sql<boolean>`${products.name} = ${incoming.name}
    AND ${products.game} = ${incoming.game}
    AND ${products.productType} = ${incoming.productType}
    AND ${products.setName} = ${incoming.setName}
    AND ${products.cardNumber} = ${incoming.cardNumber}
    AND ${products.condition} = ${incoming.condition}
    AND ${products.finish} = ${incoming.finish}
    AND ${products.tcgplayerId} IS NOT DISTINCT FROM ${incoming.tcgplayerId}`;
}

/** An import cannot assign a managed quote to a different identity, even after a race. */
export function managedPricingIdentityGuard(incoming: PricingIdentity) {
  return sql<boolean>`(${products.priceSource} <> ${SCRYDEX_PRICE_SOURCE} OR (${pricingIdentityMatches(incoming)}))`;
}

/** The master sheet can supply stock and cost while a verified printing stays fixed. */
export function protectedSheetIdentityColumns(incoming: Pick<PricingIdentity, "name" | "game" | "setName">) {
  return {
    name: sql<string>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN ${products.name} ELSE ${incoming.name} END`,
    game: sql<string>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN ${products.game} ELSE ${incoming.game} END`,
    setName: sql<string>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN ${products.setName} ELSE ${incoming.setName} END`,
  };
}

/** Evaluate at write time, including when a Scrydex refresh raced an import. */
export function protectedPricingColumns(incoming: StoredPricing) {
  // Match gameFromAlias's normalization against the identity stored at write time.
  // Imports may race a refresh and must not apply an incoming game's pricing rule.
  const gameKey = sql<string>`btrim(regexp_replace(replace(lower(regexp_replace(normalize(${products.game}, NFKD), '[\u0300-\u036f]', '', 'g')), '&', ' and '), '[^a-z0-9]+', ' ', 'g'))`;
  const riftbound = TCG_GAME_REGISTRY.find((game) => game.key === "riftbound")!;
  const eligible = and(
    inArray(gameKey, [...new Set([riftbound.key, riftbound.name.toLowerCase(), ...riftbound.aliases])]),
    sql`lower(btrim(${products.productType}, ${JS_TRIM_CHARACTERS})) = 'single'`,
  );
  return {
    marketPriceCents: sql<number>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN ${products.marketPriceCents} ELSE ${incoming.marketPriceCents} END`,
    listPriceCents: sql<number>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN CASE WHEN ${eligible} THEN round(${products.marketPriceCents}::numeric * 1.10)::integer ELSE ${products.marketPriceCents} END ELSE ${incoming.listPriceCents} END`,
    priceSource: sql<string>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN ${products.priceSource} ELSE ${incoming.priceSource} END`,
    priceUpdatedAt: sql<string>`CASE WHEN ${products.priceSource} = ${SCRYDEX_PRICE_SOURCE} THEN ${products.priceUpdatedAt} ELSE ${incoming.priceUpdatedAt} END`,
  };
}
