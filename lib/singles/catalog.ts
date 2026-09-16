import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Catalog, CatalogCard } from "./types.ts";

export type SourceGroup = { groupId: number; categoryId: number; name: string; abbreviation?: string; publishedOn?: string };
export type SourceProduct = {
  productId: number; categoryId: number; groupId: number; name: string;
  imageUrl?: string; url?: string;
  presaleInfo?: { isPresale?: boolean; releasedOn?: string | null };
  extendedData?: Array<{ name: string; value: string }>;
};
export type SourcePrice = { productId: number; subTypeName: string; marketPrice: number | null };
export type CatalogSource = {
  sourceUpdatedAt: string;
  fetchedAt: string;
  groups: Array<{ group: SourceGroup; products: SourceProduct[]; prices: SourcePrice[] }>;
};
export type CatalogSnapshot = Catalog & {
  source: string;
  categoryId: number;
  stats: {
    groupsFetched: number; productsFetched: number; includedProducts: number;
    includedVariants: number; includedSets: number;
    finishes: Record<string, number>;
    exclusions: Record<string, number>;
  };
  excludedProducts: Array<{ productId: number; name: string; setName: string; reason: string }>;
};

function sourceField(product: SourceProduct, ...names: string[]) {
  return product.extendedData?.find((entry) => names.some((name) => entry.name.toLowerCase() === name.toLowerCase()))?.value.trim() || "";
}

function nonEnglishLabel(text: string) {
  return /\b(?:Chinese|Japanese|Korean|French|German|Spanish|Italian|Portuguese|Simplified|Traditional)\b|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/i.test(text);
}

/** Only source-supplied finishes become selectable variants; missing finishes are never guessed. */
export function buildRiftboundCatalog(source: CatalogSource): CatalogSnapshot {
  if (!Number.isFinite(Date.parse(source.sourceUpdatedAt)) || !Number.isFinite(Date.parse(source.fetchedAt)))
    throw new Error("Catalog source timestamps are invalid");
  const cards: CatalogCard[] = [];
  const keys = new Set<string>();
  const excludedProducts: CatalogSnapshot["excludedProducts"] = [];
  const exclusions: Record<string, number> = {};
  let productsFetched = 0;
  for (const { group, products, prices } of source.groups) {
    const byProduct = new Map<number, SourcePrice[]>();
    for (const price of prices) {
      const list = byProduct.get(price.productId) || [];
      list.push(price);
      byProduct.set(price.productId, list);
    }
    for (const product of products) {
      productsFetched += 1;
      const number = sourceField(product, "Number", "Card Number");
      const rarity = sourceField(product, "Rarity");
      const cardType = sourceField(product, "Card Type");
      const language = sourceField(product, "Language");
      const variants = (byProduct.get(product.productId) || []).filter((price) => price.subTypeName?.trim());
      let reason = "";
      if (group.categoryId !== 89 || product.categoryId !== 89 || product.groupId !== group.groupId) reason = "wrongCategoryOrGroup";
      else if (!Number.isSafeInteger(product.productId) || product.productId < 1 || !product.name.trim()) reason = "invalidIdentity";
      else if (nonEnglishLabel(`${group.name} ${product.name}`) || (language && !/^(english|en)$/i.test(language))) reason = "nonEnglish";
      else if (product.presaleInfo?.isPresale === true || (product.presaleInfo?.releasedOn && Date.parse(product.presaleInfo.releasedOn) > Date.parse(source.fetchedAt))) reason = "presale";
      else if (!number && !rarity && !cardType) reason = "sealedOrNonCard";
      else if (!variants.length) reason = "missingFinish";
      if (reason) {
        exclusions[reason] = (exclusions[reason] || 0) + 1;
        excludedProducts.push({ productId: product.productId, name: product.name, setName: group.name, reason });
        continue;
      }
      for (const variant of variants) {
        const finish = variant.subTypeName.trim();
        const key = `${product.productId}:${finish}`;
        if (keys.has(key)) throw new Error(`Duplicate catalog variant: ${key}`);
        keys.add(key);
        cards.push({
          key, productId: product.productId, groupId: group.groupId,
          name: product.name.trim(), setName: group.name, setCode: group.abbreviation || "",
          number, rarity, finish, language: "English",
          imageUrl: product.imageUrl || "", productUrl: product.url || `https://www.tcgplayer.com/product/${product.productId}`,
          marketCents: typeof variant.marketPrice === "number" && Number.isFinite(variant.marketPrice) && variant.marketPrice >= 0
            ? Math.round(variant.marketPrice * 100) : null,
        });
      }
    }
  }
  cards.sort((left, right) => left.setName.localeCompare(right.setName) || left.number.localeCompare(right.number, "en", { numeric: true }) || left.name.localeCompare(right.name) || left.finish.localeCompare(right.finish));
  const finishes: Record<string, number> = {};
  for (const card of cards) finishes[card.finish] = (finishes[card.finish] || 0) + 1;
  return {
    source: "https://tcgcsv.com/tcgplayer/89", categoryId: 89,
    sourceUpdatedAt: source.sourceUpdatedAt, fetchedAt: source.fetchedAt,
    cards,
    warnings: [
      "English inventory only. TCGCSV has no per-SKU language data; English is the intake scope, not a verified language attribute. Check your physical card and its image before receiving it. Explicit non-English listings are excluded.",
      "This is a dated TCGCSV/TCGplayer catalog snapshot, not a guarantee of every released card, alternate art, promo, or finish. Only source-listed finishes are included; presales, sealed products, and entries without a known finish are excluded.",
      "Market prices are reference USD prices from the source snapshot, not live prices or condition-specific valuations. Cards without a number must be identified by Product ID in CSV imports.",
      `Excluded products: ${Object.entries(exclusions).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}.`,
    ],
    stats: { groupsFetched: source.groups.length, productsFetched, includedProducts: new Set(cards.map((card) => card.productId)).size, includedVariants: cards.length, includedSets: new Set(cards.map((card) => card.groupId)).size, finishes, exclusions },
    excludedProducts,
  };
}

let cachedCatalog: Promise<CatalogSnapshot> | undefined;
/** Read the bundled snapshot only. Refreshing is a separate operator-run script. */
export async function readRiftboundCatalog(): Promise<CatalogSnapshot> {
  cachedCatalog ??= readFile(path.join(process.cwd(), "data", "riftbound-catalog.json"), "utf8")
    .then((contents) => JSON.parse(contents) as CatalogSnapshot)
    .catch((error: unknown) => { cachedCatalog = undefined; throw error; });
  return cachedCatalog;
}

export function searchCatalog(catalog: Catalog, input: { query: string; set?: string }): CatalogCard[] {
  const normalize = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const terms = normalize(input.query).split(/\s+/).filter(Boolean);
  const selectedSet = (input.set || "").trim().toLowerCase();
  return catalog.cards.filter((card) => {
    if (selectedSet && ![card.setName.toLowerCase(), card.setCode.toLowerCase(), String(card.groupId)].includes(selectedSet)) return false;
    const searchable = normalize(`${card.name} ${card.number} ${card.setName} ${card.setCode} ${card.rarity} ${card.finish} ${card.productId}`);
    return terms.every((term) => searchable.includes(term));
  });
}
