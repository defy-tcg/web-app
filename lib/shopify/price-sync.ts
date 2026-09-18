import { getDb } from "../../db/index.ts";
import { products } from "../../db/schema.ts";
import { readRiftboundCatalog } from "../singles/catalog.ts";
import { createShopifyGraphQL, ShopifySinglesAdapter } from "../singles/shopify.ts";
import { SinglesError } from "../singles/intake.ts";
import { resolveScrydexPrice, ScrydexError, scrydexConfigured } from "../scrydex.ts";
import { PriceSyncError, PRICING_VARIANT_FIELDS, updateVariantPrice, type PricingVariant } from "./price-sync-core.ts";
import { runPricePage, validatePriceState, type PriceJournal, type PriceSyncState } from "./price-sync-runner.ts";

const JOURNAL_KEY = "pos_pricing_sync_v1";
const PAGE_SIZE = 4;
export function priceSyncEnabled() { return process.env.SHOPIFY_PRICE_SYNC_ENABLED !== "false"; }
export function priceSyncError(error: unknown) {
  return error instanceof PriceSyncError || error instanceof ScrydexError || error instanceof SinglesError
    ? error.message : "Shopify price refresh failed. Check the connection and resume the saved run.";
}
async function connection() {
  if (!priceSyncEnabled()) throw new PriceSyncError("DISABLED", "Shopify price sync is disabled in this environment.");
  if (!scrydexConfigured()) throw new PriceSyncError("CONNECTION_REQUIRED", "Configure both Scrydex credentials before refreshing Shopify prices.");
  const client = await createShopifyGraphQL();
  const adapter = new ShopifySinglesAdapter(client.graphql, client.settings, client.clock);
  const journal: PriceJournal = {
    read: () => adapter.read<PriceSyncState>(JOURNAL_KEY),
    cas: (snapshot, value) => adapter.cas(JOURNAL_KEY, snapshot, value),
  };
  return { ...client, journal };
}
export function publicPriceState(state: PriceSyncState | null) {
  if (!state) return null;
  const { lease, ...publicState } = state;
  return { ...publicState, running: Boolean(lease && lease.until > Date.now()), done: Boolean(state.finishedAt) };
}
export async function getPriceSyncStatus() {
  const client = await connection();
  const snapshot = await client.journal.read();
  validatePriceState(snapshot.value);
  return { enabled: true, shop: client.settings.shop, state: publicPriceState(snapshot.value) };
}
export async function refreshShopifyPrices(options: { runId?: string; automatic?: boolean } = {}) {
  const client = await connection();
  return runPricePage({ ...options, journal: client.journal, now: Date.now, page: async (after) => {
    const preflight = await client.graphql<{ shop: { currencyCode: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(
      `query PosPricingConnection { shop { currencyCode } currentAppInstallation { accessScopes { handle } } }`);
    if (preflight.shop.currencyCode !== "USD") throw new PriceSyncError("CURRENCY_REQUIRED", "Scrydex pricing requires the Shopify shop to use USD.");
    if (!preflight.currentAppInstallation.accessScopes.some(scope => scope.handle === "write_products")) throw new PriceSyncError("SCOPE_REQUIRED", "The installed Shopify app needs write_products to sync POS prices.");
    const [legacy, catalog, data] = await Promise.all([
      getDb().select().from(products), readRiftboundCatalog(),
      client.graphql<{ productVariants: { nodes: PricingVariant[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
        `query PosPricingVariants($after: String, $first: Int!) {
          productVariants(first: $first, after: $after, sortKey: ID, query: "product_status:active AND published_status:pos-published") {
            nodes { ${PRICING_VARIANT_FIELDS} } pageInfo { hasNextPage endCursor }
          }
        }`, { after, first: PAGE_SIZE }),
    ]);
    const page = data.productVariants;
    if (!page?.nodes || !page.pageInfo || page.nodes.length > PAGE_SIZE || new Set(page.nodes.map(row => row.id)).size !== page.nodes.length
      || (page.pageInfo.hasNextPage && (!page.nodes.length || !page.pageInfo.endCursor || page.pageInfo.endCursor === after))) {
      throw new PriceSyncError("PAGINATION_INVALID", "Shopify returned an incomplete product page. Resume this run.");
    }
    // Wait for every in-flight mutation before releasing the journal lease.
    const settled = await Promise.allSettled(page.nodes.map(variant => updateVariantPrice({
      variant, legacy, catalog, graphql: client.graphql, resolve: resolveScrydexPrice, now: new Date().toISOString(),
    })));
    const results = [];
    const issues: PriceSyncState["issues"] = [];
    let fatal: unknown;
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === "fulfilled") results.push(result.value);
      else {
        const error = result.reason;
        // Provider outages/unknown mutation outcomes do not advance past affected products.
        if (!(error instanceof PriceSyncError || error instanceof ScrydexError)
          || (error instanceof ScrydexError && ["not_configured", "upstream_error"].includes(error.code))
          || (error instanceof PriceSyncError && error.code === "UPDATE_UNCONFIRMED")) fatal ??= error;
        else issues.push({ sku: page.nodes[index].sku || page.nodes[index].barcode || "No code", title: page.nodes[index].product.title, message: priceSyncError(error) });
      }
    }
    if (fatal) throw fatal;
    return { checked: page.nodes.length, results, issues, nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null };
  } });
}
