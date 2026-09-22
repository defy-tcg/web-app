import { randomUUID } from "node:crypto";
import { isGeneratedSku } from "./sku-labels.ts";
import { digest, SinglesError, type Snapshot } from "./singles/intake.ts";
import { createShopifyGraphQL, ShopifySinglesAdapter } from "./singles/shopify.ts";
import { readSkuLabelStockTarget, type SkuLabelShopifyDependencies, type SkuLabelShopifyProduct, type SkuLabelStockTarget } from "./sku-label-shopify.ts";
import type { SkuLabelStockRequest, SkuLabelStockResult } from "./sku-label-stock-types.ts";

export class SkuLabelStockInputError extends Error {}

export function parseSkuLabelStockRequest(value: unknown): SkuLabelStockRequest {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (Object.keys(row).some(key => !["requestId", "sku", "quantity"].includes(key)) ||
    typeof row.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.requestId) ||
    !isGeneratedSku(row.sku) || typeof row.quantity !== "number" || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 100_000) {
    throw new SkuLabelStockInputError("Provide a saved QR SKU, a unique request ID, and a whole number of cards from 1 to 100,000.");
  }
  return { requestId: row.requestId, sku: row.sku as string, quantity: row.quantity };
}

type Target = Omit<SkuLabelStockTarget, "availableQuantity">;
interface Receipt extends SkuLabelStockRequest {
  version: 1; savedProductId: string; shop: string; target: Target;
  status: "pending" | "complete" | "rejected"; owner: string | null; expiresAt: number;
  createdAt: number; adjustmentStartedAt?: number; adjustmentId?: string;
}
const LEASE_MS = 90_000;
const REPLAY_MS = 23 * 60 * 60 * 1000;
const receiptKey = (requestId: string) => `qr_stock_${digest(requestId).slice(0, 55)}`;
const targetFor = (target: SkuLabelStockTarget): Target => ({ identity: target.identity, productId: target.productId,
  variantId: target.variantId, inventoryItemId: target.inventoryItemId, locationId: target.locationId,
  shopifySku: target.shopifySku, publicationId: target.publicationId });
const sameTarget = (left: Target, right: Target) => Object.keys(left).length === Object.keys(right).length &&
  (Object.keys(right) as (keyof Target)[]).every(key => left[key] === right[key]);

class StockReviewError extends Error {}
function validateReceipt(record: Receipt, request: SkuLabelStockRequest, product: SkuLabelShopifyProduct, deps: SkuLabelShopifyDependencies) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.version !== 1 || record.requestId !== request.requestId || record.sku !== request.sku || record.quantity !== request.quantity ||
    record.savedProductId !== String(product.id) || record.shop !== deps.settings.shop || record.target?.locationId !== deps.settings.locationId ||
    !["pending", "complete", "rejected"].includes(record.status) || !Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt) ||
    (record.owner !== null && typeof record.owner !== "string") ||
    (record.adjustmentStartedAt !== undefined && !Number.isFinite(record.adjustmentStartedAt)) ||
    (record.status === "complete" && !record.adjustmentId) || (record.status === "rejected" && record.adjustmentId) ||
    !record.target.identity || !/^gid:\/\/shopify\/Product\/\d+$/.test(record.target.productId) ||
    !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(record.target.variantId) || !/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(record.target.inventoryItemId)) {
    throw new StockReviewError("This stock request has different or invalid saved details. Keep its request ID for owner review; do not start a replacement receipt.");
  }
}

