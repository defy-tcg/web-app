import type { ReadGraphQL } from "./read-client.ts";
import { ShopifySyncError, encodeCursor, type Delivery, type Projection, type ReconcileCursor, type SyncBatch } from "./sync-core.ts";

interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface Product { id: string; title: string; handle: string; status: string; updatedAt: string }
interface Level { updatedAt: string; quantities: { name: string; quantity: number }[] }
interface Variant { id: string; title: string; sku: string | null; price: string; updatedAt: string; product: Product; inventoryItem: { id: string; tracked: boolean; inventoryLevel: Level | null } }
interface OrderLine { id: string; title: string; sku: string | null; quantity: number; currentQuantity: number; originalUnitPriceSet: { shopMoney: { amount: string; currencyCode: string } }; variant: Pick<Variant, "id"> | Variant | null }
interface Order { id: string; name: string; createdAt: string; updatedAt: string; cancelledAt: string | null; displayFinancialStatus: string | null; displayFulfillmentStatus: string; currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } }; lineItems: { nodes: OrderLine[]; pageInfo: PageInfo } }
const PRODUCT_FIELDS = "id title handle status updatedAt";
const LEVEL_FIELDS = `updatedAt quantities(names: ["available", "on_hand", "committed"]) { name quantity }`;
const VARIANT_FIELDS = `id title sku price updatedAt product { ${PRODUCT_FIELDS} } inventoryItem { id tracked inventoryLevel(locationId: $locationId) { ${LEVEL_FIELDS} } }`;
const ORDER_FIELDS = `id name createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 100) { nodes { id title sku quantity currentQuantity originalUnitPriceSet { shopMoney { amount currencyCode } } variant { id } } pageInfo { hasNextPage endCursor } }`;
function empty(): SyncBatch { return { projections: [], replaceChildren: [] }; }
function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new ShopifySyncError("INVALID_SNAPSHOT", "Shopify returned an invalid version timestamp.");
  return new Date(value).toISOString();
}
function projection(kind: Projection["kind"], id: string, parentId: string | null, sourceUpdatedAt: string, observedAt: string, data: Record<string, unknown>, deleted = false): Projection {
  return { kind, id, parentId, sourceUpdatedAt: timestamp(sourceUpdatedAt), observedAt, data, deleted };
}
export function inventoryProjection(itemId: string, variantId: string | null, locationId: string, level: Level | null, observedAt: string, missingAt = observedAt): Projection {
  const quantities = new Map(level?.quantities.map(quantity => [quantity.name, quantity.quantity]));
  return projection("inventory", `${itemId}@${locationId}`, variantId, level?.updatedAt ?? missingAt, observedAt,
    { inventoryItemId: itemId, locationId, available: quantities.get("available") ?? 0, onHand: quantities.get("on_hand") ?? 0, committed: quantities.get("committed") ?? 0 }, !level);
}
function addVariant(batch: SyncBatch, variant: Variant, locationId: string, observedAt: string) {
  const product = variant.product;
  batch.projections.push(projection("products", product.id, null, product.updatedAt, observedAt, { title: product.title, handle: product.handle, status: product.status }));
  batch.projections.push(projection("variants", variant.id, product.id, variant.updatedAt, observedAt, { title: variant.title, sku: variant.sku ?? "", price: variant.price, inventoryItemId: variant.inventoryItem.id, tracked: variant.inventoryItem.tracked }));
  batch.projections.push(inventoryProjection(variant.inventoryItem.id, variant.id, locationId, variant.inventoryItem.inventoryLevel, observedAt));
}
function addOrder(batch: SyncBatch, order: Order, locationId: string, observedAt: string) {
  if (order.lineItems.pageInfo.hasNextPage) throw new ShopifySyncError("ORDER_TOO_LARGE", "An order exceeds 100 lines. Its sync remains pending for owner review; no partial order was saved.");
  batch.projections.push(projection("orders", order.id, null, order.updatedAt, observedAt, { name: order.name, createdAt: order.createdAt, cancelledAt: order.cancelledAt,
    financialStatus: order.displayFinancialStatus ?? "UNKNOWN", fulfillmentStatus: order.displayFulfillmentStatus, total: order.currentTotalPriceSet.shopMoney.amount,
    currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode, itemCount: order.lineItems.nodes.reduce((sum, line) => sum + line.currentQuantity, 0) }));
  for (const line of order.lineItems.nodes) {
    batch.projections.push(projection("orderLines", line.id, order.id, order.updatedAt, observedAt, { title: line.title, sku: line.sku ?? "", quantity: line.quantity, currentQuantity: line.currentQuantity,
      unitPrice: line.originalUnitPriceSet.shopMoney.amount, currencyCode: line.originalUnitPriceSet.shopMoney.currencyCode, variantId: line.variant?.id ?? null }));
    // Shopify has already accounted for order inventory. Read its absolute level; never subtract line quantities.
    if (line.variant && "inventoryItem" in line.variant) addVariant(batch, line.variant, locationId, observedAt);
  }
  batch.replaceChildren.push({ kind: "orderLines", parentId: order.id, ids: order.lineItems.nodes.map(line => line.id), sourceUpdatedAt: timestamp(order.updatedAt), observedAt });
}
async function hydrateOrderInventory(graphql: ReadGraphQL, order: Order, locationId: string) {
  const ids = [...new Set(order.lineItems.nodes.flatMap(line => line.variant && !("inventoryItem" in line.variant) ? [line.variant.id] : []))];
  const variants = new Map<string, Variant>();
  for (let index = 0; index < ids.length; index += 25) {
    const pageIds = ids.slice(index, index + 25);
    const data = await graphql<{ nodes: (Variant | null)[] }>(`query DefyOrderInventory($ids: [ID!]!, $locationId: ID!) {
      nodes(ids: $ids) { ... on ProductVariant { ${VARIANT_FIELDS} } }
    }`, { ids: pageIds, locationId });
    if (data.nodes.length !== pageIds.length || data.nodes.some((node, itemIndex) => node && node.id !== pageIds[itemIndex])) throw new ShopifySyncError("INVALID_SNAPSHOT", "Shopify did not confirm the order's inventory identities.");
    for (const variant of data.nodes) if (variant) variants.set(variant.id, variant);
  }
  return { ...order, lineItems: { ...order.lineItems, nodes: order.lineItems.nodes.map(line => ({ ...line, variant: line.variant ? variants.get(line.variant.id) ?? line.variant : null })) } };
}
async function addReconciledOrder(graphql: ReadGraphQL, batch: SyncBatch, order: Order, locationId: string, observedAt: string) {
  if (!order.lineItems.pageInfo.hasNextPage) return addOrder(batch, await hydrateOrderInventory(graphql, order, locationId), locationId, observedAt);
  // Isolate unsupported large orders so one order never prevents subsequent pages from syncing.
  batch.deferred ??= [];
  batch.deferred.push({ id: `oversize:${order.id}:${order.updatedAt}`, topic: "orders/updated", resourceId: order.id, triggeredAt: timestamp(order.updatedAt) });
}
export function deduplicateBatch(batch: SyncBatch): SyncBatch {
  const projections = new Map<string, Projection>();
  for (const item of batch.projections) {
    const key = `${item.kind}:${item.id}`;
    const previous = projections.get(key);
    if (!previous || Date.parse(item.sourceUpdatedAt) >= Date.parse(previous.sourceUpdatedAt)) projections.set(key, item);
  }
  return { ...batch, projections: [...projections.values()] };
}
export async function fetchDeliverySnapshot(graphql: ReadGraphQL, delivery: Delivery, locationId: string): Promise<SyncBatch> {
  const observedAt = new Date().toISOString();
  const batch = empty();
  if (delivery.topic.startsWith("inventory_levels/")) {
    if (delivery.locationId !== locationId) return batch;
    const data = await graphql<{ inventoryItem: { variant: { id: string } | null; inventoryLevel: Level | null } | null }>(`query DefySyncInventory($id: ID!, $locationId: ID!) {
      inventoryItem(id: $id) { variant { id } inventoryLevel(locationId: $locationId) { ${LEVEL_FIELDS} } }
    }`, { id: delivery.resourceId, locationId });
    if (!data.inventoryItem?.inventoryLevel && delivery.topic !== "inventory_levels/disconnect") throw new ShopifySyncError("INVENTORY_UNAVAILABLE", "Shopify inventory is not readable yet. This event will retry.");
    if (delivery.topic === "inventory_levels/disconnect" && data.inventoryItem?.inventoryLevel && Date.parse(data.inventoryItem.inventoryLevel.updatedAt) <= Date.parse(delivery.triggeredAt)) throw new ShopifySyncError("DISCONNECT_NOT_VISIBLE", "Shopify still returns the pre-disconnect inventory level. This event will retry.");
    batch.projections.push(inventoryProjection(delivery.resourceId, data.inventoryItem?.variant?.id ?? null, locationId, data.inventoryItem?.inventoryLevel ?? null, observedAt, delivery.triggeredAt));
  } else if (delivery.topic.startsWith("products/")) {
    const data = await graphql<{ product: (Product & { variants: { nodes: Variant[]; pageInfo: PageInfo } }) | null }>(`query DefySyncProduct($id: ID!, $locationId: ID!) {
      product(id: $id) { ${PRODUCT_FIELDS} variants(first: 100) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } } }
    }`, { id: delivery.resourceId, locationId });
    if (!data.product) {
      // A null for a non-delete event may be access/replication delay. Retry instead of inventing a deletion.
      if (delivery.topic !== "products/delete") throw new ShopifySyncError("PRODUCT_UNAVAILABLE", "Shopify product is not readable yet. This event will retry.");
      batch.projections.push(projection("products", delivery.resourceId, null, delivery.triggeredAt, observedAt, {}, true));
    } else {
      if (delivery.topic === "products/delete") throw new ShopifySyncError("DELETE_NOT_VISIBLE", "Shopify still returns this deleted product. Retry after the deletion becomes visible.");
      if (data.product.variants.pageInfo.hasNextPage) throw new ShopifySyncError("PRODUCT_TOO_LARGE", "A product exceeds 100 variants. Its webhook remains pending; use paginated reconciliation to import inventory.");
      batch.projections.push(projection("products", data.product.id, null, data.product.updatedAt, observedAt, { title: data.product.title, handle: data.product.handle, status: data.product.status }));
      for (const variant of data.product.variants.nodes) addVariant(batch, variant, locationId, observedAt);
      batch.replaceChildren.push({ kind: "variants", parentId: data.product.id, ids: data.product.variants.nodes.map(variant => variant.id), sourceUpdatedAt: timestamp(data.product.updatedAt), observedAt });
    }
  } else {
    const data = await graphql<{ order: Order | null }>(`query DefySyncOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id: delivery.resourceId });
    if (!data.order) {
      if (delivery.topic !== "orders/delete") throw new ShopifySyncError("ORDER_UNAVAILABLE", "Shopify order is not readable. Verify order permissions and the 60-day access window; this event remains pending.");
      batch.projections.push(projection("orders", delivery.resourceId, null, delivery.triggeredAt, observedAt, {}, true));
    } else {
      if (delivery.topic === "orders/delete") throw new ShopifySyncError("DELETE_NOT_VISIBLE", "Shopify still returns this deleted order. Retry after the deletion becomes visible.");
      if (data.order.lineItems.pageInfo.hasNextPage) throw new ShopifySyncError("ORDER_TOO_LARGE", "An order exceeds 100 lines. Its sync remains pending for owner review; no partial order was saved.");
      addOrder(batch, await hydrateOrderInventory(graphql, data.order, locationId), locationId, observedAt);
    }
  }
  return deduplicateBatch(batch);
}
export type AuditPageLoader = (kind: "products" | "variants" | "orders", after: string | null) => Promise<{ ids: string[]; hasNextPage: boolean; endCursor: string | null }>;
export async function fetchReconcilePage(graphql: ReadGraphQL, cursor: ReconcileCursor, locationId: string, loadAuditPage?: AuditPageLoader) {
  const observedAt = new Date().toISOString();
  const batch = empty();
  let processed: number;
  let pageInfo: PageInfo;
  if (cursor.phase === "inventory") {
    const data = await graphql<{ productVariants: { nodes: Variant[]; pageInfo: PageInfo } }>(`query DefyReconcileInventory($after: String, $locationId: ID!) {
      productVariants(first: 25, after: $after, sortKey: ID) { nodes { ${VARIANT_FIELDS} } pageInfo { hasNextPage endCursor } }
    }`, { after: cursor.after, locationId });
    for (const variant of data.productVariants.nodes) addVariant(batch, variant, locationId, observedAt);
    processed = data.productVariants.nodes.length;
    pageInfo = data.productVariants.pageInfo;
  } else if (cursor.phase === "orders") {
    const since = new Date(Date.now() - 59 * 86400_000).toISOString();
    const data = await graphql<{ orders: { nodes: Order[]; pageInfo: PageInfo } }>(`query DefyReconcileOrders($after: String, $query: String!) {
      orders(first: 1, after: $after, query: $query, sortKey: ID) { nodes { ${ORDER_FIELDS} } pageInfo { hasNextPage endCursor } }
    }`, { after: cursor.after, query: `created_at:>='${since}'` });
    for (const order of data.orders.nodes) await addReconciledOrder(graphql, batch, order, locationId, observedAt);
    processed = data.orders.nodes.length;
    pageInfo = data.orders.pageInfo;
  } else {
    if (!loadAuditPage) throw new ShopifySyncError("AUDIT_REQUIRED", "Reconciliation needs access to the saved Shopify identities.");
    const kind = cursor.phase === "productsAudit" ? "products" : cursor.phase === "variantsAudit" ? "variants" : "orders";
    const audit = await loadAuditPage(kind, cursor.after);
    processed = audit.ids.length;
    pageInfo = audit;
    if (audit.ids.length) {
      const fields = kind === "products" ? `... on Product { ${PRODUCT_FIELDS} }` : kind === "variants" ? `... on ProductVariant { ${VARIANT_FIELDS} }` : `... on Order { ${ORDER_FIELDS} }`;
      const data = await graphql<{ nodes: (Product | Variant | Order | null)[] }>(`query DefySyncAudit($ids: [ID!]!${kind === "variants" ? ", $locationId: ID!" : ""}) {
        nodes(ids: $ids) { ${fields} }
      }`, { ids: audit.ids, ...(kind === "variants" ? { locationId } : {}) });
      if (data.nodes.length !== audit.ids.length || data.nodes.some((node, index) => node && node.id !== audit.ids[index])) throw new ShopifySyncError("INVALID_AUDIT", "Shopify returned incomplete identity verification.");
      for (const [index, node] of data.nodes.entries()) {
        if (!node) batch.projections.push(projection(kind, audit.ids[index], null, observedAt, observedAt, {}, true));
        else if (kind === "products") {
          const product = node as Product;
          batch.projections.push(projection("products", product.id, null, product.updatedAt, observedAt, { title: product.title, handle: product.handle, status: product.status }));
        } else if (kind === "variants") addVariant(batch, node as Variant, locationId, observedAt);
        else await addReconciledOrder(graphql, batch, node as Order, locationId, observedAt);
      }
    }
  }
  if (pageInfo.hasNextPage && !pageInfo.endCursor) throw new ShopifySyncError("INVALID_PAGE", "Shopify did not return a continuation cursor.");
  const nextPhase = { inventory: "productsAudit", productsAudit: "variantsAudit", variantsAudit: "orders", orders: "ordersAudit", ordersAudit: null } as const;
  const nextCursor = pageInfo.hasNextPage ? encodeCursor({ phase: cursor.phase, after: pageInfo.endCursor })
    : nextPhase[cursor.phase] ? encodeCursor({ phase: nextPhase[cursor.phase]!, after: null }) : null;
  return { batch: deduplicateBatch(batch), processed, nextCursor, done: nextCursor === null };
}
