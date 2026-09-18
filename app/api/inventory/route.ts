import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { inventoryMovements, products } from "../../../db/schema";
import { getAuthorizedSession } from "@/lib/auth/authorization";
import {
  directProductImageUrl,
  tcgplayerImageUrl,
  tcgplayerProductIdFromUrl,
  tcgplayerProductUrl,
} from "@/lib/catalog-image";
import { findExactCatalogMatch } from "@/lib/catalog-match";
import { canonicalizeGame } from "@/lib/tcg-games";
import { matchCatalogProduct, sameProductIdentity } from "@/lib/inventory-identity";
import { managedPricingIdentityGuard, pricingIdentityMatches, protectedPricingColumns, saveScrydexQuote } from "@/lib/pricing-storage";
import { SCRYDEX_PRICE_SOURCE, samePricingIdentity, scrydexSellPriceCents, type StoredPricing } from "@/lib/pricing-policy";
import { resolveScrydexPrice } from "@/lib/scrydex";
import {
  catalogProductSku,
  importedProductSku,
  manualProductSku,
  validateSku,
} from "@/lib/product-sku";

type ProductInput = {
  sku?: string;
  barcode?: string;
  tcgplayerId?: number | null;
  tcgplayerUrl?: string;
  directImageUrl?: string;
  name?: string;
  productType?: "Single" | "Sealed";
  game?: string;
  setName?: string;
  cardNumber?: string;
  rarity?: string;
  condition?: string;
  finish?: string;
  quantity?: number;
  costCents?: number;
  marketPriceCents?: number;
  listPriceCents?: number;
  location?: string;
  lowStockThreshold?: number;
  priceSource?: string;
  skuAutoManaged?: boolean;
  skuWasExplicit?: boolean;
  legacySkuCandidates?: string[];
};

function cleanText(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, 300) : fallback;
}

function cleanInt(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function cleanHttpsUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString().slice(0, 2_000) : null;
  } catch {
    return null;
  }
}

function valuesFrom(input: ProductInput, resolvedSku?: string) {
  const sku = validateSku(resolvedSku ?? input.sku);
  const name = cleanText(input.name);
  if (!sku || !name) throw new Error("SKU and product name are required");
  const productType = input.productType === "Sealed" ? "Sealed" : "Single";
  const tcgplayerUrl = cleanHttpsUrl(input.tcgplayerUrl);
  const linkedProductId = tcgplayerProductIdFromUrl(tcgplayerUrl);
  const incomingPriceSource = cleanText(input.priceSource, "manual") || "manual";
  return {
    sku,
    barcode: cleanText(input.barcode) || null,
    tcgplayerId: input.tcgplayerId
      ? cleanInt(input.tcgplayerId)
      : linkedProductId,
    tcgplayerUrl,
    name,
    productType,
    game: canonicalizeGame(input.game),
    setName: cleanText(input.setName),
    cardNumber: cleanText(input.cardNumber),
    rarity: cleanText(input.rarity),
    condition: cleanText(input.condition),
    finish: cleanText(input.finish),
    quantity: Math.max(0, cleanInt(input.quantity)),
    costCents: Math.max(0, cleanInt(input.costCents)),
    marketPriceCents: Math.max(0, cleanInt(input.marketPriceCents)),
    listPriceCents: Math.max(0, cleanInt(input.listPriceCents)),
    location: cleanText(input.location, "UNASSIGNED").toUpperCase() || "UNASSIGNED",
    lowStockThreshold: Math.max(0, cleanInt(input.lowStockThreshold, 2)),
    // Only the authenticated server-side quote path can assign this source.
    priceSource: incomingPriceSource.toLowerCase().startsWith(SCRYDEX_PRICE_SOURCE) ? "manual" : incomingPriceSource,
    priceUpdatedAt: input.marketPriceCents ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString(),
  } as const;
}

export const dynamic = "force-dynamic";
export const maxDuration = 30;

class PricingConflictError extends Error {}

function unchangedProduct(current: typeof products.$inferSelect) {
  return and(
    eq(products.id, current.id),
    eq(products.updatedAt, current.updatedAt),
    eq(products.priceSource, current.priceSource),
    pricingIdentityMatches(current),
  );
}

