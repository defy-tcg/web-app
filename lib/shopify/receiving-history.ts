import { createShopifyGraphQL, type SinglesGraphQL } from "../singles/shopify.ts";

export const RECEIVING_HISTORY_PAGE_SIZE = 25;
const RECORD_LIMIT = 65_536;
const REQUEST_ID = /^[a-z0-9][a-z0-9-]{15,99}$/;

export interface ReceivingHistoryReceipt {
  id: string; requestId: string; productId: string; variantId: string; inventoryItemId: string;
  locationId: string; locationName: string; sku: string; barcode: string; name: string; game: string;
  unit: string; quantity: number; unitCostCents: number; totalCostCents: number; currencyCode: string;
  supplier: string; notes: string; receivedDate: string; recordedAt: string; appliedAt: string;
  adjustmentGroupId: string; createdProduct: boolean; staged: boolean;
  inventoryMode?: "set"; expectedAvailableQuantity?: number; storePriceCents?: number;
}
export interface ReceivingHistoryPage {
  shop: string; locationId: string; receipts: ReceivingHistoryReceipt[]; pageSize: number;
  scannedCount: number; otherLocationCount: number; hasMore: boolean; nextCursor: string | null; fetchedAt: string;
}
export interface ReceivingHistoryDependencies {
  graphql: SinglesGraphQL; shop: string; locationId: string; now?: () => Date;
}
export class ReceivingHistoryError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 503) {
    super(message); this.name = "ReceivingHistoryError"; this.code = code; this.status = status;
  }
}
const incomplete = (): never => { throw new ReceivingHistoryError("INCOMPLETE_HISTORY", "Shopify returned an incomplete or inconsistent receiving record. This page was not loaded; ask the owner to review its saved receipts."); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return incomplete();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, optional = false): string {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!optional && !value.trim())) return incomplete();
  return value;
}
function gid(value: unknown, type: string): string {
  const result = text(value, 100);
  if (!new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`).test(result)) return incomplete();
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) return incomplete();
  const normalized = new Date(result).toISOString();
  if (normalized.slice(0, 19) !== result.slice(0, 19)) return incomplete();
  return normalized;
}
function cents(value: unknown): number {
  const amount = text(value, 32);
  if (!/^\d+\.\d{2}$/.test(amount)) return incomplete();
  const [whole, fraction] = amount.split(".");
  const result = Number(whole) * 100 + Number(fraction);
  if (!Number.isSafeInteger(result) || result < 0) return incomplete();
  return result;
}
function flag(value: unknown): boolean {
  if (typeof value !== "boolean") return incomplete();
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) return incomplete();
  return value;
}
function receivedDate(value: unknown): string {
  const result = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`))
    || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) return incomplete();
  return result;
}
function inventoryDetails(receipt: Record<string, unknown>) {
  if (receipt.inventoryMode !== undefined && receipt.inventoryMode !== "set") return incomplete();
  const set = receipt.inventoryMode === "set";
  const quantity = integer(receipt.quantity, set ? 0 : 1);
  const unitCostCents = cents(receipt.unitCost);
  if (set && receipt.unitCost !== "0.00") return incomplete();
  if (!set && "expectedAvailableQuantity" in receipt) return incomplete();
  const expectedAvailableQuantity = set ? integer(receipt.expectedAvailableQuantity, -2_147_483_648) : undefined;
  const storePriceCents = receipt.storePrice === undefined ? undefined : cents(receipt.storePrice);
  if (storePriceCents !== undefined && storePriceCents > 100_000_000) return incomplete();
  return { quantity, unitCostCents,
    ...(set ? { inventoryMode: "set" as const, expectedAvailableQuantity } : {}),
    ...(storePriceCents !== undefined ? { storePriceCents } : {}) };
}
function barcode(value: unknown): string {
  const result = text(value, 14);
  if (!/^(?:\d{12}|\d{13}|\d{14})$/.test(result)) return incomplete();
  let sum = 0;
  for (let index = result.length - 2, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3) sum += Number(result[index]) * weight;
  if ((10 - sum % 10) % 10 !== Number(result.at(-1))) return incomplete();
  return result;
}
const barcodeIdentity = (value: string) => value.length === 13 && value.startsWith("0") ? value.slice(1) : value;

function parseNode(value: unknown) {
  const node = object(value);
  const id = gid(node.id, "Metaobject");
  const handle = text(node.handle, 100);
  const field = object(node.payload);
  const raw = text(field.value, RECORD_LIMIT);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return incomplete(); }
  const record = object(parsed);
  if (record.version !== 1) return incomplete();
  return { id, handle, record };
}

/** Only immutable completed records from Shopify are accepted; the client supplies no receipt fields. */
export function parseReceivingHistoryReceipt(value: unknown): ReceivingHistoryReceipt {
  return parseCompletedReceipt(parseNode(value));
}

