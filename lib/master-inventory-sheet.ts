import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { inventoryMovements, products } from "../db/schema";
import { findExactCatalogMatch } from "@/lib/catalog-match";
import { gameFromAlias, inferGameFromName, type TcgGameName } from "@/lib/tcg-games";
import { isMasterSheetManagedProduct, matchMasterSheetProducts } from "@/lib/master-inventory-policy";
import { sheetProductSku } from "@/lib/product-sku";
import { SCRYDEX_PRICE_SOURCE, preserveScrydexPricing } from "@/lib/pricing-policy";
import { protectedPricingColumns, protectedSheetIdentityColumns } from "@/lib/pricing-storage";

const MASTER_SHEET_ID = "1KDj1xuxf6JFoLp-_CZZeRnbZWe4bAq78DYeNqPSid0k";
const INVENTORY_GID = "206164464";
export const MASTER_SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${MASTER_SHEET_ID}/export?format=csv&gid=${INVENTORY_GID}`;

type SheetProduct = {
  name: string;
  game: TcgGameName | null;
  gameReliable: boolean;
  setName: string;
  quantity: number;
  costCents: number;
  marketPriceCents: number;
};

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function money(value: string | undefined) {
  return Number(String(value ?? "").replace(/[$,]/g, "")) || 0;
}

function canonicalName(value: string) {
  const name = value.trim();
  if (/^Riftbound Unleashed Boster Box$/i.test(name))
    return "Riftbound: Unleashed Booster Display";
  if (/^Riftbound Origins Booster Box$/i.test(name))
    return "Riftbound: Origins Booster Display";
  if (/^One PIece Carrying his Will OP-13 Booster Box$/i.test(name))
    return "One Piece Carrying His Will OP-13 Booster Box";
  if (/^Gundam Freedom Ascension GD-05 Booster Box/i.test(name))
    return "Gundam Freedom Ascension GD-05 Booster Box";
  return name;
}

function productKey(value: string) {
  return canonicalName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function setFor(name: string) {
  const sets: Array<[string, RegExp]> = [
    ["151", /^(151|Pokemon 151)/i],
    ["Prismatic Evolutions", /^Prismatic/i],
    ["Chaos Rising", /^Chaos Rising/i],
    ["Perfect Order", /^Perfect Order/i],
    ["Journey Together", /^Journey Together/i],
    ["Mega Evolution", /^(Mega Evolution|Mega Gardevoir)/i],
    ["Pitch Black", /^Pitch Black/i],
    ["Ascended Heroes", /^Ascended Heroes/i],
    ["Paldean Fates", /^Paldean Fates/i],
    ["Black Bolt & White Flare", /^Black Bolt & White Flare/i],
    ["The First Chapter", /^Lorcana:.*First Chapter/i],
    ["Unleashed", /^Riftbound: Unleashed/i],
    ["Origins", /^Riftbound: Origins/i],
    ["Freedom Ascension", /^Gundam Freedom Ascension/i],
    ["Phantom Aria", /^Gundam Phantom Aria/i],
    ["Steel Requiem", /^Gundam Steel Requiem/i],
    ["Time of Battle", /^One Piece Time of Battle/i],
    ["Carrying His Will", /^One Piece Carrying His Will/i],
    ["Secrets of Strixhaven", /Secrets of Strixhaven/i],
    [
      "The Lord of the Rings: Tales of Middle-earth",
      /^The Lord of the Rings:/i,
    ],
    ["Foundations", /^Magic: Foundations/i],
    ["Cross Force", /^Dragon Ball Z: Cross Force/i],
  ];
  return sets.find(([, pattern]) => pattern.test(name))?.[0] ?? "";
}

export function parseMasterInventoryCsv(text: string) {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header?.[0]?.toLowerCase().includes("business purchase"))
    throw new Error("The Inventory tab format was not recognized");
  const stopIndex = rows.findIndex(
    (row) => row[0]?.trim() === "Sold and Owed (TCGplayer)",
  );
  const inventoryRows = rows
    .slice(0, stopIndex >= 0 ? stopIndex : rows.length)
    .filter((row) => row[0]?.trim() && Number(row[1]) > 0);
  const normalizedHeaders = header.map((cell) => cell.trim().toLowerCase());
  const gameColumn = normalizedHeaders.findIndex((cell) =>
    ["game", "product line", "product game"].includes(cell),
  );
  const consolidated = new Map<
    string,
    { name: string; game: TcgGameName | null; gameReliable: boolean; quantity: number; costTotal: number; marketTotal: number }
  >();
  for (const row of inventoryRows) {
    const name = canonicalName(row[0]);
    const explicitRaw = gameColumn >= 0 ? row[gameColumn]?.trim() || "" : "";
    const explicitGame = explicitRaw ? gameFromAlias(explicitRaw)?.name ?? null : null;
    const inferredGame = explicitRaw ? null : inferGameFromName(name);
    const game = explicitGame || inferredGame;
    const gameReliable = Boolean(game);
    const key = `${game || "unclassified"}|${productKey(name)}`;
    const quantity = Math.max(0, Math.round(Number(row[1]) || 0));
    const current = consolidated.get(key) ?? {
      name,
      game,
      gameReliable,
      quantity: 0,
      costTotal: 0,
      marketTotal: 0,
    };
    current.quantity += quantity;
    current.costTotal += money(row[5]) * quantity;
    current.marketTotal += money(row[7]) * quantity;
    consolidated.set(key, current);
  }
  const products: SheetProduct[] = [...consolidated.values()].map((item) => ({
    name: item.name,
    game: item.game,
    gameReliable: item.gameReliable,
    setName: setFor(item.name),
    quantity: item.quantity,
    costCents: Math.max(0, Math.round((item.costTotal / item.quantity) * 100)),
    marketPriceCents: Math.max(
      0,
      Math.round((item.marketTotal / item.quantity) * 100),
    ),
  }));
  if (!products.length)
    throw new Error("No inventory products were found in the master sheet");
  return { sourceRows: inventoryRows.length, products };
}

export async function syncMasterInventorySheet() {
  const response = await fetch(MASTER_SHEET_CSV_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok)
    throw new Error(`Google Sheets returned ${response.status}`);
  const parsed = parseMasterInventoryCsv(await response.text());
  const db = getDb();
  const currentProducts = await db.select().from(products);
  const sortMatches = (matches: (typeof currentProducts)[number][]) =>
    matches.sort((left, right) => {
      const leftIsLegacySheetSku = left.sku.startsWith("DEFY-SHEET-");
      const rightIsLegacySheetSku = right.sku.startsWith("DEFY-SHEET-");
      if (leftIsLegacySheetSku !== rightIsLegacySheetSku)
        return leftIsLegacySheetSku ? 1 : -1;
      return left.id - right.id;
    });
  const knownProducts = [...currentProducts];
  const usedSkus = new Set(currentProducts.map((product) => product.sku.toUpperCase()));
  const matchedProductIds = new Set<number>();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let deduplicated = 0;
  let retired = 0;
  const createdSkus: string[] = [];
  const needsImage: string[] = [];
  const needsGame: string[] = [];
  const now = new Date().toISOString();

  for (const sheetProduct of parsed.products) {
    const matches = sortMatches(matchMasterSheetProducts(knownProducts, sheetProduct));
    const current = matches[0];
    if (!current) {
      if (!sheetProduct.gameReliable || !sheetProduct.game) {
        needsGame.push(sheetProduct.name);
        continue;
      }
      const imageMatch = await findExactCatalogMatch({
        name: sheetProduct.name,
        game: sheetProduct.game,
        setName: sheetProduct.setName,
      });
      if (!imageMatch) {
        needsImage.push(sheetProduct.name);
        continue;
      }
      let sku = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = sheetProductSku({ ...sheetProduct, game: sheetProduct.game }, attempt);
        if (!usedSkus.has(candidate)) { sku = candidate; break; }
      }
      if (!sku) throw new Error(`Could not allocate a unique sheet SKU for ${sheetProduct.name}`);
      const [inserted] = await db.insert(products).values({
          sku,
          tcgplayerId: imageMatch.productId,
          tcgplayerUrl: imageMatch.productUrl,
          name: sheetProduct.name,
          productType: "Sealed",
          game: sheetProduct.game,
          setName: sheetProduct.setName,
          quantity: sheetProduct.quantity,
          sheetQuantity: sheetProduct.quantity,
          costCents: sheetProduct.costCents,
          marketPriceCents: sheetProduct.marketPriceCents,
          listPriceCents: sheetProduct.marketPriceCents,
          location: "UNASSIGNED",
          lowStockThreshold: 2,
          priceSource: "master-sheet",
          priceUpdatedAt: sheetProduct.marketPriceCents ? now : null,
          updatedAt: now,
        }).returning();
      if (inserted.quantity)
        await db
          .insert(inventoryMovements)
          .values({
            productId: inserted.id,
            delta: inserted.quantity,
            reason: "master sheet sync",
            note: "New spreadsheet product",
          });
      knownProducts.push(inserted);
      usedSkus.add(sku);
      matchedProductIds.add(inserted.id);
      created += 1;
      createdSkus.push(sku);
      continue;
    }

    for (const match of matches) matchedProductIds.add(match.id);

    for (const duplicate of matches.slice(1)) {
      if (duplicate.quantity === 0 && duplicate.sheetQuantity === 0) continue;
      await db
        .update(products)
        .set({ quantity: 0, sheetQuantity: 0, updatedAt: now })
        .where(eq(products.id, duplicate.id));
      if (duplicate.quantity)
        await db.insert(inventoryMovements).values({
          productId: duplicate.id,
          delta: -duplicate.quantity,
          reason: "master sheet reconciliation",
          note: `Duplicate of ${current.sku}; tracker count is held on one SKU`,
        });
      deduplicated += 1;
    }

    const incomingMarketChanged = current.marketPriceCents !== sheetProduct.marketPriceCents;
    const incomingListPriceCents =
      current.listPriceCents === 0 ||
      current.listPriceCents === current.marketPriceCents
        ? sheetProduct.marketPriceCents
        : current.listPriceCents;
    const pricing = preserveScrydexPricing(current, {
      marketPriceCents: sheetProduct.marketPriceCents,
      listPriceCents: incomingListPriceCents,
      priceSource: incomingMarketChanged ? "master-sheet" : current.priceSource,
      priceUpdatedAt: incomingMarketChanged ? now : current.priceUpdatedAt,
    });
    const previousSheetQuantity = current.sheetQuantity ?? sheetProduct.quantity;
    const sheetDelta = sheetProduct.quantity - previousSheetQuantity;
    const nextQuantity = Math.max(0, current.quantity + sheetDelta);
    const resolvedGame = sheetProduct.gameReliable && sheetProduct.game
      ? sheetProduct.game
      : current.game;
    const incomingIdentity = { name: sheetProduct.name, game: resolvedGame, setName: sheetProduct.setName };
    const identity = current.priceSource === SCRYDEX_PRICE_SOURCE ? current : incomingIdentity;
    const changed =
      current.name !== identity.name ||
      current.game !== identity.game ||
      current.setName !== identity.setName ||
      current.sheetQuantity !== sheetProduct.quantity ||
      nextQuantity !== current.quantity ||
      current.costCents !== sheetProduct.costCents ||
      current.marketPriceCents !== pricing.marketPriceCents ||
      current.listPriceCents !== pricing.listPriceCents;
    if (!changed) {
      unchanged += 1;
      continue;
    }
    await db
      .update(products)
      .set({
        ...protectedSheetIdentityColumns(incomingIdentity),
        quantity: nextQuantity,
        sheetQuantity: sheetProduct.quantity,
        costCents: sheetProduct.costCents,
        ...protectedPricingColumns(pricing),
        updatedAt: now,
      })
      .where(eq(products.id, current.id));
    const appliedDelta = nextQuantity - current.quantity;
    if (appliedDelta)
      await db
        .insert(inventoryMovements)
        .values({
          productId: current.id,
          delta: appliedDelta,
          reason: "master sheet reconciliation",
          note: `Tracker changed ${previousSheetQuantity} → ${sheetProduct.quantity}`,
        });
    updated += 1;
  }

  for (const product of currentProducts) {
    if (matchedProductIds.has(product.id)) continue;
    const wasSheetManaged = isMasterSheetManagedProduct(product);
    if (!wasSheetManaged || (product.quantity === 0 && product.sheetQuantity === 0))
      continue;
    const previousSheetQuantity = product.sheetQuantity ?? 0;
    const nextQuantity = Math.max(0, product.quantity - previousSheetQuantity);
    await db
      .update(products)
      .set({ quantity: nextQuantity, sheetQuantity: 0, updatedAt: now })
      .where(eq(products.id, product.id));
    const appliedDelta = nextQuantity - product.quantity;
    if (appliedDelta)
      await db.insert(inventoryMovements).values({
        productId: product.id,
        delta: appliedDelta,
        reason: "master sheet reconciliation",
        note: "Not present in the current inventory section",
      });
    retired += 1;
  }

  const [inventoryTotal] = await db
    .select({ units: sql<number>`coalesce(sum(${products.quantity}), 0)::int` })
    .from(products);

  return {
    syncedAt: now,
    sourceRows: parsed.sourceRows,
    products: parsed.products.length,
    units: Number(inventoryTotal?.units || 0),
    created,
    updated,
    unchanged,
    deduplicated,
    retired,
    createdSkus,
    needsImage,
    needsGame,
    deleted: 0,
  };
}
