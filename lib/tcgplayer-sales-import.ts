import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { products, sales } from "@/db/schema";
import {
  parseTcgplayerSalesCsv,
  type TcgplayerCsvItem,
  type TcgplayerCsvOrder,
} from "@/lib/tcgplayer-sales-csv";

type InventoryProduct = typeof products.$inferSelect;

export type PreparedTcgplayerItem = TcgplayerCsvItem & {
  productId: number | null;
  defySku: string;
  matchedName: string;
  matchMethod: string;
  matchIssue: string;
  stockBefore: number | null;
  stockDeduction: number;
  shortageQuantity: number;
  unitCostCents: number;
};

export type PreparedTcgplayerOrder = Omit<TcgplayerCsvOrder, "items"> & {
  saleNumber: string;
  duplicate: boolean;
  isPending: boolean;
  skipped: boolean;
  skipReason: string;
  items: PreparedTcgplayerItem[];
};

export type TcgplayerImportPreview = {
  fileName: string;
  headers: string[];
  warnings: string[];
  hasLineItems: boolean;
  aggregateSummary: {
    reportedOrders: number;
    reportedRefunds: number;
    startDate: string;
    endDate: string;
    grossRevenueCents: number;
    refundCents: number;
    netRevenueCents: number;
    netTaxCents: number;
  } | null;
  orders: PreparedTcgplayerOrder[];
  summary: {
    rows: number;
    totalOrders: number;
    readyOrders: number;
    duplicateOrders: number;
    canceledOrders: number;
    pendingOrders: number;
    lineItems: number;
    matchedItems: number;
    unmatchedItems: number;
    stockUnitsToDeduct: number;
    shortageUnits: number;
    revenueCents: number;
    feesCents: number;
    netCents: number | null;
    reportedOrders: number;
  };
};

export type TcgplayerImportResult = {
  importedOrders: number;
  reportedOrders: number;
  aggregateSummary: boolean;
  duplicateOrders: number;
  canceledOrders: number;
  pendingOrders: number;
  importedItems: number;
  unmatchedItems: number;
  stockUnitsDeducted: number;
  shortageUnits: number;
  revenueCents: number;
  feesCents: number;
  saleNumbers: string[];
};

function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeCondition(value: string) {
  const condition = normalize(value);
  const aliases: Record<string, string> = {
    nm: "near mint",
    "near mint foil": "near mint",
    lp: "lightly played",
    "light play": "lightly played",
    mp: "moderately played",
    "moderate play": "moderately played",
    hp: "heavily played",
    dmg: "damaged",
  };
  return aliases[condition] || condition;
}

function normalizeFinish(value: string) {
  const finish = normalize(value);
  if (!finish || finish === "normal" || finish === "non foil" || finish === "regular") {
    return "normal";
  }
  if (finish.includes("reverse")) return "reverse holofoil";
  if (finish.includes("holo")) return "holofoil";
  if (finish.includes("foil")) return "foil";
  return finish;
}

