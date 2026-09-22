import { neon } from "@neondatabase/serverless";
import type { products } from "../db/schema.ts";
import { tcgplayerImageUrl } from "./catalog-image.ts";
import { TCG_GAME_REGISTRY } from "./tcg-games.ts";
import { INVENTORY_LABEL_FINISH_ALIASES, inventoryLabelConflictError, inventoryLabelIdentityText, inventoryLabelVariantKey, validateInventoryLabels, validateSkuLabelReservation,
  type InventoryLabelConflict, type InventoryLabelInput } from "./sku-label-inventory.ts";

export type SavedSkuLabelProduct = typeof products.$inferSelect & { imageUrl: string | null };
export type SaveSkuLabelsResult = { products: SavedSkuLabelProduct[]; createdCount: number; existingCount: number };
export type ReserveSkuLabelResult = { product: SavedSkuLabelProduct; created: boolean };

// All interpolated SQL fragments below are fixed identifiers or our checked-in game registry.
function identitySql(column: string) {
  return `trim(regexp_replace(lower(normalize(coalesce(${column}, ''), NFKC)), '[[:space:]]+', ' ', 'g'))`;
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const gameSql = `CASE ${identitySql("p.game")} ${TCG_GAME_REGISTRY.flatMap((game) =>
  [...new Set([game.key, game.name, game.label, ...game.aliases].map(inventoryLabelIdentityText))]
    .map((alias) => `WHEN ${literal(alias)} THEN ${literal(inventoryLabelIdentityText(game.name))}`)).join(" ")} ELSE 'other' END`;
const finishSql = `CASE ${identitySql("p.finish")} ${INVENTORY_LABEL_FINISH_ALIASES.flatMap(([canonical, aliases]) =>
  aliases.map((alias) => `WHEN ${literal(inventoryLabelIdentityText(alias))} THEN ${literal(inventoryLabelIdentityText(canonical))}`)).join(" ")} ELSE ${identitySql("p.finish")} END`;
const variantSql = `jsonb_build_array(${gameSql}, ${["name", "set_name", "card_number", "condition"].map((column) => identitySql(`p.${column}`)).join(", ")}, ${finishSql})`;

const SAVE_LABELS_SQL = `
WITH incoming AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS i(
    ordinal integer, sku text, name text, game text, "setName" text, "cardNumber" text,
    condition text, finish text, quantity integer, "costCents" integer, "listPriceCents" integer,
    location text, "tcgplayerId" integer, "variantKey" jsonb)
), current_products AS MATERIALIZED (
  SELECT p.*, upper(trim(p.sku)) AS sku_key, upper(trim(p.barcode)) AS barcode_key,
    ${variantSql} AS variant_key, ${gameSql} AS game_key,
    ${identitySql("p.condition")} AS condition_key, ${finishSql} AS finish_key
  FROM products p
), conflicts AS MATERIALIZED (
  SELECT 1 AS priority, i.ordinal, 'sku' AS kind, i.sku, p.sku AS existing_sku
  FROM incoming i JOIN current_products p ON p.sku_key = i.sku
  WHERE p.product_type <> 'Single' OR (p.variant_key <> i."variantKey" AND NOT
    (i."tcgplayerId" IS NOT NULL AND p.tcgplayer_id IS NOT NULL AND p.tcgplayer_id = i."tcgplayerId" AND
     p.condition_key = i."variantKey"->>4 AND p.finish_key = i."variantKey"->>5)) OR
    (p.tcgplayer_id IS NOT NULL AND i."tcgplayerId" IS NOT NULL AND p.tcgplayer_id <> i."tcgplayerId")
  UNION ALL
  SELECT 2, i.ordinal, 'barcode', i.sku, p.sku
  FROM incoming i JOIN current_products p ON p.barcode_key = i.sku AND p.sku_key <> i.sku
  UNION ALL
  SELECT 3, i.ordinal, 'variant', i.sku, p.sku
  FROM incoming i JOIN current_products p ON p.product_type = 'Single' AND p.sku_key <> i.sku AND
    (p.variant_key = i."variantKey" OR
      (i."tcgplayerId" IS NOT NULL AND p.tcgplayer_id = i."tcgplayerId" AND
       p.condition_key = i."variantKey"->>4 AND p.finish_key = i."variantKey"->>5))
), inserted AS (
  INSERT INTO products (sku, name, product_type, game, set_name, card_number, condition, finish,
    quantity, cost_cents, list_price_cents, location, tcgplayer_id, tcgplayer_url, price_source)
  SELECT i.sku, i.name, 'Single', i.game, i."setName", i."cardNumber", i.condition, i.finish,
    i.quantity, i."costCents", i."listPriceCents", i.location, i."tcgplayerId",
    CASE WHEN i."tcgplayerId" IS NULL THEN NULL ELSE 'https://www.tcgplayer.com/product/' || i."tcgplayerId" END, 'manual'
  FROM incoming i
  WHERE NOT EXISTS (SELECT 1 FROM conflicts) AND NOT EXISTS (SELECT 1 FROM current_products p WHERE p.sku_key = i.sku)
  ORDER BY i.ordinal
  RETURNING *
), initial_movements AS (
  INSERT INTO inventory_movements (product_id, delta, reason, note)
  SELECT id, quantity, 'received', 'Initial quantity from QR SKU labels' FROM inserted WHERE quantity > 0
  RETURNING id
), result_products AS (
  SELECT i.ordinal, to_jsonb(p) AS product, true AS created
  FROM incoming i JOIN inserted p ON p.sku = i.sku
  UNION ALL
  SELECT i.ordinal, to_jsonb(p) - 'sku_key' - 'barcode_key' - 'variant_key' - 'game_key' - 'condition_key' - 'finish_key', false
  FROM incoming i JOIN current_products p ON p.sku_key = i.sku WHERE NOT EXISTS (SELECT 1 FROM conflicts)
)
SELECT
  (SELECT jsonb_build_object('kind', kind, 'sku', sku, 'existingSku', existing_sku)
   FROM conflicts ORDER BY ordinal, priority, existing_sku LIMIT 1) AS conflict,
  coalesce((SELECT jsonb_agg(product ORDER BY ordinal) FROM result_products), '[]'::jsonb) AS products,
  (SELECT count(*)::integer FROM result_products WHERE created) AS "createdCount",
  (SELECT count(*)::integer FROM result_products WHERE NOT created) AS "existingCount",
  (SELECT count(*)::integer FROM initial_movements) AS "movementCount"
`;

const RESERVE_LABEL_SQL = `
WITH incoming AS MATERIALIZED (
  SELECT * FROM jsonb_to_record($1::jsonb) AS i(
    sku text, name text, game text, "setName" text, "cardNumber" text,
    condition text, finish text, quantity integer, location text, "tcgplayerId" integer, "variantKey" jsonb)
), current_products AS MATERIALIZED (
  SELECT p.*, upper(trim(p.sku)) AS sku_key, upper(trim(p.barcode)) AS barcode_key,
    ${variantSql} AS variant_key, ${gameSql} AS game_key,
    ${identitySql("p.condition")} AS condition_key, ${finishSql} AS finish_key
  FROM products p
), matching_products AS MATERIALIZED (
  SELECT p.* FROM current_products p CROSS JOIN incoming i
  WHERE p.product_type = 'Single' AND
    ((p.variant_key = i."variantKey" AND (p.tcgplayer_id IS NULL OR p.tcgplayer_id = i."tcgplayerId")) OR
      (p.tcgplayer_id = i."tcgplayerId" AND
       p.condition_key = i."variantKey"->>4 AND p.finish_key = i."variantKey"->>5))
), selected_product AS MATERIALIZED (
  SELECT p.* FROM matching_products p
  ORDER BY p.created_at, p.id LIMIT 1
), conflicts AS MATERIALIZED (
  SELECT 1 AS priority, 'sku' AS kind, i.sku, p.sku AS existing_sku
  FROM incoming i JOIN current_products p ON p.sku_key = i.sku
  WHERE NOT EXISTS (SELECT 1 FROM matching_products m WHERE m.id = p.id)
  UNION ALL
  SELECT 2, 'barcode', i.sku, p.sku
  FROM incoming i JOIN current_products p ON p.barcode_key = i.sku
  WHERE NOT EXISTS (SELECT 1 FROM selected_product m WHERE m.id = p.id)
  UNION ALL
  SELECT 2, 'barcode', m.sku, p.sku
  FROM selected_product m JOIN current_products p ON p.barcode_key = m.sku_key AND p.id <> m.id
  UNION ALL
  SELECT 3, 'variant', i.sku, m.sku
  FROM selected_product m CROSS JOIN incoming i
  WHERE m.sku !~ '^(?:[A-Z0-9]{1,4}-)?[1-9][0-9]{9}$'
  UNION ALL
  SELECT 3, 'variant', i.sku, p.sku
  FROM incoming i JOIN current_products p ON p.product_type = 'Single' AND p.variant_key = i."variantKey"
  WHERE p.tcgplayer_id IS NOT NULL AND p.tcgplayer_id <> i."tcgplayerId"
), linked AS (
  UPDATE products p SET tcgplayer_id = i."tcgplayerId",
    tcgplayer_url = 'https://www.tcgplayer.com/product/' || i."tcgplayerId"
  FROM selected_product selected CROSS JOIN incoming i
  WHERE p.id = selected.id AND p.tcgplayer_id IS NULL AND NOT EXISTS (SELECT 1 FROM conflicts)
  RETURNING p.*
), inserted AS (
  INSERT INTO products (sku, name, product_type, game, set_name, card_number, condition, finish,
    quantity, cost_cents, list_price_cents, location, tcgplayer_id, tcgplayer_url, price_source)
  SELECT i.sku, i.name, 'Single', i.game, i."setName", i."cardNumber", i.condition, i.finish,
    i.quantity, 0, 0, i.location, i."tcgplayerId", 'https://www.tcgplayer.com/product/' || i."tcgplayerId", 'manual'
  FROM incoming i
  WHERE NOT EXISTS (SELECT 1 FROM conflicts) AND NOT EXISTS (SELECT 1 FROM selected_product)
  RETURNING *
), initial_movements AS (
  INSERT INTO inventory_movements (product_id, delta, reason, note)
  SELECT id, quantity, 'received', 'Initial quantity from QR SKU labels' FROM inserted WHERE quantity > 0
  RETURNING id
), result_product AS (
  SELECT to_jsonb(p) AS product, true AS created FROM inserted p
  UNION ALL
  SELECT to_jsonb(p), false FROM linked p
  UNION ALL
  SELECT to_jsonb(p) - 'sku_key' - 'barcode_key' - 'variant_key' - 'game_key' - 'condition_key' - 'finish_key', false
  FROM selected_product p WHERE NOT EXISTS (SELECT 1 FROM conflicts) AND NOT EXISTS (SELECT 1 FROM linked)
)
SELECT
  (SELECT jsonb_build_object('kind', kind, 'sku', sku, 'existingSku', existing_sku)
   FROM conflicts ORDER BY priority, existing_sku LIMIT 1) AS conflict,
  (SELECT product FROM result_product) AS product,
  (SELECT created FROM result_product) AS created,
  (SELECT count(*)::integer FROM initial_movements) AS "movementCount"
`;

const COLUMN_NAMES = {
  product_type: "productType", tcgplayer_id: "tcgplayerId", tcgplayer_url: "tcgplayerUrl", set_name: "setName",
  card_number: "cardNumber", sheet_quantity: "sheetQuantity", cost_cents: "costCents", market_price_cents: "marketPriceCents",
  list_price_cents: "listPriceCents", low_stock_threshold: "lowStockThreshold", price_source: "priceSource",
  price_updated_at: "priceUpdatedAt", created_at: "createdAt", updated_at: "updatedAt",
} as const;

function productRecord(row: Record<string, unknown>): SavedSkuLabelProduct {
  const product = Object.fromEntries(Object.entries(row).map(([key, value]) => [COLUMN_NAMES[key as keyof typeof COLUMN_NAMES] ?? key, value])) as typeof products.$inferSelect;
  return { ...product, imageUrl: tcgplayerImageUrl(product.tcgplayerId, product.tcgplayerUrl) };
}

export async function saveSkuLabelsToInventory(inputs: readonly InventoryLabelInput[]): Promise<SaveSkuLabelsResult> {
  const labels = validateInventoryLabels({ labels: inputs });
  if (!process.env.DATABASE_URL) throw new Error("Inventory database is unavailable.");
  const sql = neon(process.env.DATABASE_URL);
  const incoming = labels.map((label, ordinal) => ({ ...label, ordinal, variantKey: JSON.parse(inventoryLabelVariantKey(label)) }));
  // Acquire the write lock in a separate statement so READ COMMITTED takes a fresh
  // snapshot after waiting. Other app writers cannot insert a duplicate variant
  // between checking and inserting; normal inventory reads continue throughout.
  const results = await sql.transaction([
    sql.query("SET LOCAL lock_timeout = '5s'"),
    sql.query("SET LOCAL statement_timeout = '15s'"),
    sql.query("LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE"),
    sql.query(SAVE_LABELS_SQL, [JSON.stringify(incoming)]),
  ], { isolationLevel: "ReadCommitted" });
  const result = results[3][0] as {
    conflict: InventoryLabelConflict | null; products: Record<string, unknown>[]; createdCount: number; existingCount: number;
  } | undefined;
  if (!result) throw new Error("Inventory save returned no result.");
  if (result.conflict) throw inventoryLabelConflictError(result.conflict);
  if (result.products.length !== labels.length) throw new Error("Inventory save returned an incomplete batch.");
  return { products: result.products.map(productRecord), createdCount: result.createdCount, existingCount: result.existingCount };
}

/** Persist one reusable QR identity; concurrent requests receive the first saved SKU. */
export async function reserveSkuLabel(input: InventoryLabelInput): Promise<ReserveSkuLabelResult> {
  const label = validateSkuLabelReservation({ label: input });
  if (!process.env.DATABASE_URL) throw new Error("Inventory database is unavailable.");
  const sql = neon(process.env.DATABASE_URL);
  const incoming = { ...label, variantKey: JSON.parse(inventoryLabelVariantKey(label)) };
  // This conflicts with every products writer, including the regular label save.
  // The following statement gets a fresh snapshot after any lock wait finishes.
  const results = await sql.transaction([
    sql.query("SET LOCAL lock_timeout = '5s'"),
    sql.query("SET LOCAL statement_timeout = '15s'"),
    sql.query("LOCK TABLE products IN SHARE ROW EXCLUSIVE MODE"),
    sql.query(RESERVE_LABEL_SQL, [JSON.stringify(incoming)]),
  ], { isolationLevel: "ReadCommitted" });
  const result = results[3][0] as {
    conflict: InventoryLabelConflict | null; product: Record<string, unknown> | null; created: boolean | null;
  } | undefined;
  if (!result) throw new Error("QR code save returned no result.");
  if (result.conflict) throw inventoryLabelConflictError(result.conflict);
  if (!result.product || result.created === null) throw new Error("QR code save returned no product.");
  return { product: productRecord(result.product), created: result.created };
}

export type ShopifyLinkableSkuProduct = SavedSkuLabelProduct & { initialQuantity: number };

/** The immutable first receipt, never the current balance, determines Shopify's one-time stock addition. */
export async function loadSkuLabelProducts(options: { skus?: readonly string[]; afterId?: number; limit?: number } = {}): Promise<ShopifyLinkableSkuProduct[]> {
  if (!process.env.DATABASE_URL) throw new Error("Inventory database is unavailable.");
  const skus = options.skus ? [...new Set(options.skus)] : null;
  if (skus?.length === 0) return [];
  if (skus && (skus.length > 100 || skus.some(sku => !/^(?:[A-Z0-9]{1,4}-)?[1-9][0-9]{9}$/.test(sku)))) throw new Error("Provide at most 100 saved QR SKUs.");
  const afterId = options.afterId ?? 0;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid saved QR page.");
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql.query(`SELECT p.*, coalesce((
    SELECT m.delta FROM inventory_movements m WHERE m.product_id = p.id
      AND m.reason = 'received' AND m.note = 'Initial quantity from QR SKU labels'
    ORDER BY m.id LIMIT 1
  ), 0) AS initial_quantity FROM products p
  WHERE p.product_type = 'Single' AND p.sku ~ '^(?:[A-Z0-9]{1,4}-)?[1-9][0-9]{9}$'
    AND ($1::text[] IS NULL OR p.sku = ANY($1::text[])) AND p.id > $2
  ORDER BY p.id LIMIT $3`, [skus, afterId, limit]);
  return rows.map(row => {
    const { initial_quantity, ...product } = row;
    const initialQuantity = Number(initial_quantity);
    if (!Number.isSafeInteger(initialQuantity) || initialQuantity < 0 || initialQuantity > 100_000) throw new Error("The initial card receipt needs review.");
    return { ...productRecord(product), initialQuantity };
  });
}
