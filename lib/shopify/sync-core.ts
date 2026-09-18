import { createHmac, timingSafeEqual } from "node:crypto";

export const SYNC_TOPICS = new Set([
  "products/create", "products/update", "products/delete", "inventory_levels/update", "inventory_levels/connect",
  "inventory_levels/disconnect", "orders/create", "orders/updated", "orders/paid", "orders/cancelled", "orders/delete",
]);
export const MAX_WEBHOOK_BYTES = 2_000_000;
export type ProjectionKind = "products" | "variants" | "inventory" | "orders" | "orderLines";
export interface Projection {
  kind: ProjectionKind;
  id: string;
  parentId: string | null;
  sourceUpdatedAt: string;
  observedAt: string;
  deleted: boolean;
  data: Record<string, unknown>;
}
export interface SyncBatch {
  projections: Projection[];
  deferred?: Delivery[];
  // Complete snapshots only. Reconciliation's variant pages never claim to be complete products.
  replaceChildren: { kind: "variants" | "orderLines"; parentId: string; ids: string[]; sourceUpdatedAt: string; observedAt: string }[];
}
export interface Delivery { id: string; topic: string; triggeredAt: string; resourceId: string; locationId?: string }
export class ShopifySyncError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 503) { super(message); this.code = code; this.status = status; }
}
export function verifyWebhookHmac(raw: Uint8Array, signature: string | null, secret: string): boolean {
  if (!secret || !signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  const received = Buffer.from(signature, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new ShopifySyncError("BODY_TOO_LARGE", "Request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ShopifySyncError("BODY_TOO_LARGE", "Request is too large.", 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
function numericId(value: unknown, type: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value)) || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new ShopifySyncError("INVALID_PAYLOAD", `Webhook needs a valid ${type} ID.`, 400);
  }
  return `gid://shopify/${type}/${value}`;
}
export function parseDelivery(headers: Headers, body: unknown, expectedShop: string): Delivery | null {
  if (headers.get("x-shopify-shop-domain") !== expectedShop) throw new ShopifySyncError("SHOP_MISMATCH", "Unexpected Shopify shop.", 403);
  const topic = headers.get("x-shopify-topic") ?? "";
  if (!SYNC_TOPICS.has(topic)) return null;
  const webhookId = headers.get("x-shopify-webhook-id");
  const id = webhookId || headers.get("x-shopify-event-id") || "";
  const triggeredAt = headers.get("x-shopify-triggered-at") ?? "";
  if (!/^[A-Za-z0-9-]{8,128}$/.test(id) || !Number.isFinite(Date.parse(triggeredAt))) throw new ShopifySyncError("INVALID_HEADERS", "Webhook event ID and timestamp are required.", 400);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ShopifySyncError("INVALID_PAYLOAD", "Webhook body must be an object.", 400);
  const data = body as Record<string, unknown>;
  const resourceId = numericId(topic.startsWith("inventory_levels/") ? data.inventory_item_id : data.id,
    topic.startsWith("inventory_levels/") ? "InventoryItem" : topic.startsWith("orders/") ? "Order" : "Product");
  const locationId = topic.startsWith("inventory_levels/") ? numericId(data.location_id, "Location") : undefined;
  // Webhook ID identifies a delivery. One merchant event can touch several resources.
  const receiptId = webhookId ? `webhook:${id}` : `${topic}:${id}:${resourceId}${locationId ? `:${locationId}` : ""}`;
  return { id: receiptId, topic, triggeredAt: new Date(triggeredAt).toISOString(), resourceId, ...(locationId ? { locationId } : {}) };
}
export function shouldApplyProjection(current: Projection | undefined, incoming: Projection): boolean {
  if (!current) return true;
  const delta = Date.parse(incoming.sourceUpdatedAt) - Date.parse(current.sourceUpdatedAt);
  return delta > 0 || (delta === 0 && !current.deleted && (incoming.deleted || Date.parse(incoming.observedAt) > Date.parse(current.observedAt)));
}
export interface SyncStore {
  hasDelivery(shop: string, id: string): Promise<boolean>;
  apply(shop: string, delivery: Delivery, batch: SyncBatch, leaseToken?: string): Promise<boolean>;
}
export async function processDelivery(shop: string, delivery: Delivery, store: SyncStore, fetchSnapshot: () => Promise<SyncBatch>, leaseToken?: string) {
  if (await store.hasDelivery(shop, delivery.id)) return { duplicate: true };
  // Do not claim a delivery until every remote read succeeds. Failed fetches remain retryable.
  const batch = await fetchSnapshot();
  const applied = await store.apply(shop, delivery, batch, leaseToken);
  return { duplicate: !applied };
}
export interface ReconcileCursor { phase: "inventory" | "productsAudit" | "variantsAudit" | "orders" | "ordersAudit"; after: string | null }
export function decodeCursor(value: unknown): ReconcileCursor {
  if (value === undefined || value === null || value === "") return { phase: "inventory", after: null };
  if (typeof value !== "string" || value.length > 4096) throw new ShopifySyncError("INVALID_CURSOR", "Invalid sync cursor.", 400);
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new ShopifySyncError("INVALID_CURSOR", "Invalid sync cursor.", 400); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ShopifySyncError("INVALID_CURSOR", "Invalid sync cursor.", 400);
  const cursor = parsed as ReconcileCursor;
  if (!["inventory", "productsAudit", "variantsAudit", "orders", "ordersAudit"].includes(cursor.phase) || (cursor.after !== null && (typeof cursor.after !== "string" || cursor.after.length > 2048))) throw new ShopifySyncError("INVALID_CURSOR", "Invalid sync cursor.", 400);
  return { phase: cursor.phase, after: cursor.after };
}
export function encodeCursor(cursor: ReconcileCursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
export function hasSyncOrigin(request: Request, configuredOrigin: string | undefined, production: boolean): boolean {
  if (request.headers.get("x-defy-sync") !== "1" || request.headers.get("sec-fetch-site") === "cross-site") return false;
  let trusted = configuredOrigin?.trim();
  if (!trusted && !production) trusted = new URL(request.url).origin;
  if (!trusted) return false;
  try {
    const url = new URL(trusted);
    if (production && url.protocol !== "https:") return false;
    if (url.origin !== trusted.replace(/\/$/, "")) return false;
    return request.headers.get("origin") === url.origin;
  } catch { return false; }
}