function uniqueProduct(candidates: InventoryProduct[]) {
  const unique = [...new Map(candidates.map((product) => [product.id, product])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function refineCandidates(candidates: InventoryProduct[], item: TcgplayerCsvItem) {
  let refined = candidates;
  if (item.setName) {
    const setName = normalize(item.setName);
    const exactSet = refined.filter((product) => normalize(product.setName) === setName);
    if (exactSet.length) refined = exactSet;
  }
  if (item.condition) {
    const condition = normalizeCondition(item.condition);
    const exactCondition = refined.filter(
      (product) => normalizeCondition(product.condition) === condition,
    );
    if (exactCondition.length) refined = exactCondition;
    else if (refined.some((product) => product.productType === "Single" && product.condition)) {
      return [];
    }
  }
  if (item.finish) {
    const finish = normalizeFinish(item.finish);
    const exactFinish = refined.filter(
      (product) => normalizeFinish(product.finish) === finish,
    );
    if (exactFinish.length) refined = exactFinish;
    else if (refined.some((product) => product.productType === "Single" && product.finish)) {
      return [];
    }
  }
  return refined;
}

function matchInventoryProduct(item: TcgplayerCsvItem, inventory: InventoryProduct[]) {
  if (item.sku) {
    const sku = item.sku.trim().toUpperCase();
    const match = uniqueProduct(inventory.filter((product) => product.sku.toUpperCase() === sku));
    if (match) return { product: match, method: "Exact SKU", issue: "" };
  }
  if (item.barcode) {
    const barcode = item.barcode.trim();
    const match = uniqueProduct(inventory.filter((product) => product.barcode === barcode));
    if (match) return { product: match, method: "Exact barcode", issue: "" };
  }
  if (item.tcgplayerProductId) {
    const candidates = refineCandidates(
      inventory.filter((product) => product.tcgplayerId === item.tcgplayerProductId),
      item,
    );
    const match = uniqueProduct(candidates);
    if (match) return { product: match, method: "TCGplayer product", issue: "" };
    if (candidates.length > 1) {
      return {
        product: null,
        method: "",
        issue: "Multiple Defy variants share this TCGplayer product ID",
      };
    }
  }
  if (item.productName) {
    const productName = normalize(item.productName);
    const candidates = refineCandidates(
      inventory.filter((product) => normalize(product.name) === productName),
      item,
    );
    const match = uniqueProduct(candidates);
    if (match) return { product: match, method: "Exact product details", issue: "" };
    if (candidates.length > 1) {
      return {
        product: null,
        method: "",
        issue: "Multiple Defy products have these details",
      };
    }
  }
  return { product: null, method: "", issue: "No exact Defy inventory match" };
}

function cleanFileName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._ -]+/g, "").slice(0, 160) || "TCGplayer orders.csv";
}

function isPendingStatus(status: string) {
  const value = status.toLowerCase();
  return value.includes("pending") || value.includes("payment processing");
}

type SummaryRange = {
  start: string;
  end: string;
};

function summaryRangeFromSaleNumber(value: string): SummaryRange | null {
  const match = value.match(/^TCG-SUMMARY-(\d{8})-(\d{8})$/i);
  return match ? { start: match[1], end: match[2] } : null;
}

function compactSaleDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10).replace(/-/g, "");
}

function rangesOverlap(left: SummaryRange, right: SummaryRange) {
  return left.start <= right.end && right.start <= left.end;
}

