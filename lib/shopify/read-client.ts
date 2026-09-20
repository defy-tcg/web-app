// Server-only credentials; this transport deliberately accepts GraphQL queries only.
import { ShopifySyncError, syncOrdersEnabled } from "./sync-core.ts";

export interface SyncConfig { shop: string; clientId: string; clientSecret: string; locationId: string; webhookSecret: string; enabled: boolean; ordersEnabled: boolean }
export function syncConfig(): SyncConfig {
  if (typeof window !== "undefined") throw new Error("Shopify credentials are server-only.");
  return { shop: process.env.SHOPIFY_SHOP_DOMAIN?.trim() ?? "", clientId: process.env.SHOPIFY_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? "", locationId: process.env.SHOPIFY_LOCATION_ID?.trim() ?? "",
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET?.trim() ?? "", enabled: process.env.SHOPIFY_SYNC_ENABLED === "true", ordersEnabled: syncOrdersEnabled() };
}
export function configBlockers(config: SyncConfig): string[] {
  const blockers: string[] = [];
  if (!["n4a7aa-fi.myshopify.com", "defy-receiving-test.myshopify.com"].includes(config.shop)) blockers.push("Configure the approved Defy Shopify shop.");
  if (!config.clientId || !config.clientSecret) blockers.push("Configure the installed Shopify app credentials.");
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(config.locationId)) blockers.push("Configure a complete Shopify receiving location ID.");
  if (!config.webhookSecret) blockers.push("Configure SHOPIFY_WEBHOOK_SECRET with the subscribing app's signing secret.");
  return blockers;
}
export type ReadGraphQL = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
let tokenCache: { key: string; token: string; until: number } | null = null;
export async function createReadClient(config: SyncConfig): Promise<ReadGraphQL> {
  const blockers = configBlockers(config);
  if (blockers.length) throw new ShopifySyncError("CONNECTION_REQUIRED", blockers.join(" "));
  const key = JSON.stringify([config.shop, config.clientId, config.clientSecret]);
  if (!tokenCache || tokenCache.key !== key || tokenCache.until <= Date.now()) {
    const response = await fetch(`https://${config.shop}/admin/oauth/access_token`, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret }) });
    if (!response.ok) throw new ShopifySyncError("SHOPIFY_AUTH_FAILED", `Shopify app authentication failed (${response.status}). Verify the installed app credentials.`);
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new ShopifySyncError("SHOPIFY_AUTH_FAILED", "Shopify returned no app token.");
    tokenCache = { key, token: body.access_token, until: Date.now() + Math.max(1, (body.expires_in ?? 3600) - 60) * 1000 };
  }
  const token = tokenCache.token;
  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error("Synchronization only permits Shopify read queries.");
    const response = await fetch(`https://${config.shop}/admin/api/2026-07/graphql.json`, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }) });
    if (response.status === 401) tokenCache = null;
    if (!response.ok) throw new ShopifySyncError("SHOPIFY_UNAVAILABLE", `Shopify read failed (${response.status}). Retry synchronization.`);
    const result = await response.json() as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (result.errors?.length) {
      const denied = result.errors.some(error => error.extensions?.code === "ACCESS_DENIED" || /access denied|permission|protected customer/i.test(error.message));
      throw new ShopifySyncError(denied ? "SHOPIFY_ACCESS_REQUIRED" : "SHOPIFY_READ_FAILED", denied
        ? config.ordersEnabled
          ? "Shopify denied access. Grant read_products, read_inventory, read_locations, and read_orders to this app, and approve the required order access in Shopify. Older orders require read_all_orders."
          : "Shopify denied inventory access. Grant read_products, read_inventory, and read_locations to this app. Order sync is disabled."
        : "Shopify could not provide a complete snapshot. Retry synchronization.");
    }
    if (!result.data) throw new ShopifySyncError("SHOPIFY_READ_FAILED", "Shopify returned no snapshot. Retry synchronization.");
    return result.data;
  };
}
