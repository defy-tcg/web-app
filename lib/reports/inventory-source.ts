export type InventorySource = "store" | "bulk_warehouse";
export type InventorySourceFilter = "all" | InventorySource;

export const INVENTORY_SOURCE_LABELS: Record<InventorySourceFilter, string> = {
  all: "All inventory",
  store: "Store inventory",
  bulk_warehouse: "Bulk Warehouse",
};

export interface SourceSale {
  id: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  cogsCents: number;
  itemsCount: number;
  inventorySource?: InventorySource;
  /** Numeric COGS may contain only the known portion; never infer free stock. */
  costIncomplete?: boolean;
}

export interface SourceSaleItem {
  id: string;
  saleId: string;
  quantity: number;
  unitPriceCents: number | null;
  unitCostCents: number | null;
  lineSubtotalCents?: number;
  lineCostCents?: number;
  aggregate?: boolean;
  inventorySource?: InventorySource;
  discountCents?: number;
  taxCents?: number;
}

export type SourceSaleDetail = {
  sourceScope: InventorySource | "mixed" | "unclassified";
  sourceBreakdown: "complete" | "unitemized" | "incomplete";
};

export type SourceItemDetail = {
  inventorySource: InventorySource;
  discountCents: number;
  taxCents: number;
  subtotalCents: number;
  revenueCents: number;
  cogsCents: number;
};

export interface InventorySourceReport<S extends SourceSale, L extends SourceSaleItem> {
  sales: Array<S & SourceSaleDetail>;
  saleItems: Array<L & SourceItemDetail>;
  unitemizedSales: number;
  incompleteSales: number;
  excludedMixedSales: number;
}

function safeSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) return null;
    total += value;
  }
  return total;
}

/** Largest-remainder allocation in integer cents; stable IDs break penny ties. */
function allocateCents(total: number, weights: readonly number[], ids: readonly string[]): number[] | null {
  if (!Number.isSafeInteger(total)) return null;
  const sum = safeSum(weights);
  if (sum === null) return null;
  if (!sum) return total === 0 ? weights.map(() => 0) : null;
  const denominator = BigInt(Math.abs(sum));
  const pieces = weights.map((weight, index) => {
    const numerator = BigInt(Math.abs(total)) * BigInt(weight) * BigInt(sum < 0 ? -1 : 1);
    let cents = numerator / denominator;
    let remainder = numerator % denominator;
    if (remainder < BigInt(0)) { cents -= BigInt(1); remainder += denominator; }
    return { index, cents, remainder, id: ids[index] };
  });
  let remainder = BigInt(Math.abs(total)) - pieces.reduce((value, piece) => value + piece.cents, BigInt(0));
  for (const piece of [...pieces].sort((left, right) =>
    left.remainder === right.remainder ? left.id.localeCompare(right.id) : left.remainder > right.remainder ? -1 : 1)) {
    if (remainder <= BigInt(0)) break;
    piece.cents += BigInt(1);
    remainder -= BigInt(1);
  }
  if (remainder !== BigInt(0)) return null;
  const values = pieces.map(piece => Number(piece.cents) * (total < 0 ? -1 : 1) || 0);
  return values.every(Number.isSafeInteger) && safeSum(values) === total ? values : null;
}

function adjustments<L extends SourceSaleItem>(total: number, lines: readonly L[], field: "discountCents" | "taxCents", weights: readonly number[]) {
  const known = lines.map(line => line[field]);
  const knownTotal = safeSum(known.filter((value): value is number => value !== undefined));
  if (knownTotal === null || !Number.isSafeInteger(total - knownTotal)) return null;
  const missing = lines.map((line, index) => line[field] === undefined ? index : -1).filter(index => index >= 0);
  if (!missing.length) return knownTotal === total ? known as number[] : null;
  const allocated = allocateCents(total - knownTotal, missing.map(index => weights[index]), missing.map(index => lines[index].id));
  if (!allocated) return null;
  const result = known.map(value => value ?? 0);
  missing.forEach((index, position) => { result[index] = allocated[position]; });
  return result;
}

