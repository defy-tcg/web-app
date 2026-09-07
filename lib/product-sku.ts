import { canonicalizeGame, gameCode, type TcgGameName } from "./tcg-games.ts";

export type ProductSkuIdentity = {
  game: unknown;
  name: string;
  setName?: string | null;
  cardNumber?: string | null;
  condition?: string | null;
  finish?: string | null;
  tcgplayerId?: number | null;
};

const CODE_39_SAFE = /^[A-Z0-9 .-]+$/;

function identityText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function productIdentityKey(input: ProductSkuIdentity) {
  return [
    canonicalizeGame(input.game),
    input.name,
    input.setName,
    input.cardNumber,
    input.condition,
    input.finish,
    input.tcgplayerId || "",
  ]
    .map(identityText)
    .join("|");
}

export function stableShortHash(value: string, length = 8) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(length, "0").slice(-length);
}

export function validateSku(value: unknown) {
  const sku = String(value ?? "").trim().toUpperCase();
  if (!sku) throw new Error("SKU is required");
  if (sku.length > 80)
    throw new Error("SKU must be 80 characters or fewer");
  if (!CODE_39_SAFE.test(sku))
    throw new Error("SKU can use only uppercase letters, numbers, spaces, periods, and hyphens (Code 39)");
  return sku;
}

export function manualProductSku(game: unknown, sequence: number) {
  return `DEFY-${gameCode(game)}-${Math.max(1, Math.round(sequence)).toString().padStart(6, "0")}`;
}

export function catalogProductSku(game: unknown, tcgplayerId: number) {
  const id = Math.max(1, Math.round(tcgplayerId));
  return `DEFY-${gameCode(game)}-T${id}`;
}

export function sheetProductSku(input: ProductSkuIdentity, attempt = 0) {
  const seed = `${productIdentityKey(input)}|sheet|${attempt}`;
  return `DEFY-${gameCode(input.game)}-S${stableShortHash(seed)}`;
}

export function importedProductSku(input: ProductSkuIdentity, attempt = 0) {
  if (input.tcgplayerId) return catalogProductSku(input.game, input.tcgplayerId);
  const seed = `${productIdentityKey(input)}|import|${attempt}`;
  return `DEFY-${gameCode(input.game)}-I${stableShortHash(seed)}`;
}

function legacyCode(value: string, fallback = "NA") {
  return (
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 12) || fallback
  );
}

export function legacyCsvFallbackSku(
  input: ProductSkuIdentity,
  oneBasedRowIndex: number,
) {
  return `TCG-${input.tcgplayerId || legacyCode(input.name)}-${legacyCode(input.condition || "")}-${legacyCode(input.finish || "", String(oneBasedRowIndex))}`;
}

export function previewManualSku(
  game: TcgGameName,
  existingSkus: Iterable<string>,
) {
  const code = gameCode(game);
  let max = 0;
  const pattern = new RegExp(`^DEFY-${code}-(\\d{6})$`, "i");
  for (const value of existingSkus) {
    const match = pattern.exec(value);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return manualProductSku(game, max + 1);
}

export function matchesSkuOrBarcode(
  product: { sku: string; barcode?: string | null },
  scannedValue: string,
) {
  const value = scannedValue.trim().toLowerCase();
  return Boolean(
    value &&
      (product.sku.trim().toLowerCase() === value ||
        product.barcode?.trim().toLowerCase() === value),
  );
}