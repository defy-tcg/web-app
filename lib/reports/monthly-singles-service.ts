import { createShopifyGraphQL, type SinglesGraphQL } from "../singles/shopify.ts";
import { buildMonthlySinglesReport, monthlySinglesMonth, monthlySinglesMoneyCents, MonthlySinglesError,
  type MonthlySinglesLine, type MonthlySinglesOrder, type MonthlySinglesReport } from "./monthly-singles.ts";

interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface OrderPageNode extends Omit<MonthlySinglesOrder, "lines"> { lineItems: Connection<MonthlySinglesLine> }
const LINE_FIELDS = `id title variantTitle sku currentQuantity isGiftCard
  priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
  variant { id } product { id productType tags game: metafield(namespace: "card", key: "game") { value } }`;
const METADATA_QUERY = `query DefyMonthlySinglesAccess {
  shop { currencyCode ianaTimezone } currentAppInstallation { accessScopes { handle } }
}`;
const ORDERS_QUERY = `query DefyMonthlySinglesOrders($after: String, $query: String!) {
  orders(first: 10, after: $after, query: $query, sortKey: CREATED_AT) {
    nodes { id createdAt updatedAt sourceName test cancelledAt displayFinancialStatus
      lineItems(first: 10) { nodes { ${LINE_FIELDS} } pageInfo { hasNextPage endCursor } }
    } pageInfo { hasNextPage endCursor }
  }
}`;
const LINES_QUERY = `query DefyMonthlySinglesLines($id: ID!, $after: String!) {
  order(id: $id) { id updatedAt
    lineItems(first: 100, after: $after) { nodes { ${LINE_FIELDS} } pageInfo { hasNextPage endCursor } }
  }
}`;

