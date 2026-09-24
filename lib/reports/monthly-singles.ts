import { gameFromAlias } from "../tcg-games.ts";

export const MONTHLY_SINGLES_TIME_ZONE = "America/Los_Angeles";

export class MonthlySinglesError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "MonthlySinglesError";
    this.code = code;
    this.status = status;
  }
}

export interface MonthlySinglesMonth {
  month: string;
  startAt: string;
  endAt: string;
  monthToDate: boolean;
}

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MONTHLY_SINGLES_TIME_ZONE, year: "numeric", month: "2-digit",
});
function monthKey(date: Date): string {
  const parts = monthFormatter.formatToParts(date);
  return `${parts.find(part => part.type === "year")!.value}-${parts.find(part => part.type === "month")!.value}`;
}
function localMidnight(year: number, monthIndex: number): string {
  // Start near midnight and resolve the wall time itself. Using noon's offset
  // would be wrong when the DST transition falls on the first of the month.
  const target = Date.UTC(year, monthIndex, 1);
  let candidate = target + 8 * 3_600_000;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: MONTHLY_SINGLES_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(value => value.type === type)!.value);
    const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    if (wall === target) return new Date(candidate).toISOString();
    candidate += target - wall;
  }
  throw new MonthlySinglesError("INVALID_MONTH", "The selected month's timezone boundaries could not be resolved.", 400);
}
export function monthlySinglesMonth(input?: unknown, now = new Date()): MonthlySinglesMonth {
  if (!Number.isFinite(now.getTime())) throw new MonthlySinglesError("INVALID_MONTH", "The report date is unavailable.", 400);
  const current = monthKey(now);
  const month = input == null ? current : input;
  if (typeof month !== "string" || !/^[1-9]\d{3}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new MonthlySinglesError("INVALID_MONTH", "Choose a calendar month in YYYY-MM format.", 400);
  }
  if (month > current) throw new MonthlySinglesError("FUTURE_MONTH", "Choose the current month or an earlier month.", 400);
  const [year, number] = month.split("-").map(Number);
  return { month, startAt: localMidnight(year, number - 1), endAt: localMidnight(year, number), monthToDate: month === current };
}

export interface MonthlySinglesProduct {
  id: string;
  productType: string;
  tags: string[];
  game: { value: string } | null;
}
export interface MonthlySinglesLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  currentQuantity: number;
  isGiftCard: boolean;
  priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: string; currencyCode: string } };
  variant: { id: string } | null;
  product: MonthlySinglesProduct | null;
}
export interface MonthlySinglesOrder {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceName: string | null;
  test: boolean;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  lines: MonthlySinglesLine[];
}
export interface MonthlySinglesRow {
  rank: number;
  variantId: string;
  productId: string;
  name: string;
  variantTitle: string;
  sku: string;
  game: string;
  netUnits: number;
  itemSalesCents: number;
  orderCount: number;
  channels: { pos: number; web: number; other: number };
}
export interface MonthlySinglesReport extends MonthlySinglesMonth {
  source: "Shopify";
  timeZone: typeof MONTHLY_SINGLES_TIME_ZONE;
  shopTimeZone: string;
  currencyCode: "USD";
  generatedAt: string;
  complete: true;
  rows: MonthlySinglesRow[];
  totals: { netUnits: number; itemSalesCents: number; distinctVariants: number; eligibleOrders: number; scannedOrders: number };
  excluded: { testOrders: number; cancelledOrders: number; unpaidOrders: number; nonSingleLines: number; unclassifiedLines: number; deletedLines: number; zeroQuantityLines: number };
  notes: string[];
}

function incomplete(message: string): never {
  throw new MonthlySinglesError("INCOMPLETE_DATA", `${message} No partial ranking was returned. Retry the report.`);
}
function safeSum(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) incomplete("The report totals are too large to calculate safely.");
  return sum;
}
export function monthlySinglesMoneyCents(amount: unknown, currencyCode: unknown): number {
  if (currencyCode !== "USD") throw new MonthlySinglesError("UNSUPPORTED_CURRENCY", "Monthly singles reporting requires Shopify's USD shop currency; currencies are never combined.", 409);
  if (typeof amount !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(amount)) incomplete("Shopify returned an invalid item sales amount.");
  const [whole, decimal = ""] = amount.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) incomplete("Shopify returned an item sales amount that is too large.");
  return cents;
}