async function pricingForIdentityChange(current: typeof products.$inferSelect, next: Parameters<typeof resolveScrydexPrice>[0]): Promise<StoredPricing | null> {
  if (current.priceSource !== SCRYDEX_PRICE_SOURCE || samePricingIdentity(current, { ...next, tcgplayerId: next.tcgplayerId ?? null })) return null;
  try {
    const quote = await resolveScrydexPrice(next);
    return {
      marketPriceCents: quote.cents,
      listPriceCents: scrydexSellPriceCents(quote.cents),
      priceSource: SCRYDEX_PRICE_SOURCE,
      priceUpdatedAt: new Date().toISOString(),
    };
  } catch (error) {
    throw new PricingConflictError(`The product details were not changed: ${error instanceof Error ? error.message : "Scrydex could not verify a price for the new identity."}`);
  }
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected inventory error";
  if (message.includes("no such table")) return "Inventory storage is still initializing. Refresh in a moment.";
  if (isUniqueViolation(error)) return "That SKU already exists. Choose a different SKU.";
  return message;
}

function isUniqueViolation(error: unknown) {
  const value = error as { code?: string; message?: string; cause?: { code?: string } };
  return value?.code === "23505" || value?.cause?.code === "23505" ||
    /duplicate key|unique constraint/i.test(value?.message || "");
}

function statusFor(error: unknown) {
  if (error instanceof PricingConflictError) return 409;
  return isUniqueViolation(error) || /SKU cannot be changed|already exists as/i.test(errorMessage(error))
    ? 409
    : /required|Code 39|characters or fewer/i.test(errorMessage(error)) ? 400 : 500;
}

function nextManualSequence(existingSkus: Iterable<string>, game: string) {
  const prefix = manualProductSku(game, 1).replace(/000001$/, "");
  let largest = 0;
  const pattern = new RegExp(`^${prefix}(\\d{6})$`, "i");
  for (const sku of existingSkus) {
    const match = pattern.exec(sku);
    if (match) largest = Math.max(largest, Number(match[1]));
  }
  return largest + 1;
}

function withImage<T extends { tcgplayerId: number | null; sku: string }>(product: T) {
  const linked = product as T & { tcgplayerUrl?: string | null };
  return {
    ...product,
    imageUrl: tcgplayerImageUrl(linked.tcgplayerId, linked.tcgplayerUrl),
  };
}

async function requireExactImageLink(input: ProductInput, row: ReturnType<typeof valuesFrom>) {
  if (row.tcgplayerId) {
    return {
      ...row,
      tcgplayerUrl: tcgplayerProductUrl(row.tcgplayerId, row.tcgplayerUrl),
      imageMatch: null,
    };
  }
  const directImage = directProductImageUrl(input.directImageUrl || row.tcgplayerUrl);
  if (directImage) {
    return { ...row, tcgplayerUrl: directImage, imageMatch: null };
  }
  const match = await findExactCatalogMatch({
    name: row.name,
    game: row.game,
    setName: row.setName,
  });
  if (!match) {
    throw new Error(
      `Defy could not verify an exact picture for “${row.name}”. Add its exact TCGplayer ID or paste its exact product image URL.`,
    );
  }
  return {
    ...row,
    tcgplayerId: match.productId,
    tcgplayerUrl: match.productUrl,
    imageMatch: match,
  };
}

