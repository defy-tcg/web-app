import { loadSkuLabelProducts } from "./sku-label-inventory-storage.ts";
import { SkuLabelInventoryError } from "./sku-label-inventory.ts";
import { isGeneratedSku } from "./sku-labels.ts";
import { getSkuLabelShopifyStatuses, linkSkuLabelToShopify, type SkuLabelShopifyStatus } from "./sku-label-shopify.ts";

export function skuLinkRequestSkus(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(sku => !isGeneratedSku(sku))) {
    throw new SkuLabelInventoryError(400, "Provide 1–100 saved QR SKUs.");
  }
  return [...new Set(value as string[])];
}

export function skuLinkOriginAllowed(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin && request.headers.get("sec-fetch-site") !== "cross-site";
}

export function pendingSkuLink(sku: string): SkuLabelShopifyStatus {
  return { sku, status: "pending", message: "Saved in Defy. Shopify linking is queued; the original QR and starting quantity will be reused." };
}

/** Load authoritative identities and original receipts; clients never select Shopify IDs or stock deltas. */
export async function readSavedSkuLinks(skus: readonly string[]): Promise<SkuLabelShopifyStatus[]> {
  const products = await loadSkuLabelProducts({ skus });
  const statuses = await getSkuLabelShopifyStatuses(products);
  return skus.map(sku => statuses.find(status => status.sku === sku) ?? {
    sku, status: "blocked", message: "Save this QR card in Defy before linking it to Shopify POS.",
  });
}

/** Limit Shopify concurrency and finish each attempt before the server's work budget expires. */
export async function linkSavedSkuLabels(skus: readonly string[], budgetMs = 240_000): Promise<SkuLabelShopifyStatus[]> {
  const products = await loadSkuLabelProducts({ skus });
  const deadline = Date.now() + budgetMs;
  const statuses = new Map<string, SkuLabelShopifyStatus>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, products.length) }, async () => {
    while (next < products.length && Date.now() < deadline) {
      const product = products[next++];
      try { statuses.set(product.sku, await linkSkuLabelToShopify(product)); }
      catch { statuses.set(product.sku, pendingSkuLink(product.sku)); }
    }
  }));
  const known = new Set(products.map(product => product.sku));
  return skus.map(sku => statuses.get(sku) ?? (known.has(sku) ? pendingSkuLink(sku) : {
    sku, status: "blocked", message: "Save this QR card in Defy before linking it to Shopify POS.",
  }));
}
