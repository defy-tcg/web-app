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
function barcode(value: unknown): string {
  const result = text(value, 14);
  if (!/^(?:\d{12}|\d{13}|\d{14})$/.test(result)) return incomplete();
  let sum = 0;
  for (let index = result.length - 2, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3) sum += Number(result[index]) * weight;
  if ((10 - sum % 10) % 10 !== Number(result.at(-1))) return incomplete();
  return result;
}
const barcodeIdentity = (value: string) => value.length === 13 && value.startsWith("0") ? value.slice(1) : value;

/** Only immutable completed records from Shopify are accepted; the client supplies no receipt fields. */
export function parseReceivingHistoryReceipt(value: unknown): ReceivingHistoryReceipt {
  const node = object(value);
  const id = gid(node.id, "Metaobject");
  const handle = text(node.handle, 100);
  const field = object(node.payload);
  const raw = text(field.value, RECORD_LIMIT);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return incomplete(); }
  const record = object(parsed);
  if (record.version !== 1) return incomplete();
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
  const quantity = receipt.quantity;
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) return incomplete();
  const unitCostCents = cents(receipt.unitCost);
  const totalCostCents = quantity * unitCostCents;
  if (!Number.isSafeInteger(totalCostCents)) return incomplete();
  const currencyCode = text(receipt.currencyCode, 3);
  if (!/^[A-Z]{3}$/.test(currencyCode)) return incomplete();
  const receivedDate = text(receipt.receivedDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate) || !Number.isFinite(Date.parse(`${receivedDate}T00:00:00Z`))
    || new Date(`${receivedDate}T00:00:00Z`).toISOString().slice(0, 10) !== receivedDate) return incomplete();
  const recordedAt = timestamp(receipt.recordedAt);
  const appliedAt = timestamp(receipt.appliedAt);
  // Shopify timestamps can omit fractional seconds. The displayed second may
  // still contain an adjustment made after a millisecond-precise reservation.
  const appliedFractionDigits = /\.(\d{1,3})Z$/.exec(String(receipt.appliedAt))?.[1].length ?? 0;
  const appliedPrecisionMs = 10 ** (3 - appliedFractionDigits);
  if (Date.parse(appliedAt) + appliedPrecisionMs - 1 < Date.parse(recordedAt)) return incomplete();
  return { id, requestId, productId, variantId, inventoryItemId, sku, barcode: code, name, unit, quantity, unitCostCents, totalCostCents,
    locationId: gid(receipt.locationId, "Location"), locationName: text(receipt.locationName, 300), game: text(receipt.game, 80),
    currencyCode, supplier: text(receipt.supplier, 300, true), notes: text(receipt.notes, 1500, true), receivedDate, recordedAt, appliedAt,
    adjustmentGroupId: gid(receipt.adjustmentGroupId, "InventoryAdjustmentGroup"), createdProduct: flag(receipt.createdProduct), staged: flag(receipt.staged) };
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
    const records = connection.nodes.map(parseReceivingHistoryReceipt);
    if (new Set(records.map(record => record.id)).size !== records.length || new Set(records.map(record => record.requestId)).size !== records.length) return incomplete();
    const receipts = records.filter(record => record.locationId === client.locationId);
    return { shop: client.shop, locationId: client.locationId, receipts, pageSize: RECEIVING_HISTORY_PAGE_SIZE,
      scannedCount: records.length, otherLocationCount: records.length - receipts.length, hasMore, nextCursor,
      fetchedAt: (dependencies?.now?.() ?? new Date()).toISOString() };
  } catch (error) { throw safeFailure(error); }
}