/** Classification only uses explicit catalog metadata, never a card/title guess. */
export function classifyMonthlySingle(product: MonthlySinglesProduct): { kind: "single" | "nonSingle" | "unclassified"; game: string } {
  if (!product || typeof product.productType !== "string" || !Array.isArray(product.tags) || product.tags.some(tag => typeof tag !== "string") ||
    (product.game !== null && (!product.game || typeof product.game.value !== "string"))) incomplete("Shopify returned incomplete product classification.");
  const type = product.productType.trim();
  const singleType = /^(?:(.*?)\s+)?singles?$/i.exec(type);
  const singleTag = product.tags.some(tag => /^singles?$/i.test(tag.trim()));
  const nonSingle = /\b(?:sealed|booster|accessor(?:y|ies)|deck|box|bundle|pack|sleeves?|playmat|gift\s*card)\b/i.test(type);
  const game = product.game?.value.trim() || singleType?.[1]?.trim() ||
    product.tags.map(tag => gameFromAlias(tag)?.name).find(Boolean) || "Other";
  return { kind: singleType || singleTag ? (nonSingle ? "unclassified" : "single") : nonSingle ? "nonSingle" : "unclassified",
    game: gameFromAlias(game)?.name ?? game };
}

export function buildMonthlySinglesReport(input: {
  period: MonthlySinglesMonth; orders: MonthlySinglesOrder[]; shopTimeZone: string; currencyCode: string; generatedAt: string;
}): MonthlySinglesReport {
  monthlySinglesMoneyCents("0", input.currencyCode);
  const excluded: MonthlySinglesReport["excluded"] = { testOrders: 0, cancelledOrders: 0, unpaidOrders: 0, nonSingleLines: 0, unclassifiedLines: 0, deletedLines: 0, zeroQuantityLines: 0 };
  const totals: MonthlySinglesReport["totals"] = { netUnits: 0, itemSalesCents: 0, distinctVariants: 0, eligibleOrders: 0, scannedOrders: input.orders.length };
  const ranked = new Map<string, { row: MonthlySinglesRow; orderIds: Set<string> }>();
  const orderIds = new Set<string>();
  const lineIds = new Set<string>();
  const start = Date.parse(input.period.startAt);
  const end = Date.parse(input.period.endAt);
  for (const order of input.orders) {
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(order.id) || orderIds.has(order.id) || typeof order.test !== "boolean" ||
      !(order.sourceName === null || typeof order.sourceName === "string") || !Array.isArray(order.lines) ||
      !(order.cancelledAt === null || (typeof order.cancelledAt === "string" && Number.isFinite(Date.parse(order.cancelledAt))))) incomplete("Shopify returned an invalid or repeated order.");
    orderIds.add(order.id);
    const created = Date.parse(order.createdAt);
    if (!Number.isFinite(created) || created < start || created >= end) incomplete("Shopify returned an order outside the selected month.");
    if (order.test) { excluded.testOrders++; continue; }
    if (order.cancelledAt) { excluded.cancelledOrders++; continue; }
    if (order.displayFinancialStatus !== "PAID" && order.displayFinancialStatus !== "PARTIALLY_REFUNDED") { excluded.unpaidOrders++; continue; }
    totals.eligibleOrders++;
    for (const line of order.lines) {
      if (!line || !/^gid:\/\/shopify\/LineItem\/\d+$/.test(line.id) || lineIds.has(line.id) ||
        !Number.isSafeInteger(line.currentQuantity) || line.currentQuantity < 0 || typeof line.isGiftCard !== "boolean") incomplete("Shopify returned an invalid or repeated order line.");
      lineIds.add(line.id);
      if (!line.currentQuantity) { excluded.zeroQuantityLines++; continue; }
      if (line.isGiftCard) { excluded.nonSingleLines++; continue; }
      if (line.variant === null || line.product === null) { excluded.deletedLines++; continue; }
      if (!line.variant || !line.product || !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(line.variant.id) || !/^gid:\/\/shopify\/Product\/\d+$/.test(line.product.id)) incomplete("Shopify returned an invalid card identity.");
      const classification = classifyMonthlySingle(line.product);
      if (classification.kind === "nonSingle") { excluded.nonSingleLines++; continue; }
      if (classification.kind === "unclassified") { excluded.unclassifiedLines++; continue; }
      if (typeof line.title !== "string" || !line.title.trim() || !(line.variantTitle === null || typeof line.variantTitle === "string") || !(line.sku === null || typeof line.sku === "string")) incomplete("Shopify returned incomplete card details.");
      const money = line.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney;
      if (!money) incomplete("Shopify returned no item sales amount.");
      // This is the exact remaining LINE total, not a unit price. Shopify has
      // already removed refunded/removed quantities and applied all discounts.
      const cents = monthlySinglesMoneyCents(money.amount, money.currencyCode);
      const current = ranked.get(line.variant.id) ?? { row: { rank: 0, variantId: line.variant.id, productId: line.product.id, name: line.title,
        variantTitle: line.variantTitle || "", sku: line.sku || "", game: classification.game,
        netUnits: 0, itemSalesCents: 0, orderCount: 0, channels: { pos: 0, web: 0, other: 0 } }, orderIds: new Set<string>() };
      if (current.row.productId !== line.product.id) incomplete("A Shopify variant changed products during this report.");
      current.row.netUnits = safeSum(current.row.netUnits, line.currentQuantity);
      current.row.itemSalesCents = safeSum(current.row.itemSalesCents, cents);
      const channel = order.sourceName?.toLowerCase() === "pos" ? "pos" : order.sourceName?.toLowerCase() === "web" ? "web" : "other";
      current.row.channels[channel] = safeSum(current.row.channels[channel], line.currentQuantity);
      current.orderIds.add(order.id);
      current.row.orderCount = current.orderIds.size;
      ranked.set(line.variant.id, current);
      totals.netUnits = safeSum(totals.netUnits, line.currentQuantity);
      totals.itemSalesCents = safeSum(totals.itemSalesCents, cents);
    }
  }
  totals.distinctVariants = ranked.size;
  const rows = [...ranked.values()].map(item => item.row).sort((left, right) => right.netUnits - left.netUnits || right.itemSalesCents - left.itemSalesCents ||
    (left.variantId < right.variantId ? -1 : left.variantId > right.variantId ? 1 : 0)).slice(0, 50).map((row, index) => ({ ...row, rank: index + 1 }));
  const notes = [
    "Orders are selected by their creation date in America/Los_Angeles. The current month is month to date.",
    "Ranked by current units after refunded and removed units, then item sales before tax. Conditions and finishes remain separate Shopify variants.",
    "Item sales use Shopify's remaining line totals after all discounts and before tax. Shipping, tips, and money-only order refunds that are not allocated to items are excluded; this is not a payout or profit report.",
    "Only paid and partially refunded orders are included. Test, cancelled, fully refunded, and unpaid orders are excluded. Later refunds or order edits can change earlier months.",
    "Singles require an explicit single product type or Singles tag. Deleted variants and products, and lines without clear classification, are counted separately and excluded.",
    "POS means Shopify source pos; Web means source web. Other includes headless, draft, app, unknown, and other Shopify order sources. The older Defy ledger and TCGplayer imports are not combined with Shopify orders.",
  ];
  if (input.shopTimeZone !== MONTHLY_SINGLES_TIME_ZONE) notes.push(`Shopify's configured timezone is ${input.shopTimeZone}; this report uses America/Los_Angeles.`);
  return { ...input.period, source: "Shopify", timeZone: MONTHLY_SINGLES_TIME_ZONE, shopTimeZone: input.shopTimeZone,
    currencyCode: "USD", generatedAt: input.generatedAt, complete: true, rows, totals, excluded, notes };
}