function completeLines<S extends SourceSale, L extends SourceSaleItem>(sale: S, lines: readonly L[]): Array<L & SourceItemDetail> | null {
  if (!lines.length || new Set(lines.map(line => line.id)).size !== lines.length) return null;
  if (![sale.subtotalCents, sale.discountCents, sale.taxCents, sale.totalCents, sale.cogsCents, sale.itemsCount].every(Number.isSafeInteger)) return null;
  if (lines.some(line => !Number.isSafeInteger(line.quantity))) return null;
  if (lines.some(line => line.lineSubtotalCents === undefined && !Number.isSafeInteger(line.unitPriceCents) ||
    line.lineCostCents === undefined && !Number.isSafeInteger(line.unitCostCents))) return null;
  // Aggregate native orders carry exact order totals without invented unit prices.
  const amounts = lines.map(line => line.lineSubtotalCents ?? (line.unitPriceCents === null ? NaN : line.quantity * line.unitPriceCents));
  const costs = lines.map(line => line.lineCostCents ?? (line.unitCostCents === null ? NaN : line.quantity * line.unitCostCents));
  if (safeSum(amounts) !== sale.subtotalCents || safeSum(costs) !== sale.cogsCents ||
    safeSum(lines.map(line => line.quantity)) !== sale.itemsCount ||
    safeSum([sale.subtotalCents, -sale.discountCents, sale.taxCents]) !== sale.totalCents) return null;
  const discounts = adjustments(sale.discountCents, lines, "discountCents", amounts);
  if (!discounts) return null;
  const revenue = amounts.map((amount, index) => amount - discounts[index]);
  if (safeSum(revenue) === null) return null;
  const taxes = adjustments(sale.taxCents, lines, "taxCents", revenue);
  if (!taxes) return null;
  return lines.map((line, index) => ({ ...line, inventorySource: line.inventorySource ?? "store",
    discountCents: discounts[index], taxCents: taxes[index], subtotalCents: amounts[index], revenueCents: revenue[index], cogsCents: costs[index] }));
}

/**
 * Sales remain immutable. Filtered orders are projections of their original lines.
 * Legacy totals without complete lines stay in All / Store with a visible notice;
 * incomplete mixed orders are never presented as a complete source breakdown.
 */
export function filterSalesByInventorySource<S extends SourceSale, L extends SourceSaleItem>(
  sales: readonly S[], saleItems: readonly L[], source: InventorySourceFilter,
): InventorySourceReport<S, L> {
  const report: InventorySourceReport<S, L> = { sales: [], saleItems: [], unitemizedSales: 0, incompleteSales: 0, excludedMixedSales: 0 };
  const bySale = new Map<string, L[]>();
  for (const line of saleItems) {
    const lines = bySale.get(line.saleId) ?? [];
    lines.push(line); bySale.set(line.saleId, lines);
  }
  for (const sale of sales) {
    const raw = bySale.get(sale.id) ?? [];
    const lines = completeLines(sale, raw);
    if (!lines) {
      // An explicit order source can identify an unitemized warehouse receipt.
      // Observing a few bulk lines in a truncated order cannot classify the rest.
      const hasBulkLine = raw.some(line => line.inventorySource === "bulk_warehouse");
      const hasStoreLine = raw.some(line => (line.inventorySource ?? "store") === "store");
      const declared = sale.inventorySource;
      const scope = declared && !(declared === "bulk_warehouse" ? hasStoreLine : hasBulkLine)
        ? declared : hasBulkLine ? "unclassified" : "store";
      if (source !== "all" && scope === "unclassified") { report.excludedMixedSales++; continue; }
      if (source !== "all" && source !== scope) continue;
      const sourceBreakdown = raw.length ? "incomplete" : "unitemized";
      report.sales.push({ ...sale, sourceScope: scope, sourceBreakdown });
      if (raw.length) report.incompleteSales++; else report.unitemizedSales++;
      continue;
    }
    const sources = new Set(lines.map(line => line.inventorySource));
    const sourceScope = sources.size > 1 ? "mixed" : lines[0].inventorySource;
    const selected = source === "all" ? lines : lines.filter(line => line.inventorySource === source);
    if (!selected.length) continue;
    if (source === "all" || selected.length === lines.length) {
      report.sales.push({ ...sale, sourceScope, sourceBreakdown: "complete" });
    } else {
      const sum = (value: (line: L & SourceItemDetail) => number) => safeSum(selected.map(value));
      const subtotalCents = sum(line => line.subtotalCents);
      const discountCents = sum(line => line.discountCents);
      const taxCents = sum(line => line.taxCents);
      const cogsCents = sum(line => line.cogsCents);
      const itemsCount = sum(line => line.quantity);
      const totalCents = subtotalCents === null || discountCents === null || taxCents === null ? null : safeSum([subtotalCents, -discountCents, taxCents]);
      if (subtotalCents === null || discountCents === null || taxCents === null || cogsCents === null || itemsCount === null || totalCents === null) {
        report.excludedMixedSales++; continue;
      }
      report.sales.push({ ...sale, subtotalCents, discountCents, taxCents, totalCents, cogsCents, itemsCount, sourceScope, sourceBreakdown: "complete" });
    }
    report.saleItems.push(...selected);
  }
  return report;
}
