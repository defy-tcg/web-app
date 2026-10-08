import { ShopifySyncError, type Delivery } from "./sync-core.ts";

export interface InventoryStockEvent {
  available: number;
  eventAt: string;
  triggeredAt: string;
}

/** Counts are accepted only after the caller verifies Shopify's raw-body HMAC. */
export function inventoryStockEvent(delivery: Delivery, payload: unknown, locationId: string, triggeredAt = delivery.triggeredAt): InventoryStockEvent | null {
  if (delivery.topic !== "inventory_levels/update" || delivery.locationId !== locationId) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ShopifySyncError("INVALID_PAYLOAD", "Inventory event must be an object.", 400);
  const body = payload as Record<string, unknown>;
  // Preserve support for older ID-only subscriptions until their payload repair.
  if (body.available === undefined || body.updated_at === undefined) return null;
  if (typeof body.available !== "number" || !Number.isSafeInteger(body.available) || body.available < -2_147_483_648 || body.available > 2_147_483_647) {
    throw new ShopifySyncError("INVALID_PAYLOAD", "Inventory event needs an integer available count.", 400);
  }
  if (typeof body.updated_at !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.updated_at) || !Number.isFinite(Date.parse(body.updated_at))
    || new Date(`${body.updated_at.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== body.updated_at.slice(0, 10)) {
    throw new ShopifySyncError("INVALID_PAYLOAD", "Inventory event needs a valid update timestamp.", 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(triggeredAt) || Date.parse(triggeredAt) !== Date.parse(delivery.triggeredAt)) {
    throw new ShopifySyncError("INVALID_HEADERS", "Inventory event needs its verified delivery timestamp.", 400);
  }
  // Shopify update times can share a second. Keep its higher-precision delivery
  // time as the secondary ordering key rather than truncating to milliseconds.
  return { available: body.available, eventAt: new Date(body.updated_at).toISOString(), triggeredAt };
}