export async function prepareTcgplayerImport(
  csvText: string,
  fileName: string,
): Promise<TcgplayerImportPreview> {
  const parsed = parseTcgplayerSalesCsv(csvText);
  if (parsed.orders.length > 500) {
    throw new Error("That export has over 500 orders. Export a smaller date range and try again.");
  }

  const db = getDb();
  const [inventory, priorTcgSales] = await Promise.all([
    db.select().from(products),
    db
      .select({
        saleNumber: sales.saleNumber,
        soldAt: sales.soldAt,
        subtotalCents: sales.subtotalCents,
        discountCents: sales.discountCents,
        taxCents: sales.taxCents,
        totalCents: sales.totalCents,
        itemsCount: sales.itemsCount,
      })
      .from(sales)
      .where(eq(sales.channel, "TCGplayer")),
  ]);
  const existingSaleNumbers = new Set(
    priorTcgSales.map((sale) => sale.saleNumber.toUpperCase()),
  );
  const existingSummaryRanges = priorTcgSales.flatMap((sale) => {
    const range = summaryRangeFromSaleNumber(sale.saleNumber);
    return range ? [{ ...range, saleNumber: sale.saleNumber }] : [];
  });

  for (const order of parsed.orders) {
    const saleNumber = `TCG-${order.orderNumber}`.slice(0, 300);
    const currentRange = summaryRangeFromSaleNumber(saleNumber);
    if (currentRange) {
      const overlappingSummary = existingSummaryRanges.find(
        (range) =>
          range.saleNumber.toUpperCase() !== saleNumber.toUpperCase() &&
          rangesOverlap(currentRange, range),
      );
      if (overlappingSummary) {
        throw new Error(
          `This report overlaps the previously imported summary ${overlappingSummary.saleNumber}. Export a non-overlapping date range to prevent double-counting.`,
        );
      }
      const detailedSale = priorTcgSales.find(
        (sale) =>
          !summaryRangeFromSaleNumber(sale.saleNumber) &&
          compactSaleDate(sale.soldAt) >= currentRange.start &&
          compactSaleDate(sale.soldAt) <= currentRange.end,
      );
      if (detailedSale) {
        throw new Error(
          `This report overlaps an existing TCGplayer sale (${detailedSale.saleNumber}). Export a date range that has not already been imported.`,
        );
      }
      const exactSummary = priorTcgSales.find(
        (sale) => sale.saleNumber.toUpperCase() === saleNumber.toUpperCase(),
      );
      if (
        exactSummary &&
        (exactSummary.subtotalCents !== order.productSubtotalCents + order.shippingCents ||
          exactSummary.discountCents !== order.discountCents ||
          exactSummary.taxCents !== order.taxCents ||
          exactSummary.totalCents !== order.totalCents ||
          exactSummary.itemsCount !== order.reportedOrderCount)
      ) {
        throw new Error(
          "This date range was already imported, but TCGplayer totals have changed. Remove the existing period summary before importing the revised report.",
        );
      }
    } else {
      const orderDate = compactSaleDate(order.soldAt);
      const coveringSummary = existingSummaryRanges.find(
        (range) => orderDate >= range.start && orderDate <= range.end,
      );
      if (coveringSummary) {
        throw new Error(
          `This order file overlaps the imported summary ${coveringSummary.saleNumber}. Import only dates outside that summary range to prevent double-counting.`,
        );
      }
    }
  }
  const simulatedStock = new Map(inventory.map((product) => [product.id, product.quantity]));

  const preparedOrders = parsed.orders.map<PreparedTcgplayerOrder>((order) => {
    const saleNumber = `TCG-${order.orderNumber}`.slice(0, 300);
    const duplicate = existingSaleNumbers.has(saleNumber.toUpperCase());
    const pending = isPendingStatus(order.status);
    const skipped = duplicate || order.isCanceled || pending;
    const skipReason = duplicate
      ? "Already imported"
      : order.isCanceled
        ? `Skipped ${order.status.toLowerCase()} order`
        : pending
          ? `Skipped ${order.status.toLowerCase()} order`
        : "";
    const preparedItems = order.items.map<PreparedTcgplayerItem>((item) => {
      const match = matchInventoryProduct(item, inventory);
      if (!match.product) {
        return {
          ...item,
          productId: null,
          defySku: "",
          matchedName: "",
          matchMethod: "",
          matchIssue: match.issue,
          stockBefore: null,
          stockDeduction: 0,
          shortageQuantity: 0,
          unitCostCents: 0,
        };
      }
      const stockBefore = simulatedStock.get(match.product.id) ?? match.product.quantity;
      const stockDeduction = skipped ? 0 : Math.min(stockBefore, item.quantity);
      const shortageQuantity = skipped ? 0 : item.quantity - stockDeduction;
      if (!skipped) simulatedStock.set(match.product.id, stockBefore - stockDeduction);
      return {
        ...item,
        productId: match.product.id,
        defySku: match.product.sku,
        matchedName: match.product.name,
        matchMethod: match.method,
        matchIssue: "",
        stockBefore,
        stockDeduction,
        shortageQuantity,
        unitCostCents: match.product.costCents,
      };
    });
    return {
      ...order,
      saleNumber,
      duplicate,
      isPending: pending,
      skipped,
      skipReason,
      items: preparedItems,
    };
  });

  const ready = preparedOrders.filter((order) => !order.skipped);
  const readyItems = ready.flatMap((order) => order.items);
  const aggregateOrder = preparedOrders.find((order) => order.isAggregateSummary);
  const summary = {
    rows: parsed.rowCount,
    totalOrders: preparedOrders.length,
    readyOrders: ready.length,
    duplicateOrders: preparedOrders.filter((order) => order.duplicate).length,
    canceledOrders: preparedOrders.filter((order) => order.isCanceled).length,
    pendingOrders: preparedOrders.filter((order) => order.isPending).length,
    lineItems: readyItems.length,
    matchedItems: readyItems.filter((item) => item.productId).length,
    unmatchedItems: readyItems.filter((item) => !item.productId).length,
    stockUnitsToDeduct: readyItems.reduce((sum, item) => sum + item.stockDeduction, 0),
    shortageUnits: readyItems.reduce((sum, item) => sum + item.shortageQuantity, 0),
    revenueCents: ready.reduce(
      (sum, order) =>
        sum + order.productSubtotalCents + order.shippingCents - order.discountCents,
      0,
    ),
    feesCents: ready.reduce((sum, order) => sum + order.feesCents, 0),
    netCents: ready.every((order) => order.netCents !== null)
      ? ready.reduce((sum, order) => sum + (order.netCents || 0), 0)
      : null,
    reportedOrders: ready.reduce(
      (sum, order) => sum + (order.isAggregateSummary ? order.reportedOrderCount : 1),
      0,
    ),
  };
  const warnings = [...parsed.warnings];
  if (summary.unmatchedItems) {
    warnings.push(
      `${summary.unmatchedItems} line item${summary.unmatchedItems === 1 ? " has" : "s have"} no exact Defy match. The sale will import, but stock for those items will not change.`,
    );
  }
  if (summary.shortageUnits) {
    warnings.push(
      `${summary.shortageUnits} sold unit${summary.shortageUnits === 1 ? " exceeds" : "s exceed"} current Defy stock. Matching products will stop at zero.`,
    );
  }
  if (summary.canceledOrders) {
    warnings.push(
      `${summary.canceledOrders} canceled or fully refunded order${summary.canceledOrders === 1 ? " was" : "s were"} excluded for safety.`,
    );
  }
  if (summary.pendingOrders) {
    warnings.push(
      `${summary.pendingOrders} pending order${summary.pendingOrders === 1 ? " was" : "s were"} excluded until payment is ready.`,
    );
  }
  if (summary.duplicateOrders) {
    warnings.push(
      `${summary.duplicateOrders} order${summary.duplicateOrders === 1 ? " was" : "s were"} already imported and will be skipped.`,
    );
  }

  return {
    fileName: cleanFileName(fileName),
    headers: parsed.headers,
    warnings,
    hasLineItems: parsed.hasLineItems,
    aggregateSummary: aggregateOrder
      ? {
          reportedOrders: aggregateOrder.reportedOrderCount,
          reportedRefunds: aggregateOrder.reportedRefundCount,
          startDate: aggregateOrder.reportStartDate,
          endDate: aggregateOrder.reportEndDate,
          grossRevenueCents:
            aggregateOrder.productSubtotalCents + aggregateOrder.shippingCents,
          refundCents: aggregateOrder.discountCents,
          netRevenueCents:
            aggregateOrder.productSubtotalCents +
            aggregateOrder.shippingCents -
            aggregateOrder.discountCents,
          netTaxCents: aggregateOrder.taxCents,
        }
      : null,
    orders: preparedOrders,
    summary,
  };
}