function parseCompletedReceipt({ id, handle, record }: ReturnType<typeof parseNode>): ReceivingHistoryReceipt {
  if (record.status !== undefined) return incomplete();
  const receipt = object(record.receipt);
  const product = object(record.product);
  const requestId = text(receipt.requestId, 100);
  if (!REQUEST_ID.test(requestId) || handle !== requestId) return incomplete();
  const productId = gid(receipt.productId, "Product");
  const variantId = gid(receipt.variantId, "ProductVariant");
  const inventoryItemId = gid(receipt.inventoryItemId, "InventoryItem");
  const sku = text(receipt.sku, 80);
  const name = text(receipt.name, 600);
  const unit = text(receipt.unit, 80);
  const code = barcode(receipt.barcode);
  if (product.productId !== productId || product.variantId !== variantId || product.inventoryItemId !== inventoryItemId
    || product.sku !== sku || product.name !== name || product.unit !== unit
    || barcodeIdentity(barcode(product.barcode)) !== barcodeIdentity(code)) return incomplete();
  const inventory = inventoryDetails(receipt);
  const { quantity, unitCostCents } = inventory;
  const totalCostCents = quantity * unitCostCents;
  if (!Number.isSafeInteger(totalCostCents)) return incomplete();
  const currencyCode = text(receipt.currencyCode, 3);
  if (!/^[A-Z]{3}$/.test(currencyCode)) return incomplete();
  const date = receivedDate(receipt.receivedDate);
  const recordedAt = timestamp(receipt.recordedAt);
  const appliedAt = timestamp(receipt.appliedAt);
  // Shopify timestamps can omit fractional seconds. The displayed second may
  // still contain an adjustment made after a millisecond-precise reservation.
  const appliedFractionDigits = /\.(\d{1,3})Z$/.exec(String(receipt.appliedAt))?.[1].length ?? 0;
  const appliedPrecisionMs = 10 ** (3 - appliedFractionDigits);
  if (Date.parse(appliedAt) + appliedPrecisionMs - 1 < Date.parse(recordedAt)) return incomplete();
  return { id, requestId, productId, variantId, inventoryItemId, sku, barcode: code, name, unit, ...inventory, totalCostCents,
    locationId: gid(receipt.locationId, "Location"), locationName: text(receipt.locationName, 300), game: text(receipt.game, 80),
    currencyCode, supplier: text(receipt.supplier, 300, true), notes: text(receipt.notes, 1500, true), receivedDate: date, recordedAt, appliedAt,
    adjustmentGroupId: gid(receipt.adjustmentGroupId, "InventoryAdjustmentGroup"), createdProduct: flag(receipt.createdProduct), staged: flag(receipt.staged) };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** A terminal count rejection is a journal marker, never a confirmed stock receipt. */
function parseHistoryRecord(value: unknown): { id: string; requestId: string; locationId: string; receipt: ReceivingHistoryReceipt | null } {
  const node = parseNode(value);
  if (node.record.status !== "rejected") {
    const receipt = parseCompletedReceipt(node);
    return { id: receipt.id, requestId: receipt.requestId, locationId: receipt.locationId, receipt };
  }
  const { record, id, handle } = node;
  if ("receipt" in record || "adjustment" in record || "adjustmentGroupId" in record) return incomplete();
  const request = object(record.request);
  const product = object(record.product);
  const error = object(record.error);
  const requestId = text(request.requestId, 100);
  if (!REQUEST_ID.test(requestId) || requestId !== handle || text(record.fingerprint, RECORD_LIMIT) !== stableJson(request)
    || request.inventoryMode !== "set" || error.code !== "STOCK_CHANGED") return incomplete();
  inventoryDetails(request);
  text(error.message, 1500);
  timestamp(record.rejectedAt);
  const locationId = gid(request.locationId, "Location");
  const sku = text(request.sku, 80, true);
  const unit = text(request.unit, 80);
  const code = barcode(request.barcode);
  text(request.name, 300); text(request.game, 80);
  text(request.supplier, 300, true); text(request.notes, 1500, true);
  receivedDate(request.receivedDate); flag(request.replaceInvalidBarcode);
  if (request.catalog !== undefined) {
    const catalog = object(request.catalog);
    const games: Record<string, string> = { pokemon: "Pokémon", onepiece: "One Piece", riftbound: "Riftbound", gundam: "Gundam", magicthegathering: "MTG" };
    const game = text(catalog.game, 20);
    if (Object.keys(catalog).some(key => !["game", "id", "name", "setName", "language"].includes(key))
      || !Object.hasOwn(games, game) || request.game !== games[game] || catalog.language !== "English"
      || text(catalog.name, 300) !== request.name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(text(catalog.id, 100))) return incomplete();
    if (/[\u0000-\u001f\u007f]/.test(String(catalog.name) + text(catalog.setName, 300))) return incomplete();
  }
  gid(product.productId, "Product"); gid(product.variantId, "ProductVariant"); gid(product.inventoryItemId, "InventoryItem");
  text(product.sku, 80); text(product.name, 600); text(product.game, 80, true);
  if ((sku && product.sku !== sku) || product.unit !== unit || barcodeIdentity(barcode(product.barcode)) !== barcodeIdentity(code)
    || !flag(product.tracked) || flag(product.barcodeNeedsReview) || !["ACTIVE", "DRAFT", "UNLISTED"].includes(text(product.status, 20))) return incomplete();
  if (product.price !== undefined) cents(product.price);
  return { id, requestId, locationId, receipt: null };
}

const validCursor = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048 && /^[A-Za-z0-9+/_=-]+$/.test(value);
function cursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!validCursor(value)) {
    throw new ReceivingHistoryError("INVALID_CURSOR", "Provide a valid receiving-history cursor.", 400);
  }
  return value;
}
function safeFailure(error: unknown): ReceivingHistoryError {
  if (error instanceof ReceivingHistoryError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (["CONNECTION_REQUIRED", "SHOP_INVALID", "LOCATION_INVALID", "SHOPIFY_AUTH_FAILED"].includes(String(code))) {
    return new ReceivingHistoryError("CONNECTION_REQUIRED", "Configure the approved Shopify shop, installed app credentials, and receiving location to read receipts.");
  }
  if (code === "ACCESS_DENIED") return new ReceivingHistoryError("ACCESS_REQUIRED", "The installed Shopify app cannot read its receiving records. Check the app's metaobject access and installation.");
  return new ReceivingHistoryError("HISTORY_UNAVAILABLE", "Receiving history could not be read from Shopify. Retry shortly; no stock was changed.");
}

/** One bounded read page, newest record IDs first. Filtering never turns a partial page into a complete history. */
export async function getReceivingHistory(cursorValue?: unknown, dependencies?: ReceivingHistoryDependencies): Promise<ReceivingHistoryPage> {
  const after = cursor(cursorValue);
  try {
    const client = dependencies ?? await (async () => {
      const connection = await createShopifyGraphQL();
      return { graphql: connection.graphql, shop: connection.settings.shop, locationId: connection.settings.locationId };
    })();
    if (!["n4a7aa-fi.myshopify.com", "defy-receiving-test.myshopify.com"].includes(client.shop)
      || !/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(client.locationId)) {
      throw new ReceivingHistoryError("CONNECTION_REQUIRED", "Configure the approved Shopify shop and receiving location to read receipts.");
    }
    const result = object(await client.graphql<unknown>(`query DefyReceivingHistory($first: Int!, $after: String, $locationId: ID!) {
      shop { myshopifyDomain }
      location(id: $locationId) { id }
      metaobjects(type: "$app:receiving_applied", first: $first, after: $after, sortKey: "id", reverse: true) {
        nodes { id handle payload: field(key: "payload") { value } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { first: RECEIVING_HISTORY_PAGE_SIZE, after, locationId: client.locationId }));
    if (object(result.shop).myshopifyDomain !== client.shop || object(result.location).id !== client.locationId) {
      throw new ReceivingHistoryError("CONNECTION_MISMATCH", "Shopify did not confirm the configured shop and receiving location. No receipt history was loaded.");
    }
    const connection = object(result.metaobjects);
    const pageInfo = object(connection.pageInfo);
    if (!Array.isArray(connection.nodes) || connection.nodes.length > RECEIVING_HISTORY_PAGE_SIZE || typeof pageInfo.hasNextPage !== "boolean") return incomplete();
    const hasMore = pageInfo.hasNextPage;
    const nextCursor = hasMore ? validCursor(pageInfo.endCursor) ? pageInfo.endCursor : incomplete() : null;
    if (hasMore && (!nextCursor || nextCursor === after || !connection.nodes.length)) return incomplete();
    const records = connection.nodes.map(parseHistoryRecord);
    if (new Set(records.map(record => record.id)).size !== records.length || new Set(records.map(record => record.requestId)).size !== records.length) return incomplete();
    const completed = records.flatMap(record => record.receipt ? [record.receipt] : []);
    const receipts = completed.filter(record => record.locationId === client.locationId);
    return { shop: client.shop, locationId: client.locationId, receipts, pageSize: RECEIVING_HISTORY_PAGE_SIZE,
      scannedCount: records.length, otherLocationCount: completed.length - receipts.length, hasMore, nextCursor,
      fetchedAt: (dependencies?.now?.() ?? new Date()).toISOString() };
  } catch (error) { throw safeFailure(error); }
}
