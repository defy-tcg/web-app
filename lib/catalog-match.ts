import { tcgplayerImageUrl } from "@/lib/catalog-image";
import { tcgplayerCategoryIdForGame } from "@/lib/tcg-games";

type CatalogGroup = { groupId: number; name: string };
type CatalogProduct = {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string;
  imageCount?: number;
  url?: string;
};
type CatalogResponse<T> = { success?: boolean; results?: T[] };

export type ExactCatalogMatch = {
  productId: number;
  productUrl: string;
  imageUrl: string;
  matchedName: string;
  groupName: string;
};

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/pok[eé]mon/g, "pokemon")
    .replace(/\bspc\b/g, "super premium collection")
    .replace(/\betb\b/g, "elite trainer box")
    .replace(/\bupc\b/g, "ultra premium collection")
    .replace(/\b3[ -]?pack\b/g, "three pack")
    .replace(/\bloose packs?\b|\bplay boosters?\b/g, "booster pack")
    .replace(/\bbooster displays?\b/g, "booster box")
    .replace(/\bcarrying his will\b/g, "carrying on his will")
    .replace(/\bex\b/g, "ex")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupKey(value: string) {
  return normalize(value)
    .replace(/^(sv\d*|me\d*|op\d+|gd\d+)\s+/, "")
    .trim();
}

function tokenScore(left: string, right: string) {
  const a = new Set(normalize(left).split(" ").filter(Boolean));
  const b = new Set(normalize(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

async function catalogFetch<T>(path: string) {
  const response = await fetch(`https://tcgcsv.com/tcgplayer/${path}`, {
    headers: {
      accept: "application/json",
      "user-agent": "DefyTCGStoreOS/1.2 (exact product image lookup)",
    },
    next: { revalidate: 86_400 },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`TCG catalog returned ${response.status}`);
  const body = (await response.json()) as CatalogResponse<T>;
  if (!Array.isArray(body.results)) throw new Error("TCG catalog was unavailable");
  return body.results;
}

function candidateGroups(groups: CatalogGroup[], name: string, setName: string) {
  const normalizedSet = groupKey(setName);
  if (normalizedSet) {
    return groups
      .map((group) => {
        const key = groupKey(group.name);
        const exact = key === normalizedSet;
        const contains = key.includes(normalizedSet) || normalizedSet.includes(key);
        return {
          group,
          score: exact ? 1 : contains ? 0.9 : tokenScore(normalizedSet, key),
        };
      })
      .filter((item) => item.score >= 0.72)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.group);
  }

  const normalizedName = normalize(name);
  const named = groups.filter((group) => {
    const key = groupKey(group.name);
    return key.length >= 5 && normalizedName.includes(key);
  });
  if (named.length) return named.slice(0, 2);

  return groups
    .filter((group) =>
      /miscellaneous cards & products|one piece promotion cards/i.test(
        group.name,
      ),
    )
    .slice(0, 1);
}

export async function findExactCatalogMatch(input: {
  name: string;
  game: string;
  setName?: string | null;
}) {
  const categoryId = tcgplayerCategoryIdForGame(input.game);
  if (!categoryId) return null;

  const groups = await catalogFetch<CatalogGroup>(`${categoryId}/groups`);
  const candidates = candidateGroups(
    groups,
    input.name,
    input.setName?.trim() || "",
  );
  if (!candidates.length) return null;

  const target = normalize(input.name);
  const exact: Array<{ product: CatalogProduct; group: CatalogGroup }> = [];
  for (const group of candidates) {
    const products = await catalogFetch<CatalogProduct>(
      `${categoryId}/${group.groupId}/products`,
    );
    for (const product of products) {
      if (normalize(product.name) === target || normalize(product.cleanName || "") === target) {
        exact.push({ product, group });
      }
    }
    if (candidates.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 110));
    }
  }

  const unique = new Map(
    exact.map((match) => [match.product.productId, match] as const),
  );
  if (unique.size !== 1) return null;
  const [{ product, group }] = [...unique.values()];
  const imageUrl = tcgplayerImageUrl(product.productId, product.imageUrl);
  if (!imageUrl || product.imageCount === 0) return null;
  return {
    productId: product.productId,
    productUrl:
      product.url || `https://www.tcgplayer.com/product/${product.productId}`,
    imageUrl,
    matchedName: product.name,
    groupName: group.name,
  } satisfies ExactCatalogMatch;
}