function placeholders(rows: unknown[][], columns: number) {
  return rows
    .map((_, rowIndex) => {
      const start = rowIndex * columns;
      return `(${Array.from({ length: columns }, (__, columnIndex) => `$${start + columnIndex + 1}`).join(", ")})`;
    })
    .join(", ");
}

function values(rows: unknown[][]) {
  return rows.flat();
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export async function commitTcgplayerImport(
  csvText: string,
  fileName: string,
  acknowledgeWarnings: boolean,
): Promise<TcgplayerImportResult> {
  const preview = await prepareTcgplayerImport(csvText, fileName);
  if (
    !acknowledgeWarnings &&
    (preview.summary.unmatchedItems > 0 ||
      preview.summary.shortageUnits > 0 ||
      preview.aggregateSummary)
  ) {
    throw new Error("Review and confirm the import warnings before importing");
  }
  const readyOrders = preview.orders.filter((order) => !order.skipped);
  if (!readyOrders.length) {
    return {
      importedOrders: 0,
      reportedOrders: 0,
      aggregateSummary: Boolean(preview.aggregateSummary),
      duplicateOrders: preview.summary.duplicateOrders,
      canceledOrders: preview.summary.canceledOrders,
      pendingOrders: preview.summary.pendingOrders,
      importedItems: 0,
      unmatchedItems: 0,
      stockUnitsDeducted: 0,
      shortageUnits: 0,
      revenueCents: 0,
      feesCents: 0,
      saleNumbers: [],
    };
  }

  const db = getDb();
  const sqlClient = db.$client;
  const saleIds = new Map(readyOrders.map((order) => [order.saleNumber, crypto.randomUUID()]));
  const saleRows = readyOrders.map((order) => {
    const matchedCogs = order.items.reduce(
      (sum, item) => sum + item.unitCostCents * item.quantity,
      0,
    );
    const itemCount = order.isAggregateSummary
      ? order.reportedOrderCount
      : order.items.reduce((sum, item) => sum + item.quantity, 0);
    const unmatched = order.items.filter((item) => !item.productId).length;
    const note = [
      order.isAggregateSummary
        ? `TCGplayer Seller Tax summary · ${order.reportedOrderCount} orders · ${order.reportStartDate} to ${order.reportEndDate}`
        : `TCGplayer import · ${order.status}`,
      order.shippingCents ? `Shipping ${money(order.shippingCents)}` : "",
      order.discountCents ? `Refunds ${money(order.discountCents)}` : "",
      order.isAggregateSummary
        ? `Tax ${money(order.taxCents)} excluded from revenue`
        : "",
      order.feesCents ? `Fees ${money(order.feesCents)}` : "",
      order.netCents !== null ? `Net ${money(order.netCents)}` : "",
      unmatched ? `${unmatched} unmatched item${unmatched === 1 ? "" : "s"}` : "",
      order.isAggregateSummary ? "No item details, COGS, fees, or stock changes" : "",
    ]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 300);
    return [
      saleIds.get(order.saleNumber),
      order.saleNumber,
      "TCGplayer",
      "Marketplace",
      order.productSubtotalCents + order.shippingCents,
      order.discountCents,
      order.taxCents,
      order.totalCents,
      matchedCogs,
      itemCount,
      note,
      order.soldAt,
    ];
  });

  const itemRows: unknown[][] = [];
  const movementRows: unknown[][] = [];
  const feeRows: unknown[][] = [];
  const deductions = new Map<number, number>();
  for (const order of readyOrders) {
    const saleId = saleIds.get(order.saleNumber)!;
    for (const item of order.items) {
      itemRows.push([
        crypto.randomUUID(),
        saleId,
        item.productId,
        item.matchedName || item.productName,
        item.defySku || item.sku,
        item.quantity,
        item.unitPriceCents,
        item.unitCostCents,
      ]);
      if (item.productId && item.stockDeduction) {
        deductions.set(
          item.productId,
          (deductions.get(item.productId) || 0) + item.stockDeduction,
        );
        movementRows.push([
          item.productId,
          -item.stockDeduction,
          "tcgplayer sale",
          order.saleNumber,
        ]);
      }
    }
    if (order.feesCents) {
      feeRows.push([
        crypto.randomUUID(),
        "Marketplace fees",
        "TCGplayer",
        `TCGplayer fees · ${order.orderNumber}`.slice(0, 300),
        order.feesCents,
        "One-time",
        order.soldAt,
        `Auto-created from ${preview.fileName} · ${order.saleNumber}`.slice(0, 300),
      ]);
    }
  }

  const queries = [
    sqlClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "defy-tcgplayer-import",
    ]),
  ];
  for (const order of readyOrders) {
    const range = summaryRangeFromSaleNumber(order.saleNumber);
    if (range) {
      queries.push(
        sqlClient.query(
          `SELECT (CASE WHEN EXISTS (
            SELECT 1 FROM sales
            WHERE channel = 'TCGplayer'
              AND UPPER(sale_number) <> UPPER($1)
              AND (
                (
                  sale_number ~ '^TCG-SUMMARY-[0-9]{8}-[0-9]{8}$'
                  AND SUBSTRING(sale_number FROM 13 FOR 8) <= $3
                  AND SUBSTRING(sale_number FROM 22 FOR 8) >= $2
                )
                OR (
                  sale_number !~ '^TCG-SUMMARY-[0-9]{8}-[0-9]{8}$'
                  AND REPLACE(SUBSTRING(sold_at FROM 1 FOR 10), '-', '') BETWEEN $2 AND $3
                )
              )
          ) THEN 'TCG_IMPORT_OVERLAP' ELSE '1' END)::integer`,
          [order.saleNumber, range.start, range.end],
        ),
      );
    } else {
      const orderDate = compactSaleDate(order.soldAt);
      queries.push(
        sqlClient.query(
          `SELECT (CASE WHEN EXISTS (
            SELECT 1 FROM sales
            WHERE channel = 'TCGplayer'
              AND sale_number ~ '^TCG-SUMMARY-[0-9]{8}-[0-9]{8}$'
              AND SUBSTRING(sale_number FROM 13 FOR 8) <= $1
              AND SUBSTRING(sale_number FROM 22 FOR 8) >= $1
          ) THEN 'TCG_IMPORT_OVERLAP' ELSE '1' END)::integer`,
          [orderDate],
        ),
      );
    }
  }
  queries.push(
    sqlClient.query(
      `INSERT INTO sales (id, sale_number, channel, payment_method, subtotal_cents, discount_cents, tax_cents, total_cents, cogs_cents, items_count, note, sold_at) VALUES ${placeholders(saleRows, 12)}`,
      values(saleRows),
    ),
  );
  if (itemRows.length) {
    queries.push(
      sqlClient.query(
        `INSERT INTO sale_items (id, sale_id, product_id, product_name, sku, quantity, unit_price_cents, unit_cost_cents) VALUES ${placeholders(itemRows, 8)}`,
        values(itemRows),
      ),
    );
  }
  const deductionRows = [...deductions.entries()];
  if (deductionRows.length) {
    queries.push(
      sqlClient.query(
        `UPDATE products AS product SET quantity = GREATEST(0, product.quantity - deduction.quantity), updated_at = CURRENT_TIMESTAMP FROM (VALUES ${placeholders(deductionRows, 2)}) AS deduction(id, quantity) WHERE product.id = deduction.id`,
        values(deductionRows),
      ),
    );
  }
  if (movementRows.length) {
    queries.push(
      sqlClient.query(
        `INSERT INTO inventory_movements (product_id, delta, reason, note) VALUES ${placeholders(movementRows, 4)}`,
        values(movementRows),
      ),
    );
  }
  if (feeRows.length) {
    queries.push(
      sqlClient.query(
        `INSERT INTO expenses (id, category, vendor, description, amount_cents, recurrence, expense_date, note) VALUES ${placeholders(feeRows, 8)}`,
        values(feeRows),
      ),
    );
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      await sqlClient.transaction(queries, { isolationLevel: "ReadCommitted" });
      break;
    } catch (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? String(error.code)
          : "";
      if (attempt >= 2 || (code !== "40001" && code !== "40P01")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  return {
    importedOrders: readyOrders.length,
    reportedOrders: preview.summary.reportedOrders,
    aggregateSummary: Boolean(preview.aggregateSummary),
    duplicateOrders: preview.summary.duplicateOrders,
    canceledOrders: preview.summary.canceledOrders,
    pendingOrders: preview.summary.pendingOrders,
    importedItems: readyOrders.reduce((sum, order) => sum + order.items.length, 0),
    unmatchedItems: preview.summary.unmatchedItems,
    stockUnitsDeducted: preview.summary.stockUnitsToDeduct,
    shortageUnits: preview.summary.shortageUnits,
    revenueCents: preview.summary.revenueCents,
    feesCents: preview.summary.feesCents,
    saleNumbers: readyOrders.map((order) => order.saleNumber),
  };
}