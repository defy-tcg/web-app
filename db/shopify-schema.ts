import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Shopify projections are separate from spreadsheet/local POS balances. Never decrement legacy tables during sync.
const snapshotColumns = () => ({
  shop: text("shop").notNull(), id: text("id").notNull(), parentId: text("parent_id"),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true, mode: "string" }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  deleted: boolean("deleted").notNull().default(false), data: jsonb("data").$type<Record<string, unknown>>().notNull(),
});
export const shopifyProducts = pgTable("shopify_products", snapshotColumns(), table => [primaryKey({ columns: [table.shop, table.id] })]);
export const shopifyVariants = pgTable("shopify_variants", snapshotColumns(), table => [primaryKey({ columns: [table.shop, table.id] }), index("shopify_variants_parent_idx").on(table.shop, table.parentId)]);
export const shopifyInventory = pgTable("shopify_inventory", snapshotColumns(), table => [primaryKey({ columns: [table.shop, table.id] }), index("shopify_inventory_parent_idx").on(table.shop, table.parentId)]);
export const shopifyOrders = pgTable("shopify_orders", snapshotColumns(), table => [primaryKey({ columns: [table.shop, table.id] })]);
export const shopifyOrderLines = pgTable("shopify_order_lines", snapshotColumns(), table => [primaryKey({ columns: [table.shop, table.id] }), index("shopify_order_lines_parent_idx").on(table.shop, table.parentId)]);
export const shopifyWebhookInbox = pgTable("shopify_webhook_inbox", {
  shop: text("shop").notNull(), id: text("id").notNull(), topic: text("topic").notNull(), resourceId: text("resource_id").notNull(), locationId: text("location_id"),
  triggeredAt: timestamp("triggered_at", { withTimezone: true, mode: "string" }).notNull(),
  status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  leaseToken: text("lease_token"), leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "string" }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(), lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.shop, table.id] }), index("shopify_webhook_pending_idx").on(table.shop, table.status, table.nextAttemptAt)]);
