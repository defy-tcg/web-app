export type CatalogCard = {
  key: string;
  productId: number;
  groupId: number;
  name: string;
  setName: string;
  setCode: string;
  number: string;
  rarity: string;
  finish: string;
  language: "English";
  imageUrl: string;
  productUrl: string;
  marketCents: number | null;
};

export type Catalog = {
  sourceUpdatedAt: string;
  fetchedAt: string;
  cards: CatalogCard[];
  warnings: string[];
};

export type SinglesIntakeRow = {
  cardKey: string;
  condition: string;
  quantity: number;
  costCents: number;
  priceCents: number;
};

export const SINGLES_CONDITIONS = [
  "Near Mint",
  "Lightly Played",
  "Moderately Played",
  "Heavily Played",
  "Damaged",
] as const;

export function canonicalSinglesCondition(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    nm: "Near Mint", lp: "Lightly Played", mp: "Moderately Played",
    hp: "Heavily Played", dmg: "Damaged",
  };
  return aliases[normalized] || SINGLES_CONDITIONS.find((condition) => condition.toLowerCase() === normalized) || null;
}
