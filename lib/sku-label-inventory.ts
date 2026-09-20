import { isGeneratedSku, MAX_SKU_BATCH } from "./sku-labels.ts";
import { canonicalizeGame, isCanonicalGameName, type TcgGameName } from "./tcg-games.ts";

export const LABEL_CONDITIONS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"] as const;
export const LABEL_FINISHES = ["Normal", "Foil", "Reverse Holo"] as const;
export const MAX_LABEL_MONEY_CENTS = 100_000_000;

export type InventoryLabelInput = {
  sku: string;
  name: string;
  game: TcgGameName;
  setName: string;
  cardNumber: string;
  condition: (typeof LABEL_CONDITIONS)[number];
  finish: (typeof LABEL_FINISHES)[number];
  quantity: number;
  costCents: number;
  listPriceCents: number;
  location?: string;
  tcgplayerId?: number | null;
};
export type NormalizedInventoryLabel = InventoryLabelInput & { location: string; tcgplayerId: number | null };
export type InventoryLabelIdentity = {
  sku: string; barcode?: string | null; productType: string; name: string; game: string;
  setName: string; cardNumber: string; condition: string; finish: string; tcgplayerId?: number | null;
};
export type InventoryLabelConflict = { kind: "sku" | "barcode" | "variant"; sku: string; existingSku: string };

export class SkuLabelInventoryError extends Error {
  status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.name = "SkuLabelInventoryError";
    this.status = status;
  }
}

export function inventoryLabelIdentityText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function inventoryLabelVariantKey(label: Omit<InventoryLabelIdentity, "sku" | "productType">): string {
  return JSON.stringify([canonicalizeGame(label.game), label.name, label.setName, label.cardNumber, label.condition, label.finish]
    .map(inventoryLabelIdentityText));
}

function sameCatalogVariant(left: InventoryLabelIdentity, right: InventoryLabelIdentity): boolean {
  return Boolean(left.tcgplayerId && left.tcgplayerId === right.tcgplayerId &&
    canonicalizeGame(left.game) === canonicalizeGame(right.game) &&
    inventoryLabelIdentityText(left.condition) === inventoryLabelIdentityText(right.condition) &&
    inventoryLabelIdentityText(left.finish) === inventoryLabelIdentityText(right.finish));
}

export function inventoryLabelConflictError(conflict: InventoryLabelConflict): SkuLabelInventoryError {
  if (conflict.kind === "barcode") return new SkuLabelInventoryError(409, `${conflict.sku} is already a barcode for ${conflict.existingSku}. Generate a different SKU.`);
  if (conflict.kind === "variant") return new SkuLabelInventoryError(409, `This card variant already exists as ${conflict.existingSku}. Use that SKU to reprint or manage its stock in Inventory.`);
  return new SkuLabelInventoryError(409, `${conflict.sku} already belongs to a different card. Generate a different SKU or restore the original card details.`);
}

/** Plans retries without changing any existing product's stock, prices, or metadata. */
export function planInventoryLabels<T extends InventoryLabelIdentity>(labels: readonly NormalizedInventoryLabel[], existing: readonly T[]) {
  const create: NormalizedInventoryLabel[] = [];
  const reused: T[] = [];
  for (const label of labels) {
    const key = inventoryLabelVariantKey(label);
    const match = existing.find((product) => product.sku.trim().toUpperCase() === label.sku);
    if (match && (match.productType !== "Single" || inventoryLabelVariantKey(match) !== key ||
      Boolean(match.tcgplayerId && label.tcgplayerId && match.tcgplayerId !== label.tcgplayerId))) {
      throw inventoryLabelConflictError({ kind: "sku", sku: label.sku, existingSku: match.sku });
    }
    const barcode = existing.find((product) => product !== match && product.barcode?.trim().toUpperCase() === label.sku);
    if (barcode) throw inventoryLabelConflictError({ kind: "barcode", sku: label.sku, existingSku: barcode.sku });
    const variant = existing.find((product) => product !== match && product.productType === "Single" &&
      (inventoryLabelVariantKey(product) === key || sameCatalogVariant(product, { ...label, productType: "Single" })));
    if (variant) throw inventoryLabelConflictError({ kind: "variant", sku: label.sku, existingSku: variant.sku });
    if (match) reused.push(match); else create.push(label);
  }
  return { create, existing: reused };
}