export async function GET() {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const db = getDb();
    const inventory = await db.select().from(products).orderBy(desc(products.updatedAt), desc(products.id));
    return Response.json({ products: inventory.map(withImage) });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const payload = await request.json() as {
      action?: "create" | "adjust" | "import" | "delete" | "update" | "linkImage";
      product?: ProductInput;
      products?: ProductInput[];
      id?: number;
      delta?: number;
      reason?: string;
    };
    const db = getDb();

    if (payload.action === "create" && payload.product) {
      const game = canonicalizeGame(payload.product.game);
      const existing = await db.select().from(products);
      const suppliedTcgplayerId = cleanInt(payload.product.tcgplayerId) || null;
      const catalogExisting = suppliedTcgplayerId
        ? matchCatalogProduct(existing, { ...payload.product, game, name: cleanText(payload.product.name), tcgplayerId: suppliedTcgplayerId })
        : null;
      if (catalogExisting)
        throw new Error(`That catalog product already exists as ${catalogExisting.sku}; use its stock controls instead.`);

      const autoManaged = payload.product.skuAutoManaged || !cleanText(payload.product.sku);
      const sequence = nextManualSequence(existing.map((product) => product.sku), game);
      let product: (typeof existing)[number] | undefined;
      let imageMatch: { matchedName?: string } | null | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const sku = autoManaged
          ? suppliedTcgplayerId
            ? catalogProductSku(game, suppliedTcgplayerId)
            : manualProductSku(game, sequence + attempt)
          : validateSku(payload.product.sku);
        const resolved = await requireExactImageLink(
          { ...payload.product, game },
          valuesFrom({ ...payload.product, game }, sku),
        );
        const { imageMatch: matched, ...input } = resolved;
        imageMatch = matched;
        try {
          [product] = await db.insert(products).values(input).returning();
          break;
        } catch (error) {
          if (!isUniqueViolation(error) || !autoManaged || suppliedTcgplayerId || attempt === 7) throw error;
        }
      }
      if (!product) throw new Error("Could not allocate a unique SKU. Try again.");
      const inputQuantity = product.quantity;
      if (inputQuantity) await db.insert(inventoryMovements).values({ productId: product.id, delta: inputQuantity, reason: "received", note: "Initial quantity" });
      return Response.json(
        { product: withImage(product), imageMatch },
        { status: 201 },
      );
    }

    if (payload.action === "adjust") {
      const id = cleanInt(payload.id);
      const delta = cleanInt(payload.delta);
      if (!id || !delta) return Response.json({ error: "Product and quantity change are required" }, { status: 400 });
      const [current] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      if (!current) return Response.json({ error: "Product not found" }, { status: 404 });
      const nextQuantity = Math.max(0, current.quantity + delta);
      const appliedDelta = nextQuantity - current.quantity;
      const [product] = await db.update(products).set({ quantity: nextQuantity, updatedAt: new Date().toISOString() }).where(eq(products.id, id)).returning();
      if (appliedDelta) await db.insert(inventoryMovements).values({ productId: id, delta: appliedDelta, reason: cleanText(payload.reason, appliedDelta > 0 ? "received" : "sold") });
      return Response.json({ product: withImage(product) });
    }

    if (payload.action === "update" && payload.product && payload.id) {
      const id = cleanInt(payload.id);
      const [current] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      if (!current) return Response.json({ error: "Product not found" }, { status: 404 });
      if (validateSku(payload.product.sku) !== current.sku)
        return Response.json({ error: "SKU cannot be changed after product creation. Existing labels and sales history keep using it." }, { status: 409 });
      const next = valuesFrom(payload.product, current.sku);
      const quotedPricing = await pricingForIdentityChange(current, next);
      const product = quotedPricing ? await saveScrydexQuote(current, quotedPricing.marketPriceCents, next) : (await db.update(products).set({
        ...next,
        ...protectedPricingColumns(next),
        updatedAt: new Date().toISOString(),
      }).where(unchangedProduct(current)).returning())[0];
      if (!product) throw new PricingConflictError("This product changed during the update. Reload inventory and try again.");
      return Response.json({ product: withImage(product) });
    }

    if (payload.action === "linkImage" && payload.product && payload.id) {
      const id = cleanInt(payload.id);
      const tcgplayerId = cleanInt(payload.product.tcgplayerId);
      const directImage = directProductImageUrl(payload.product.directImageUrl);
      if (!tcgplayerId && !directImage) {
        return Response.json(
          { error: "Enter an exact TCGplayer ID or exact product image URL" },
          { status: 400 },
        );
      }
      const [current] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      if (!current) return Response.json({ error: "Product not found" }, { status: 404 });
      const identity = {
        ...current,
        tcgplayerId: tcgplayerId || null,
        tcgplayerUrl: tcgplayerId ? tcgplayerProductUrl(tcgplayerId) : directImage,
      };
      const quotedPricing = await pricingForIdentityChange(current, identity);
      const product = quotedPricing ? await saveScrydexQuote(current, quotedPricing.marketPriceCents, {
        tcgplayerId: identity.tcgplayerId, tcgplayerUrl: identity.tcgplayerUrl,
      }) : (await db
        .update(products)
        .set({
          tcgplayerId: identity.tcgplayerId,
          tcgplayerUrl: identity.tcgplayerUrl,
          updatedAt: new Date().toISOString(),
        })
        .where(unchangedProduct(current))
        .returning())[0];
      if (!product) throw new PricingConflictError("This product changed during the image update. Reload inventory and try again.");
      return Response.json({ product: withImage(product) });
    }

    if (payload.action === "delete" && payload.id) {
      const id = cleanInt(payload.id);
      const [product] = await db.select({ id: products.id }).from(products).where(eq(products.id, id)).limit(1);
      if (!product) return Response.json({ error: "Product not found" }, { status: 404 });
      await db.delete(products).where(eq(products.id, id));
      return Response.json({ ok: true });
    }

    if (payload.action === "import" && Array.isArray(payload.products)) {
      const existing = await db.select().from(products);
      const existingBySku = new Map(existing.map((product) => [product.sku.toUpperCase(), product]));
      const rows: Array<ReturnType<typeof valuesFrom>> = [];
      for (const productInput of payload.products.slice(0, 5000)) {
        const game = canonicalizeGame(productInput.game);
        const explicitSku = productInput.skuWasExplicit || Boolean(cleanText(productInput.sku));
        let current = explicitSku ? existingBySku.get(validateSku(productInput.sku)) : undefined;
        if (!current) {
          for (const legacy of productInput.legacySkuCandidates || []) {
            const legacyMatch = existingBySku.get(cleanText(legacy).toUpperCase());
            if (legacyMatch) { current = legacyMatch; break; }
          }
        }
        if (!current && productInput.tcgplayerId)
          current = matchCatalogProduct(existing, { ...productInput, game, name: cleanText(productInput.name) }) || undefined;

        let resolvedSku = current?.sku;
        if (!resolvedSku && explicitSku) resolvedSku = validateSku(productInput.sku);
        if (!resolvedSku) {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const candidate = importedProductSku({ ...productInput, game, name: cleanText(productInput.name) }, attempt);
            const occupied = existingBySku.get(candidate);
            if (!occupied) { resolvedSku = candidate; break; }
            if (sameProductIdentity(occupied, { ...productInput, game, name: cleanText(productInput.name) })) {
              current = occupied;
              resolvedSku = occupied.sku;
              break;
            }
          }
        }
        if (!resolvedSku) throw new Error(`Could not allocate a unique SKU for ${cleanText(productInput.name)}`);
        const row = valuesFrom({ ...productInput, game }, resolvedSku);
        let linkedRow: ReturnType<typeof valuesFrom>;
        if (!row.tcgplayerId && !row.tcgplayerUrl && current && (current.tcgplayerId || current.tcgplayerUrl)) {
          linkedRow = {
            ...row,
            tcgplayerId: current.tcgplayerId,
            tcgplayerUrl: current.tcgplayerUrl,
          };
        } else if (!row.tcgplayerId && !row.tcgplayerUrl) {
          const { imageMatch: _imageMatch, ...linked } = await requireExactImageLink(productInput, row);
          void _imageMatch;
          linkedRow = linked;
        } else {
          const { imageMatch: _imageMatch, ...linked } = await requireExactImageLink(productInput, row);
          void _imageMatch;
          linkedRow = linked;
        }
        if (current?.priceSource === SCRYDEX_PRICE_SOURCE && !samePricingIdentity(current, linkedRow)) {
          throw new PricingConflictError(`CSV import cannot change the Scrydex-priced identity of ${current.sku}. Update that product with a verified quote first. No CSV rows were imported.`);
        }
        rows.push(linkedRow);
        existingBySku.set(linkedRow.sku, current || ({ ...linkedRow, id: -rows.length } as (typeof existing)[number]));
      }
      let imported = 0;
      for (const row of rows) {
        const applied = await db.insert(products).values(row).onConflictDoUpdate({
          target: products.sku,
          set: {
            barcode: row.barcode,
            tcgplayerId: row.tcgplayerId,
            tcgplayerUrl: row.tcgplayerUrl,
            name: row.name,
            productType: row.productType,
            game: row.game,
            setName: row.setName,
            cardNumber: row.cardNumber,
            rarity: row.rarity,
            condition: row.condition,
            finish: row.finish,
            quantity: row.quantity,
            costCents: row.costCents,
            ...protectedPricingColumns(row),
            location: row.location,
            lowStockThreshold: row.lowStockThreshold,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          },
          setWhere: managedPricingIdentityGuard(row),
        }).returning({ id: products.id });
        if (!applied.length) {
          return Response.json({ imported, error: `Import stopped after ${imported} rows because ${row.sku} acquired a different Scrydex-priced identity. Reload inventory and review the remaining CSV rows.` }, { status: 409 });
        }
        imported++;
      }
      return Response.json({ imported });
    }

    return Response.json({ error: "Unsupported inventory action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: statusFor(error) });
  }
}
