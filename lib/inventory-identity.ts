import { canonicalizeGame, type TcgGameName } from "./tcg-games.ts";
import { productIdentityKey, type ProductSkuIdentity } from "./product-sku.ts";

export type ExistingProductIdentity = ProductSkuIdentity & {
  id: number;
  sku: string;
  game: string;
};

export type SheetIdentity = ProductSkuIdentity & {
  game: TcgGameName | null;
  gameReliable: boolean;
};

function nameKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sameProductIdentity(
  left: ProductSkuIdentity,
  right: ProductSkuIdentity,
) {
  return productIdentityKey(left) === productIdentityKey(right);
}

export function matchSheetProducts<T extends ExistingProductIdentity>(
  existing: T[],
  sheet: SheetIdentity,
) {
  const sameName = existing.filter(
    (product) => nameKey(product.name) === nameKey(sheet.name),
  );
  if (sheet.gameReliable && sheet.game) {
    return sameName.filter(
      (product) => canonicalizeGame(product.game) === sheet.game,
    );
  }
  const games = new Set(sameName.map((product) => canonicalizeGame(product.game)));
  return games.size <= 1 ? sameName : [];
}

export function matchCatalogProduct<T extends ExistingProductIdentity>(
  existing: T[],
  input: ProductSkuIdentity,
) {
  if (!input.tcgplayerId) return null;
  const matches = existing.filter(
    (product) =>
      product.tcgplayerId === input.tcgplayerId &&
      canonicalizeGame(product.game) === canonicalizeGame(input.game),
  );
  return matches.length === 1 ? matches[0] : null;
}