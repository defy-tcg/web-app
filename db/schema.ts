import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export * from "./shopify-schema";

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: text("sku").notNull(),
  barcode: text("barcode"),
  tcgplayerId: integer("tcgplayer_id"),
  tcgplayerUrl: text("tcgplayer_url"),
  name: text("name").notNull(),
  productType: text("product_type", { enum: ["Single", "Sealed"] }).notNull(),
  game: text("game").notNull().default("Other"),
  setName: text("set_name").notNull().default(""),
  cardNumber: text("card_number").notNull().default(""),
  rarity: text("rarity").notNull().default(""),
  condition: text("condition").notNull().default(""),
  finish: text("finish").notNull().default(""),
  quantity: integer("quantity").notNull().default(0),
  sheetQuantity: integer("sheet_quantity"),
  costCents: integer("cost_cents").notNull().default(0),
  marketPriceCents: integer("market_price_cents").notNull().default(0),
  listPriceCents: integer("list_price_cents").notNull().default(0),
  location: text("location").notNull().default("UNASSIGNED"),
  lowStockThreshold: integer("low_stock_threshold").notNull().default(2),
  priceSource: text("price_source").notNull().default("manual"),
  priceUpdatedAt: text("price_updated_at"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("products_sku_unique").on(table.sku),
  index("products_barcode_idx").on(table.barcode),
  index("products_tcgplayer_id_idx").on(table.tcgplayerId),
  index("products_type_idx").on(table.productType),
]);

export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("movements_product_idx").on(table.productId)]);

export const priceHistory = pgTable("price_history", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  marketPriceCents: integer("market_price_cents").notNull(),
  source: text("source").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [index("price_history_product_idx").on(table.productId)]);

export const sales = pgTable("sales", {
  id: text("id").primaryKey(),
  saleNumber: text("sale_number").notNull(),
  channel: text("channel").notNull().default("In-store"),
  paymentMethod: text("payment_method").notNull().default("Card"),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  discountCents: integer("discount_cents").notNull().default(0),
  taxCents: integer("tax_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  cogsCents: integer("cogs_cents").notNull().default(0),
  itemsCount: integer("items_count").notNull().default(0),
  note: text("note").notNull().default(""),
  soldAt: text("sold_at").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sales_number_unique").on(table.saleNumber),
  index("sales_sold_at_idx").on(table.soldAt),
  index("sales_channel_idx").on(table.channel),
]);

export const saleItems = pgTable("sale_items", {
  id: text("id").primaryKey(),
  saleId: text("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  sku: text("sku").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
}, (table) => [
  index("sale_items_sale_idx").on(table.saleId),
  index("sale_items_product_idx").on(table.productId),
]);

export const expenses = pgTable("expenses", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  vendor: text("vendor").notNull().default(""),
  description: text("description").notNull(),
  amountCents: integer("amount_cents").notNull(),
  recurrence: text("recurrence").notNull().default("One-time"),
  expenseDate: text("expense_date").notNull(),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("expenses_date_idx").on(table.expenseDate),
  index("expenses_category_idx").on(table.category),
]);

export const storeEvents = pgTable("store_events", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  game: text("game").notNull().default("Other"),
  eventDate: text("event_date").notNull(),
  entryFeeCents: integer("entry_fee_cents").notNull().default(0),
  players: integer("players").notNull().default(0),
  prizeCostCents: integer("prize_cost_cents").notNull().default(0),
  otherCostCents: integer("other_cost_cents").notNull().default(0),
  status: text("status").notNull().default("Scheduled"),
  note: text("note").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
}, (table) => [
  index("events_date_idx").on(table.eventDate),
  index("events_game_idx").on(table.game),
]);