/** Receive one explicit additional quantity. Retries only resume this receipt; no prices or original receipts are written. */
export async function addSkuLabelStock(product: SkuLabelShopifyProduct, input: SkuLabelStockRequest, dependencies?: SkuLabelShopifyDependencies): Promise<SkuLabelStockResult> {
  const request = parseSkuLabelStockRequest(input);
  const result = (status: SkuLabelStockResult["status"], message: string, retryable = false, availableQuantity?: number): SkuLabelStockResult =>
    ({ ...request, status, message, retryable, ...(availableQuantity === undefined ? {} : { availableQuantity }) });
  let deps: SkuLabelShopifyDependencies | undefined;
  let adapter: ShopifySinglesAdapter | undefined;
  let record: Receipt | null = null;
  let owned = false;
  let knownNoWrite = false;
  const owner = randomUUID();
  const key = receiptKey(request.requestId);
  try {
    deps = dependencies ?? await createShopifyGraphQL({ apiVersion: "2026-10" });
    adapter = new ShopifySinglesAdapter(deps.graphql, deps.settings, deps.clock);
    let saved: Snapshot<Receipt> = await adapter.read<Receipt>(key);
    record = saved.value;
    if (saved.digest !== null && record === null) throw new StockReviewError("The saved stock receipt is invalid. Keep its request ID for owner review; do not start a replacement receipt.");
    if (record !== null) validateReceipt(record, request, product, deps);
    if (product.sku !== request.sku) throw new StockReviewError("The saved card does not match this stock request. Keep the original request ID for review.");

    const completed = async () => {
      try {
        const target = await readSkuLabelStockTarget(product, deps!);
        if (sameTarget(record!.target, targetFor(target))) return result("complete", `Added ${request.quantity} card${request.quantity === 1 ? "" : "s"} to Shopify stock.`, false, target.availableQuantity);
      } catch { /* Receipt confirmation survives a later unavailable/changed catalog. */ }
      return result("complete", `Shopify confirmed the ${request.quantity}-card stock receipt. Current availability could not be refreshed; stock was not added again.`);
    };
    if (record?.status === "complete") return await completed();
    if (record?.status === "rejected") return result("rejected", "Shopify rejected this receipt; no stock was added. Review the card before starting a new receipt.");
    if (record?.owner && record.expiresAt > deps.clock()) return result("pending", "This stock request is already processing. Retry the same receipt shortly.", true);
    if (record?.adjustmentStartedAt !== undefined && deps.clock() - record.adjustmentStartedAt >= REPLAY_MS) {
      throw new StockReviewError("The stock response is uncertain and its safe retry window expired. Keep this request ID for owner review; do not add the stock again.");
    }

    const connection = await deps.graphql<{ shop: { myshopifyDomain: string }; location: { id: string; isActive: boolean } | null; currentAppInstallation: { accessScopes: { handle: string }[] } }>(`query QrStockConnection($location: ID!) {
      shop { myshopifyDomain } location(id: $location) { id isActive } currentAppInstallation { accessScopes { handle } }
    }`, { location: deps.settings.locationId });
    const scopes = new Set(connection.currentAppInstallation.accessScopes.map(item => item.handle));
    if (connection.shop.myshopifyDomain !== deps.settings.shop || connection.location?.id !== deps.settings.locationId || !connection.location.isActive ||
      !["write_products", "write_inventory", "read_locations"].every(scope => scopes.has(scope)) || (!scopes.has("read_publications") && !scopes.has("write_publications"))) {
      throw new SinglesError("QR_LINK_BLOCKED", "Shopify must confirm the configured store, active stock location, and app permissions before stock can be added.");
    }
    const target = await readSkuLabelStockTarget(product, deps);
    if (record && !sameTarget(record.target, targetFor(target))) throw new StockReviewError("This receipt's original Shopify mapping changed. Keep its request ID for owner review; no new stock request was sent.");
    const now = deps.clock();
    record ??= { version: 1, ...request, savedProductId: String(product.id), shop: deps.settings.shop, target: targetFor(target), status: "pending", owner: null, expiresAt: 0, createdAt: now };
    record = { ...record, owner, expiresAt: now + LEASE_MS };
    if (!await adapter.cas(key, saved, record)) {
      const concurrent = await adapter.read<Receipt>(key);
      if (concurrent.value) validateReceipt(concurrent.value, request, product, deps);
      return result("pending", "Another request is finishing this same stock receipt. Retry it shortly.", true);
    }
    owned = true;

    const persist = async (next: Receipt) => {
      saved = await adapter!.read<Receipt>(key);
      if (!saved.value || saved.value.owner !== owner || saved.value.expiresAt <= deps!.clock()) throw new SinglesError("RECEIPT_BUSY", "Stock receipt paused. Retry the same request.", true, true);
      validateReceipt(saved.value, request, product, deps!);
      if (!await adapter!.cas(key, saved, next)) throw new SinglesError("RECEIPT_BUSY", "Stock receipt changed. Retry the same request.", true, true);
      record = next;
    };
    // Revalidate the live mapping after reserving the receipt and before the only stock mutation.
    const verified = await readSkuLabelStockTarget(product, deps);
    if (!sameTarget(record.target, targetFor(verified))) throw new StockReviewError("The Shopify mapping changed while preparing stock. Keep this request ID for review.");
    if (record.adjustmentStartedAt !== undefined && deps.clock() - record.adjustmentStartedAt >= REPLAY_MS) throw new StockReviewError("The stock retry window expired. Keep this request ID for owner review.");
    const replaying = record.adjustmentStartedAt !== undefined;
    await persist({ ...record, adjustmentStartedAt: record.adjustmentStartedAt ?? deps.clock(), expiresAt: deps.clock() + LEASE_MS });
    const adjusted = await deps.graphql<{ inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: string } | null; userErrors: { code?: string; message: string }[] } }>(`mutation QrStockReceive($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { code message } }
    }`, { key: `defy-qr-stock-${digest(`${record.shop}:${record.requestId}`)}`, input: { name: "available", reason: "received",
      referenceDocumentUri: `gid://defy-qr/StockReceipt/${record.requestId}`,
      changes: [{ inventoryItemId: record.target.inventoryItemId, locationId: record.target.locationId, delta: record.quantity, changeFromQuantity: null }] } });
    const payload = adjusted.inventoryAdjustQuantities;
    if (payload?.userErrors?.length && !payload.inventoryAdjustmentGroup) {
      // Shopify may return concurrency or missing-record errors after an earlier success.
      // Once any prior attempt is possible, an error is not proof that no stock was received.
      if (replaying || payload.userErrors.some(error => !error.code || error.code.startsWith("IDEMPOTENCY_") || error.code.includes("NOT_FOUND"))) {
        return result("pending", "Shopify has not confirmed the original stock receipt. Keep this request ID and retry it; do not receive these cards under a new request.", true);
      }
      knownNoWrite = true;
      await persist({ ...record, status: "rejected", owner: null, expiresAt: 0 });
      owned = false;
      return result("rejected", "Shopify rejected this stock receipt; no stock was added. Review the card's inventory settings before starting a new receipt.");
    }
    if (!payload || payload.userErrors?.length || !payload.inventoryAdjustmentGroup?.id) throw new SinglesError("STOCK_UNCONFIRMED", "Stock response was not confirmed.", true, true);
    await persist({ ...record, status: "complete", adjustmentId: payload.inventoryAdjustmentGroup.id, owner: null, expiresAt: 0 });
    owned = false;
    return await completed();
  } catch (error) {
    if (error instanceof StockReviewError) return result("pending", error.message, false);
    if (knownNoWrite) return result("pending", "Shopify rejected the stock update, but its saved receipt is not confirmed. Retry this same request before starting another.", true);
    if (error instanceof SinglesError && error.code === "QR_LINK_BLOCKED") return result("pending",
      record?.adjustmentStartedAt === undefined ? `${error.message} Keep this stock request and retry after resolving the link.` : "The saved card's Shopify readiness changed after stock processing started. Keep this request ID for owner review; do not start a replacement receipt.",
      record?.adjustmentStartedAt === undefined);
    return result("pending", "Shopify has not confirmed this stock receipt. Retry the same request; do not create a second receipt for these cards.", true);
  } finally {
    if (owned && adapter) {
      try {
        const latest = await adapter.read<Receipt>(key);
        if (latest.value?.owner === owner) await adapter.cas(key, latest, { ...latest.value, owner: null, expiresAt: 0 });
      } catch { /* A persisted lease expires; retries always retain the same Shopify idempotency key. */ }
    }
  }
}
