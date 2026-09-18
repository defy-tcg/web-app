import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { Delivery, SyncBatch, SyncStore } from "./sync-core.ts";

const TABLES = { products: "shopify_products", variants: "shopify_variants", inventory: "shopify_inventory", orders: "shopify_orders", orderLines: "shopify_order_lines" } as const;
function connection() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  return neon(process.env.DATABASE_URL);
}
export interface InboxDelivery extends Delivery { leaseToken: string }
export class ShopifySyncRepository implements SyncStore {
  private sql = connection();
  async enqueue(shop: string, delivery: Delivery) {
    await this.sql.query(`INSERT INTO shopify_webhook_inbox(shop,id,topic,resource_id,location_id,triggered_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (shop,id) DO NOTHING`, [shop, delivery.id, delivery.topic, delivery.resourceId, delivery.locationId ?? null, delivery.triggeredAt]);
  }
  async hasDelivery(shop: string, id: string) {
    const rows = await this.sql.query("SELECT id FROM shopify_webhook_inbox WHERE shop=$1 AND id=$2 AND status='complete'", [shop, id]);
    return rows.length > 0;
  }
  async acquire(shop: string, id?: string): Promise<InboxDelivery | null> {
    const token = randomUUID();
    const rows = await this.sql.query(`WITH candidate AS (
      SELECT shop,id FROM shopify_webhook_inbox WHERE shop=$1 AND ($2::text IS NULL OR id=$2)
        AND status <> 'complete' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE shopify_webhook_inbox i SET status='processing', lease_token=$3, lease_until=now()+interval '90 seconds', attempts=attempts+1, updated_at=now()
      FROM candidate c WHERE i.shop=c.shop AND i.id=c.id RETURNING i.*`, [shop, id ?? null, token]);
    const row = rows[0];
    if (!row) return null;
    return { id: row.id as string, topic: row.topic as string, resourceId: row.resource_id as string,
      locationId: row.location_id as string | undefined, triggeredAt: new Date(row.triggered_at as string).toISOString(), leaseToken: token };
  }
  async fail(shop: string, delivery: InboxDelivery, message: string) {
    await this.sql.query(`UPDATE shopify_webhook_inbox SET status='failed', last_error=$4, lease_token=NULL, lease_until=NULL,
      next_attempt_at=now()+make_interval(secs => LEAST(3600, (power(2,LEAST(attempts,10))*15)::integer)), updated_at=now()
      WHERE shop=$1 AND id=$2 AND lease_token=$3 AND status <> 'complete'`, [shop, delivery.id, delivery.leaseToken, message.slice(0, 1000)]);
  }
  async apply(shop: string, delivery: Delivery, batch: SyncBatch, leaseToken?: string): Promise<boolean> {
    if (!leaseToken) throw new Error("A live delivery lease is required before applying Shopify projections.");
    const ctes = [`applied_delivery AS (
      UPDATE shopify_webhook_inbox SET status='complete',last_error=NULL,lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE shop=$1 AND id=$2 AND status='processing' AND lease_token=$3 RETURNING id
    )`];
    const values: unknown[] = [shop, delivery.id, leaseToken];
    if (batch.deferred?.length) {
      values.push(JSON.stringify(batch.deferred));
      ctes.push(`deferred_deliveries AS (INSERT INTO shopify_webhook_inbox(shop,id,topic,resource_id,location_id,triggered_at)
        SELECT $1,p.id,p.topic,p."resourceId",p."locationId",p."triggeredAt" FROM jsonb_to_recordset($${values.length}::jsonb)
        AS p(id text,topic text,"resourceId" text,"locationId" text,"triggeredAt" timestamptz)
        WHERE EXISTS (SELECT 1 FROM applied_delivery) ON CONFLICT (shop,id) DO NOTHING RETURNING id)`);
    }
    for (const [kind, table] of Object.entries(TABLES)) {
      const items = batch.projections.filter(item => item.kind === kind);
      if (!items.length) continue;
      values.push(JSON.stringify(items));
      const argument = `$${values.length}`;
      ctes.push(`upsert_${table} AS (
        INSERT INTO ${table} (shop,id,parent_id,source_updated_at,observed_at,deleted,data)
        SELECT $1,p.id,p."parentId",p."sourceUpdatedAt",p."observedAt",p.deleted,p.data
        FROM jsonb_to_recordset(${argument}::jsonb) AS p(id text,"parentId" text,"sourceUpdatedAt" timestamptz,"observedAt" timestamptz,deleted boolean,data jsonb)
        WHERE EXISTS (SELECT 1 FROM applied_delivery)
        ON CONFLICT (shop,id) DO UPDATE SET parent_id=COALESCE(EXCLUDED.parent_id,${table}.parent_id),source_updated_at=EXCLUDED.source_updated_at,
          observed_at=EXCLUDED.observed_at,deleted=EXCLUDED.deleted,data=EXCLUDED.data,synced_at=now()
        WHERE EXCLUDED.source_updated_at > ${table}.source_updated_at OR
          (EXCLUDED.source_updated_at = ${table}.source_updated_at AND NOT ${table}.deleted AND (EXCLUDED.deleted OR EXCLUDED.observed_at > ${table}.observed_at))
        RETURNING id
      )`);
    }
    for (const [index, replacement] of batch.replaceChildren.entries()) {
      const table = TABLES[replacement.kind];
      values.push(replacement.parentId, JSON.stringify(replacement.ids), replacement.sourceUpdatedAt, replacement.observedAt);
      const base = values.length - 3;
      ctes.push(`retire_${index} AS (UPDATE ${table} SET deleted=true,source_updated_at=$${base + 2}::timestamptz,observed_at=$${base + 3}::timestamptz,synced_at=now()
        WHERE shop=$1 AND parent_id=$${base} AND id NOT IN (SELECT jsonb_array_elements_text($${base + 1}::jsonb))
          AND (source_updated_at < $${base + 2}::timestamptz OR (source_updated_at = $${base + 2}::timestamptz AND observed_at <= $${base + 3}::timestamptz))
          AND EXISTS (SELECT 1 FROM applied_delivery) RETURNING id)`);
    }
    // One PostgreSQL statement: a failed projection rolls back the delivery completion as well.
    const rows = await this.sql.query(`WITH ${ctes.join(",\n")} SELECT id FROM applied_delivery`, values);
    return rows.length > 0;
  }
  async auditPage(shop: string, kind: "products" | "variants" | "orders", after: string | null) {
    const limit = kind === "orders" ? 1 : 25;
    const rows = await this.sql.query(`SELECT id FROM ${TABLES[kind]} WHERE shop=$1 AND NOT deleted AND ($2::text IS NULL OR id>$2)
      ${kind === "orders" ? "AND (data->>'createdAt')::timestamptz > now()-interval '59 days'" : ""} ORDER BY id LIMIT $3`, [shop, after, limit + 1]);
    const ids = rows.slice(0, limit).map(row => row.id as string);
    return { ids, hasNextPage: rows.length > limit, endCursor: ids.at(-1) ?? null };
  }
  async dashboard(shop: string, locationId: string) {
    const [inventory, orders, summaries, errors] = await Promise.all([
      this.sql.query(`SELECT v.id AS "variantId",p.id AS "productId",p.data->>'title' AS title,v.data->>'title' AS "variantTitle",v.data->>'sku' AS sku,
        v.data->>'price' AS price,i.data->>'locationId' AS "locationId",(i.data->>'available')::integer AS available,
        (i.data->>'onHand')::integer AS "onHand",(i.data->>'committed')::integer AS committed,i.source_updated_at AS "updatedAt"
        FROM shopify_inventory i JOIN shopify_variants v ON v.shop=i.shop AND v.id=i.parent_id JOIN shopify_products p ON p.shop=v.shop AND p.id=v.parent_id
        WHERE i.shop=$1 AND i.data->>'locationId'=$2 AND NOT i.deleted AND NOT v.deleted AND NOT p.deleted ORDER BY p.data->>'title',v.id LIMIT 100`, [shop, locationId]),
      this.sql.query(`SELECT id,data->>'name' AS name,data->>'createdAt' AS "createdAt",source_updated_at AS "updatedAt",data->>'cancelledAt' AS "cancelledAt",
        data->>'financialStatus' AS "financialStatus",data->>'fulfillmentStatus' AS "fulfillmentStatus",data->>'total' AS total,
        data->>'currencyCode' AS "currencyCode",(data->>'itemCount')::integer AS "itemCount" FROM shopify_orders WHERE shop=$1 AND NOT deleted ORDER BY source_updated_at DESC LIMIT 50`, [shop]),
      this.sql.query(`SELECT
        (SELECT count(*)::integer FROM shopify_products WHERE shop=$1 AND NOT deleted) AS products,
        (SELECT count(*)::integer FROM shopify_variants v JOIN shopify_products p ON p.shop=v.shop AND p.id=v.parent_id WHERE v.shop=$1 AND NOT v.deleted AND NOT p.deleted) AS variants,
        (SELECT count(*)::integer FROM shopify_inventory i JOIN shopify_variants v ON v.shop=i.shop AND v.id=i.parent_id JOIN shopify_products p ON p.shop=v.shop AND p.id=v.parent_id WHERE i.shop=$1 AND i.data->>'locationId'=$2 AND NOT i.deleted AND NOT v.deleted AND NOT p.deleted) AS inventory,
        (SELECT count(*)::integer FROM shopify_orders WHERE shop=$1 AND NOT deleted) AS orders,
        (SELECT count(*)::integer FROM shopify_webhook_inbox WHERE shop=$1 AND status IN ('pending','processing')) AS pending,
        (SELECT count(*)::integer FROM shopify_webhook_inbox WHERE shop=$1 AND status='failed') AS failed,
        (SELECT max(updated_at) FROM shopify_webhook_inbox WHERE shop=$1 AND status='complete') AS "lastSyncedAt"`, [shop, locationId]),
      this.sql.query("SELECT topic,last_error AS error,updated_at AS \"updatedAt\" FROM shopify_webhook_inbox WHERE shop=$1 AND status='failed' ORDER BY updated_at DESC LIMIT 10", [shop]),
    ]);
    return { inventory, orders, summary: summaries[0], recentErrors: errors };
  }
}
