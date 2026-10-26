import { neon } from '@neondatabase/serverless';
import { BulkError, BULK_ORDER_COPY_LIMIT, digest, WORKSPACES, type CommandInput, type NativeOrderSaleInput, type OrderData, type SyncInput } from './model.ts';

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new BulkError(503, 'Bulk Warehouse is temporarily unavailable.');
  return neon(url);
}
export function translateBulkError(error: unknown): BulkError {
  if (error instanceof BulkError) return error;
  const message = error instanceof Error ? error.message : '';
  const known: Record<string, string> = {
    warehouse_missing: 'This warehouse has not connected yet. Open Warehouse Manager and refresh.',
    source_conflict: 'This warehouse identifier belongs to a different game workspace. Sync is paused to preserve stock.',
    request_conflict: 'This request ID was already used for another action. The original action was kept.',
    queue_full: 'This warehouse has too many pending actions. Open Warehouse Manager to finish syncing.',
    sequence_gap: 'The warehouse change sequence is incomplete. Retry the saved sync batch.',
    replay_conflict: 'This warehouse history conflicts with a previously saved change. Sync is paused to preserve stock.',
    unknown_receipt: 'The warehouse receipt does not match a pending action.',
    unexpected_receipt: 'The warehouse action was already rejected.',
    receipt_conflict: 'The warehouse receipt conflicts with its original confirmation.',
    unsupported_event: 'The warehouse sent an unsupported change type. Update Warehouse Manager before retrying.',
    order_warehouse_missing: 'Choose an existing connected warehouse before recording an order amount.',
  };
  const key = /bulk:([a-z_]+)/.exec(message)?.[1];
  return key && known[key] ? new BulkError(key === 'queue_full' ? 429 : key === 'order_warehouse_missing' ? 400 : 409, known[key]) : new BulkError(503, 'Bulk Warehouse is temporarily unavailable. Your saved changes can be retried safely.');
}
export async function syncBulkWarehouse(ownerId: string, input: SyncInput) {
  try {
    const sql = database();
    const rows = await sql`SELECT defy_bulk.apply_sync(${ownerId},${JSON.stringify(input)}::jsonb,${JSON.stringify(input.events.map(digest))}::jsonb) AS result`;
    return rows[0].result;
  } catch (error) { throw translateBulkError(error); }
}
export async function queueBulkCommand(actorId: string, input: CommandInput) {
  try {
    const sql = database();
    const rows = await sql`SELECT defy_bulk.queue_command(${actorId},${JSON.stringify(input)}::jsonb,${digest(input)}) AS result`;
    return rows[0].result;
  } catch (error) { throw translateBulkError(error); }
}
export async function recordNativeOrderSale(actorId: string, input: NativeOrderSaleInput) {
  try {
    const sql = database();
    const rows = await sql`SELECT defy_bulk.record_order_sale(${actorId},${JSON.stringify(input)}::jsonb,${digest(input)}) AS result`;
    return rows[0].result;
  } catch (error) { throw translateBulkError(error); }
}
export async function readNativeOrderForSale(input: { warehouseId: string; orderId: string }) {
  try {
    const sql = database();
    const rows = await sql`SELECT o.data,COALESCE(s.id,cs.id) AS "saleId",COALESCE(s.data->>'saleNumber',cs.data->>'saleNumber') AS "saleNumber",c.status AS "linkedStatus"
      FROM defy_bulk.orders o
      LEFT JOIN defy_bulk.sales s ON s.warehouse_id=o.warehouse_id AND s.native_order_id=o.order_id
      LEFT JOIN defy_bulk.commands c ON c.warehouse_id=o.warehouse_id AND c.id::text=o.data->>'storeCommandId' AND c.payload->>'kind'='sale'
        AND ARRAY(SELECT value FROM jsonb_array_elements_text(o.data->'copyIds') ORDER BY value)
          = ARRAY(SELECT value->>'copyId' FROM jsonb_array_elements(c.payload->'copies') ORDER BY value->>'copyId')
      LEFT JOIN defy_bulk.sales cs ON cs.command_id=c.id AND cs.warehouse_id=c.warehouse_id
      WHERE o.warehouse_id=${input.warehouseId}::uuid AND o.order_id=${input.orderId} AND NOT o.deleted`;
    const row = rows[0];
    if (!row) throw new BulkError(404, 'This native order is no longer available. Refresh the order list.');
    const order = row.data as OrderData;
    const financialStatus = row.saleId ? 'recorded' : ['pending', 'applied'].includes(String(row.linkedStatus)) ? 'pending'
      : order.status === 'shipped' && order.copyIds.length > 0 ? 'unpriced' : 'ineligible';
    return { order: { warehouseId: input.warehouseId, orderId: input.orderId, ...order }, financialStatus, saleId: row.saleId, saleNumber: row.saleNumber };
  } catch (error) { throw translateBulkError(error); }
}
export function inventoryQuery(url: URL) {
  const allowed = ['q', 'workspace', 'status', 'page'];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new BulkError(400, 'Unsupported inventory filter.');
  const q = (url.searchParams.get('q') || '').trim();
  const workspace = url.searchParams.get('workspace') || 'all';
  const status = url.searchParams.get('status') || 'all';
  const pageValue = url.searchParams.get('page') || '1';
  if (q.length > 200 || (workspace !== 'all' && !WORKSPACES.includes(workspace as typeof WORKSPACES[number])) || !['all', 'available', 'unavailable'].includes(status) || !/^[1-9]\d{0,5}$/.test(pageValue)) throw new BulkError(400, 'Invalid inventory filter.');
  return { q, workspace, status, page: Number(pageValue), pageSize: 100 };
}
export async function readBulkInventory(filters: ReturnType<typeof inventoryQuery>) {
  try {
    const sql = database(), { q, workspace, status, page, pageSize } = filters;
    const search = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const filter = sql`NOT c.deleted AND (${workspace}='all' OR w.workspace=${workspace})
      AND (${q}='' OR c.data->>'name' ILIKE ${search} OR c.data->>'serial' ILIKE ${search}
        OR c.data->>'sku' ILIKE ${search} OR c.data->>'setName' ILIKE ${search}
        OR c.data->>'cardNumber' ILIKE ${search} OR c.data->>'location' ILIKE ${search})
      AND (${status}='all' OR (${status}='available' AND c.data->>'available'='true' AND h.command_id IS NULL)
        OR (${status}='unavailable' AND (c.data->>'available'<>'true' OR h.command_id IS NOT NULL)))`;
    const results = await sql.transaction([
      sql`SELECT c.warehouse_id AS "warehouseId",c.copy_id AS "copyId",c.sequence::float8 AS sequence,c.data,(h.command_id IS NOT NULL) AS pending
        FROM defy_bulk.copies c JOIN defy_bulk.warehouses w ON w.id=c.warehouse_id
        LEFT JOIN defy_bulk.holds h ON h.warehouse_id=c.warehouse_id AND h.copy_id=c.copy_id
        WHERE ${filter} ORDER BY w.workspace,c.data->>'name',c.data->>'serial',c.copy_id LIMIT ${pageSize} OFFSET ${(page-1)*pageSize}`,
      sql`SELECT count(*)::int AS total FROM defy_bulk.copies c JOIN defy_bulk.warehouses w ON w.id=c.warehouse_id
        LEFT JOIN defy_bulk.holds h ON h.warehouse_id=c.warehouse_id AND h.copy_id=c.copy_id WHERE ${filter}`,
      sql`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE c.data->>'available'='true' AND h.command_id IS NULL)::int AS available,
        count(*) FILTER(WHERE h.command_id IS NOT NULL)::int AS pending
        FROM defy_bulk.copies c LEFT JOIN defy_bulk.holds h ON h.warehouse_id=c.warehouse_id AND h.copy_id=c.copy_id WHERE NOT c.deleted`,
      sql`SELECT id,workspace,name,last_synced_at AS "lastSyncedAt",ack_sequence::float8 AS "ackSequence" FROM defy_bulk.warehouses ORDER BY workspace,name,id`,
      sql`SELECT id,warehouse_id AS "warehouseId",CASE WHEN payload->>'kind'='record_order_sale' THEN 'sale' ELSE payload->>'kind' END AS kind,status,message,created_at AS "createdAt",updated_at AS "updatedAt"
        FROM defy_bulk.commands ORDER BY created_at DESC,id DESC LIMIT 100`,
      sql`WITH recent AS (
        SELECT warehouse_id,order_id,data,sum(jsonb_array_length(data->'copyIds')) OVER(ORDER BY (data->>'createdAt')::timestamptz DESC,warehouse_id,order_id) AS copy_budget
        FROM defy_bulk.unpriced_native_orders ORDER BY (data->>'createdAt')::timestamptz DESC,warehouse_id,order_id LIMIT 50
      ) SELECT warehouse_id AS "warehouseId",order_id AS "orderId",data->>'reference' AS reference,
        data->>'status' AS status,jsonb_array_length(data->'copyIds') AS "copyCount",data->>'createdAt' AS "createdAt",
        data->>'fingerprint' AS fingerprint,data->'copyIds' AS "copyIds"
        FROM recent WHERE copy_budget<=${BULK_ORDER_COPY_LIMIT} ORDER BY (data->>'createdAt')::timestamptz DESC,warehouse_id,order_id`,
      sql`SELECT count(*)::int AS count FROM defy_bulk.unpriced_native_orders`,
    ], { isolationLevel: 'RepeatableRead', readOnly: true });
    return { copies: results[0], total: results[1][0].total, page, pageSize, summary: results[2][0], warehouses: results[3], commands: results[4],
      unpricedOrders: results[5], unpricedOrderCount: results[6][0].count };
  } catch (error) { throw translateBulkError(error); }
}
export async function readBulkSales(limit = 1000) {
  const sql = database();
  try {
    const results = await sql.transaction([
      sql`SELECT data FROM defy_bulk.sales ORDER BY sold_at DESC,id DESC LIMIT ${limit+1}`,
      sql`SELECT count(*)::int AS count FROM defy_bulk.unpriced_native_orders`,
    ], { isolationLevel: 'RepeatableRead', readOnly: true });
    const rows = results[0];
    const data = rows.slice(0, limit).map(row => row.data as Record<string, unknown> & { items: Record<string, unknown>[] });
    return { sales: data.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'items'))), saleItems: data.flatMap(sale => sale.items), hasMore: rows.length > limit,
      unpricedNativeOrders: results[1][0].count };
  } catch (error) {
    // A pre-migration deployment must retain ordinary store reports. The bulk
    // inventory endpoint remains visibly unavailable until schema is installed.
    if (['42P01', '3F000'].includes(String((error as { code?: string }).code))) return { sales: [], saleItems: [], hasMore: false, unpricedNativeOrders: 0 };
    throw translateBulkError(error);
  }
}
