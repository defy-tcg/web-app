import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createShopifyGraphQL, type SinglesGraphQL } from "../lib/singles/shopify.ts";
import { syncOrdersEnabled, syncTopics } from "../lib/shopify/sync-core.ts";

export const webhookTopics = (ordersEnabled = true) => syncTopics(ordersEnabled).map(topic => topic.replaceAll("/", "_").toUpperCase());
export const WEBHOOK_TOPICS = webhookTopics();
interface Subscription { id: string; topic: string; uri: string; format: string; includeFields: string[] | null; filter: string | null }
const FIELDS = "id topic uri format includeFields filter";
const fieldsFor = (topic: string) => topic.startsWith("INVENTORY_LEVELS_") ? ["inventory_item_id", "location_id"] : ["id"];

export function webhookCallback(origin: string | undefined): string {
  let parsed: URL;
  try { parsed = new URL(origin || ""); } catch { throw new Error("Set SHOPIFY_SYNC_ORIGIN to the exact deployed HTTPS DefyOS origin."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" || ![parsed.origin, `${parsed.origin}/`].includes(origin || "")) {
    throw new Error("SHOPIFY_SYNC_ORIGIN must be an exact HTTPS origin without a path, query, credentials, or fragment.");
  }
  return `${parsed.origin}/api/shopify/webhooks`;
}

async function subscriptions(graphql: SinglesGraphQL): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const data: { webhookSubscriptions: { nodes: Subscription[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await graphql(`query DefySyncSubscriptions($after: String) {
      webhookSubscriptions(first: 100, after: $after) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }
    }`, { after });
    const page = data.webhookSubscriptions;
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo) throw new Error("Shopify returned an incomplete subscription list; no subscriptions can be safely added.");
    for (const item of page.nodes) {
      if (!item.id || ids.has(item.id)) throw new Error("Shopify returned duplicate subscription pages; stop and retry the dry run.");
      ids.add(item.id); subscriptions.push(item);
    }
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Shopify did not return complete subscription pagination; stop and retry the dry run.");
    cursors.add(after);
  } while (after);
  return subscriptions;
}

function verifyExisting(items: Subscription[], callback: string, topics: string[]): { existing: string[]; missing: string[]; warnings: string[] } {
  const existing: string[] = [], missing: string[] = [], warnings: string[] = [];
  for (const topic of topics) {
    const matches = items.filter(item => item.topic === topic && item.uri === callback);
    if (matches.length > 1) throw new Error(`Multiple ${topic} subscriptions already target DefyOS. Review their IDs in Shopify; this script never deletes subscriptions.`);
    const item = matches[0];
    if (!item) { missing.push(topic); continue; }
    if (item.format !== "JSON" || item.filter?.trim() || (item.includeFields?.length && fieldsFor(topic).some(field => !item.includeFields!.includes(field)))) {
      throw new Error(`Existing ${topic} subscription ${item.id} has an incompatible format, filter, or payload. Review it explicitly; this script will not change or duplicate it.`);
    }
    existing.push(topic);
    if (!item.includeFields?.length || item.includeFields.length !== fieldsFor(topic).length) warnings.push(`${topic} already exists with a broader payload; it was left unchanged.`);
  }
  return { existing, missing, warnings };
}

/** Dry-run by default. The only mutation path creates a missing exact topic + URI pair. */
export async function setupShopifyWebhooks(graphql: SinglesGraphQL, options: { shop: string; origin: string; apply?: boolean; ordersEnabled?: boolean }) {
  const ordersEnabled = options.ordersEnabled !== false;
  const topics = webhookTopics(ordersEnabled);
  const callback = webhookCallback(options.origin);
  if (!["n4a7aa-fi.myshopify.com", "defy-receiving-test.myshopify.com"].includes(options.shop)) throw new Error("Use the existing approved Defy Shopify shop or its development shop.");
  const connection = await graphql<{ shop: { myshopifyDomain: string }; currentAppInstallation: { accessScopes: { handle: string }[] } }>(`query DefySyncWebhookSetup {
    shop { myshopifyDomain } currentAppInstallation { accessScopes { handle } }
  }`);
  if (connection.shop?.myshopifyDomain !== options.shop) throw new Error("The authenticated Shopify shop does not match SHOPIFY_SHOP_DOMAIN.");
  const scopes = new Set(connection.currentAppInstallation?.accessScopes.map(scope => scope.handle) || []);
  const required = ["read_products", "read_inventory", "read_locations", ...(ordersEnabled ? ["read_orders"] : [])];
  const missingScopes = required.filter(scope => !scopes.has(scope) && !scopes.has(scope.replace("read_", "write_")));
  if (missingScopes.length) throw new Error(`Shopify app needs ${missingScopes.join(", ")} before registering DefyOS sync webhooks. Grant/reinstall the app's approved scopes, then rerun the dry run.`);
  const plan = verifyExisting(await subscriptions(graphql), callback, topics);
  const created: string[] = [];
  if (options.apply === true) {
    for (const topic of plan.missing) {
      // Re-read before every creation, including after a previous interrupted invocation.
      if (verifyExisting(await subscriptions(graphql), callback, topics).existing.includes(topic)) continue;
      const input = { uri: callback, format: "JSON", includeFields: fieldsFor(topic) };
      const data = await graphql<{ webhookSubscriptionCreate: { webhookSubscription: Subscription | null; userErrors: { message: string }[] } }>(`mutation DefySyncCreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { webhookSubscription { ${FIELDS} } userErrors { message } }
      }`, { topic, webhookSubscription: input });
      const result = data.webhookSubscriptionCreate;
      if (!result || result.userErrors?.length) throw new Error(`Shopify did not accept ${topic}: ${result?.userErrors?.map(error => error.message).join("; ") || "no confirmed response"}. Stop and rerun the dry run before retrying.`);
      const item = result.webhookSubscription;
      if (!item || item.topic !== topic || item.uri !== callback || item.format !== "JSON" || item.filter || item.includeFields?.length !== input.includeFields.length || input.includeFields.some(field => !item.includeFields!.includes(field))) {
        throw new Error(`Shopify did not confirm the exact ${topic} subscription. Rerun the dry run to inspect its state before retrying.`);
      }
      created.push(topic);
    }
    const final = verifyExisting(await subscriptions(graphql), callback, topics);
    if (final.missing.length) throw new Error(`Setup is incomplete for ${final.missing.join(", ")}. Rerun the dry run before retrying.`);
  }
  return { mode: options.apply === true ? "applied" : "dry-run", ordersEnabled, shop: options.shop, callback, existing: plan.existing, missing: plan.missing, created, warnings: plan.warnings,
    note: "Only this app's API-managed subscriptions are visible. Check app-configured subscriptions separately before applying; unrelated subscriptions are never changed." };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--apply") || args.length > 1) throw new Error("Usage: node --env-file=.env.local --experimental-strip-types scripts/setup-shopify-webhooks.ts [--apply]");
  const origin = process.env.SHOPIFY_SYNC_ORIGIN || "";
  webhookCallback(origin);
  const signingSecret = process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET?.trim();
  if (!signingSecret || !clientSecret || signingSecret !== clientSecret) throw new Error("For these app-owned subscriptions, SHOPIFY_WEBHOOK_SECRET must match SHOPIFY_CLIENT_SECRET on the deployed DefyOS handler. Configure both securely before setup.");
  const { graphql, settings } = await createShopifyGraphQL();
  const result = await setupShopifyWebhooks(graphql, { shop: settings.shop, origin, apply: args[0] === "--apply", ordersEnabled: syncOrdersEnabled() });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Shopify webhook setup failed."); process.exitCode = 1; });
}