export interface MonthlySinglesReadOptions {
  now?: Date;
  clock?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  maxPages?: number;
  maxDurationMs?: number;
}
function invalid(message: string): never {
  throw new MonthlySinglesError("INCOMPLETE_DATA", `${message} No partial ranking was returned. Retry the report.`);
}
function checkedPage<T>(page: Connection<T> | undefined, seen: Set<string>): Connection<T> {
  if (!page || !Array.isArray(page.nodes) || !page.pageInfo || typeof page.pageInfo.hasNextPage !== "boolean" ||
    !(page.pageInfo.endCursor === null || typeof page.pageInfo.endCursor === "string")) invalid("Shopify returned an incomplete page.");
  if (page.pageInfo.hasNextPage) {
    const cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor) || !page.nodes.length) invalid("Shopify returned an invalid pagination cursor.");
    seen.add(cursor);
  }
  return page;
}
function publicError(error: unknown): MonthlySinglesError {
  if (error instanceof MonthlySinglesError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ACCESS_DENIED") return new MonthlySinglesError("ORDER_ACCESS_REQUIRED", "Shopify denied order access. Approve this app's read_orders access in Shopify before generating the report.", 409);
  if (["CONNECTION_REQUIRED", "SHOP_INVALID", "LOCATION_INVALID", "SHOPIFY_AUTH_FAILED"].includes(code)) return new MonthlySinglesError("SHOPIFY_UNAVAILABLE", "The Shopify connection is unavailable. Verify the existing store app connection before retrying.", 503);
  return new MonthlySinglesError("SHOPIFY_UNAVAILABLE", "Shopify could not provide a complete monthly report. Retry shortly; no partial ranking was returned.", 503);
}

/** Fresh reads only: no order imports, inventory writes, cache, or schema changes. */
export async function fetchMonthlySinglesReport(graphql: SinglesGraphQL, month?: unknown, options: MonthlySinglesReadOptions = {}): Promise<MonthlySinglesReport> {
  try {
    const now = options.now ?? new Date();
    const period = monthlySinglesMonth(month, now);
    const clock = options.clock ?? Date.now;
    const wait = options.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const started = clock();
    const maxPages = options.maxPages ?? 150;
    const maxDuration = options.maxDurationMs ?? 40_000;
    let pages = 0;
    const limit = (): never => { throw new MonthlySinglesError("REPORT_LIMIT", "This month could not be read completely within the report limit. No partial ranking was returned. Retry or use a smaller-volume month."); };
    const read = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (!/^\s*query\b/.test(query) || /\bmutation\b/.test(query)) throw new Error("Monthly reports only permit Shopify read queries.");
      for (let retry = 0; ; retry++) {
        if (pages >= maxPages || clock() - started >= maxDuration) limit();
        pages++;
        try {
          const result = await graphql<T>(query, variables);
          if (clock() - started >= maxDuration) limit();
          return result;
        } catch (error) {
          // Retry only Shopify's explicit read throttle, with the exact cursor
          // and query. Every attempt and delay remains inside the report budget.
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          if (code !== "THROTTLED" || retry >= 3) throw error;
          const delay = 1_000 * 2 ** retry;
          if (pages >= maxPages || clock() - started + delay >= maxDuration) limit();
          await wait(delay);
        }
      }
    };
    const metadata = await read<{ shop: { currencyCode: string; ianaTimezone: string }; currentAppInstallation: { accessScopes: { handle: string }[] } | null }>(METADATA_QUERY);
    const scopes = metadata.currentAppInstallation?.accessScopes;
    if (!Array.isArray(scopes) || scopes.some(scope => !scope || typeof scope.handle !== "string")) invalid("Shopify did not return this app's order permissions.");
    if (!scopes.some(scope => scope.handle === "read_orders")) throw new MonthlySinglesError("ORDER_ACCESS_REQUIRED", "Monthly singles reports need this Shopify app's read_orders permission. Approve order access in Shopify before generating the report.", 409);
    if (Date.parse(period.startAt) < now.getTime() - 60 * 86_400_000 && !scopes.some(scope => scope.handle === "read_all_orders")) {
      throw new MonthlySinglesError("HISTORICAL_ACCESS_REQUIRED", "This month starts outside Shopify's 60-day order window. Shopify must approve read_all_orders for this app before the full month can be reported.", 409);
    }
    monthlySinglesMoneyCents("0", metadata.shop?.currencyCode);
    if (typeof metadata.shop?.ianaTimezone !== "string" || !metadata.shop.ianaTimezone) invalid("Shopify did not return its configured timezone.");
    const orders: MonthlySinglesOrder[] = [];
    const orderIds = new Set<string>();
    const orderCursors = new Set<string>();
    let after: string | null = null;
    const query = `created_at:>='${period.startAt}' created_at:<'${period.endAt}'`;
    for (;;) {
      const data: { orders: Connection<OrderPageNode> } = await read(ORDERS_QUERY, { after, query });
      const page = checkedPage(data.orders, orderCursors);
      for (const order of page.nodes) {
        if (!order || typeof order.id !== "string" || orderIds.has(order.id) || !Number.isFinite(Date.parse(order.updatedAt))) invalid("Shopify returned an invalid or repeated order.");
        orderIds.add(order.id);
        const lineCursors = new Set<string>();
        let linePage = checkedPage(order.lineItems, lineCursors);
        const lines = [...linePage.nodes];
        while (linePage.pageInfo.hasNextPage) {
          const extra: { order: { id: string; updatedAt: string; lineItems: Connection<MonthlySinglesLine> } | null } = await read(LINES_QUERY, { id: order.id, after: linePage.pageInfo.endCursor });
          if (!extra.order || extra.order.id !== order.id || extra.order.updatedAt !== order.updatedAt) invalid("An order changed while its lines were being read.");
          linePage = checkedPage(extra.order.lineItems, lineCursors);
          lines.push(...linePage.nodes);
        }
        orders.push({ id: order.id, createdAt: order.createdAt, updatedAt: order.updatedAt, sourceName: order.sourceName,
          test: order.test, cancelledAt: order.cancelledAt, displayFinancialStatus: order.displayFinancialStatus, lines });
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return buildMonthlySinglesReport({ period, orders, shopTimeZone: metadata.shop.ianaTimezone, currencyCode: metadata.shop.currencyCode, generatedAt: now.toISOString() });
  } catch (error) { throw publicError(error); }
}

export async function loadMonthlySinglesReport(month?: unknown): Promise<MonthlySinglesReport> {
  // Validate before acquiring an app token, even when the connection is absent.
  monthlySinglesMonth(month);
  try {
    const client = await createShopifyGraphQL();
    return await fetchMonthlySinglesReport(client.graphql, month);
  } catch (error) { throw publicError(error); }
}