function text(value: unknown, name: string, limit: number, optional = false): string {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string") throw new SkuLabelInventoryError(400, `${name} is required.`);
  const cleaned = value.trim();
  if ((!optional && !cleaned) || Array.from(cleaned).length > limit || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    throw new SkuLabelInventoryError(400, `${name} must contain ${optional ? "up to" : "1–"}${limit} characters without control characters.`);
  }
  return cleaned;
}

function integer(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new SkuLabelInventoryError(400, `${name} must be a whole number from 0 to ${maximum.toLocaleString("en-US")}.`);
  }
  return value;
}

export function validateInventoryLabels(payload: unknown): NormalizedInventoryLabel[] {
  if (!payload || typeof payload !== "object" || !("labels" in payload) || !Array.isArray(payload.labels) ||
    payload.labels.length < 1 || payload.labels.length > MAX_SKU_BATCH) {
    throw new SkuLabelInventoryError(400, `Save between 1 and ${MAX_SKU_BATCH} labels at a time.`);
  }
  const skus = new Set<string>();
  const variants = new Set<string>();
  const catalogs = new Set<string>();
  return payload.labels.map((value: unknown, index) => {
    if (!value || typeof value !== "object") throw new SkuLabelInventoryError(400, `Label ${index + 1} is invalid.`);
    const row = value as Record<string, unknown>;
    if (!isGeneratedSku(row.sku)) throw new SkuLabelInventoryError(400, `Label ${index + 1} must use a generated SKU.`);
    if (!isCanonicalGameName(row.game)) throw new SkuLabelInventoryError(400, `Choose a game for label ${index + 1}.`);
    if (!LABEL_CONDITIONS.includes(row.condition as InventoryLabelInput["condition"])) throw new SkuLabelInventoryError(400, `Choose a valid condition for ${row.sku}.`);
    if (!LABEL_FINISHES.includes(row.finish as InventoryLabelInput["finish"])) throw new SkuLabelInventoryError(400, `Choose a valid finish for ${row.sku}.`);
    const tcgplayerId = row.tcgplayerId == null ? null : integer(row.tcgplayerId, "TCGplayer ID", 2_147_483_647);
    if (tcgplayerId === 0) throw new SkuLabelInventoryError(400, "TCGplayer ID must be positive.");
    const label: NormalizedInventoryLabel = {
      sku: row.sku, name: text(row.name, "Card name", 48), game: row.game,
      setName: text(row.setName, "Set name", 120), cardNumber: text(row.cardNumber, "Card number", 40),
      condition: row.condition as InventoryLabelInput["condition"], finish: row.finish as InventoryLabelInput["finish"],
      quantity: integer(row.quantity, "Quantity", 100_000), costCents: integer(row.costCents, "Cost in cents", MAX_LABEL_MONEY_CENTS),
      listPriceCents: integer(row.listPriceCents, "Price in cents", MAX_LABEL_MONEY_CENTS),
      location: text(row.location, "Location", 80, true).toUpperCase() || "REDMOND", tcgplayerId,
    };
    if (skus.has(label.sku)) throw new SkuLabelInventoryError(400, `SKU ${label.sku} appears more than once in this batch.`);
    const variantKey = inventoryLabelVariantKey(label);
    const catalogKey = label.tcgplayerId ? JSON.stringify([label.game, label.tcgplayerId, label.condition, label.finish]) : "";
    if (variants.has(variantKey) || (catalogKey && catalogs.has(catalogKey))) {
      throw new SkuLabelInventoryError(409, `The same card variant appears more than once in this batch (${label.sku}). Use one SKU and set its quantity instead.`);
    }
    skus.add(label.sku); variants.add(variantKey); if (catalogKey) catalogs.add(catalogKey);
    return label;
  });
}
