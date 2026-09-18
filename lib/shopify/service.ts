import { randomUUID } from "node:crypto";
import { ShopifySyncRepository } from "./repository.ts";
import { configBlockers, createReadClient, type ReadGraphQL, type SyncConfig } from "./read-client.ts";
import { decodeCursor, encodeCursor, processDelivery, ShopifySyncError, type Delivery } from "./sync-core.ts";
import { fetchDeliverySnapshot, fetchReconcilePage } from "./snapshots.ts";

export function syncErrorMessage(error: unknown): string {
  return error instanceof ShopifySyncError ? error.message : "Synchronization could not finish. Check the database migration and Shopify connection, then retry.";
}
export function requireSync(config: SyncConfig) {
  if (!config.enabled) throw new ShopifySyncError("SYNC_DISABLED", "Shopify sync is disabled. Apply the reviewed migration and configure the connection before enabling it.");
  const blockers = configBlockers(config);
  if (blockers.length) throw new ShopifySyncError("CONNECTION_REQUIRED", blockers.join(" "));
}
export async function drainInbox(config: SyncConfig, limit = 3) {
  requireSync(config);
  const repository = new ShopifySyncRepository();
  let graphql: ReadGraphQL | undefined;
  let processed = 0;
  let failed = 0;
  const started = Date.now();
  for (let index = 0; index < limit && Date.now() - started < 30_000; index++) {
    const delivery = await repository.acquire(config.shop);
    if (!delivery) break;
    try {
      graphql ??= await createReadClient(config);
      const client = graphql;
      await processDelivery(config.shop, delivery, repository, async () => delivery.topic === "reconcile"
        ? (await fetchReconcilePage(client, decodeCursor(delivery.resourceId), config.locationId, (kind, after) => repository.auditPage(config.shop, kind, after))).batch
        : fetchDeliverySnapshot(client, delivery, config.locationId), delivery.leaseToken);
      processed++;
    } catch (error) {
      await repository.fail(config.shop, delivery, syncErrorMessage(error));
      failed++;
    }
  }
  return { processed, failed };
}
export async function reconcilePage(config: SyncConfig, cursorValue: unknown) {
  requireSync(config);
  const cursor = decodeCursor(cursorValue);
  const graphql = await createReadClient(config);
  const repository = new ShopifySyncRepository();
  const delivery: Delivery = { id: `reconcile:${randomUUID()}`, topic: "reconcile", resourceId: encodeCursor(cursor), triggeredAt: new Date().toISOString() };
  await repository.enqueue(config.shop, delivery);
  const lease = await repository.acquire(config.shop, delivery.id);
  if (!lease) throw new ShopifySyncError("SYNC_BUSY", "This reconciliation page is already running.");
  try {
    const page = await fetchReconcilePage(graphql, cursor, config.locationId, (kind, after) => repository.auditPage(config.shop, kind, after));
    if (!await repository.apply(config.shop, delivery, page.batch, lease.leaseToken)) throw new ShopifySyncError("SYNC_BUSY", "The sync lease changed. Retry this page.");
    // Work is bounded per request; cron/after() handle larger webhook backlogs.
    const pending = await drainInbox(config, 1);
    return { processed: page.processed, nextCursor: page.nextCursor, done: page.done, pendingProcessed: pending.processed };
  } catch (error) {
    await repository.fail(config.shop, lease, syncErrorMessage(error));
    throw error;
  }
}
