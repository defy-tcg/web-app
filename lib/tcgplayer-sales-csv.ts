export type TcgplayerCsvItem = {
  productName: string;
  sku: string;
  barcode: string;
  tcgplayerProductId: number | null;
  game: string;
  setName: string;
  condition: string;
  finish: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
};

export type TcgplayerCsvOrder = {
  orderNumber: string;
  soldAt: string;
  status: string;
  isCanceled: boolean;
  isAggregateSummary: boolean;
  reportedOrderCount: number;
  reportedRefundCount: number;
  reportStartDate: string;
  reportEndDate: string;
  productSubtotalCents: number;
  shippingCents: number;
  discountCents: number;
  taxCents: number;
  feesCents: number;
  totalCents: number;
  netCents: number | null;
  items: TcgplayerCsvItem[];
  sourceRows: number;
};

export type TcgplayerCsvParseResult = {
  headers: string[];
  orders: TcgplayerCsvOrder[];
  warnings: string[];
  rowCount: number;
  hasLineItems: boolean;
};

type HeaderKey =
  | "orderNumber"
  | "orderDate"
  | "status"
  | "productName"
  | "sku"
  | "barcode"
  | "productId"
  | "game"
  | "setName"
  | "condition"
  | "finish"
  | "quantity"
  | "unitPrice"
  | "lineTotal"
  | "productSubtotal"
  | "shipping"
  | "discount"
  | "tax"
  | "fees"
  | "orderTotal"
  | "net"
  | "reportOrderCount"
  | "reportRefundCount"
  | "reportStartDate"
  | "reportEndDate"
  | "reportType";

const aliases: Record<HeaderKey, string[]> = {
  orderNumber: [
    "order number",
    "order #",
    "order no",
    "order id",
    "ordernumber",
    "order",
  ],
  orderDate: [
    "order date",
    "date ordered",
    "ordered at",
    "sale date",
    "transaction date",
    "date",
  ],
  status: ["order status", "status", "transaction status"],
  productName: [
    "product name",
    "item name",
    "card name",
    "product",
    "item",
    "name",
  ],
  sku: [
    "tcgplayer sku",
    "tcgplayer sku id",
    "sku id",
    "seller sku",
    "sku",
  ],
  barcode: ["upc", "barcode", "product barcode"],
  productId: [
    "tcgplayer product id",
    "tcgplayer id",
    "product id",
    "productid",
  ],
  game: ["product line", "game", "category"],
  setName: ["set name", "set"],
  condition: ["condition", "item condition"],
  finish: ["printing", "finish", "foil"],
  quantity: ["item quantity", "total quantity", "qty", "quantity"],
  unitPrice: [
    "unit price",
    "item price",
    "sold price",
    "sale price",
    "price",
  ],
  lineTotal: ["line total", "item total", "extended price", "extended total"],
  productSubtotal: [
    "value of products",
    "product amt",
    "product amount",
    "products amount",
    "product subtotal",
    "merchandise total",
    "subtotal",
  ],
  shipping: [
    "shipping amt",
    "shipping amount",
    "shipping price",
    "shipping paid",
    "shipping total",
    "shipping",
  ],
  discount: ["discount amount", "refund amount", "refunds", "discount"],
  tax: ["tax amount", "sales tax", "seller tax amount", "seller tax", "tax"],
  fees: [
    "tcgplayer fees",
    "marketplace fees",
    "commission fees",
    "seller fees",
    "fee amount",
    "fees",
    "fee",
    "commission",
  ],
  orderTotal: [
    "total amount",
    "buyer paid",
    "order amount",
    "order total",
    "gross amount",
    "gross total",
    "grand total",
    "total paid",
    "total",
  ],
  net: [
    "net proceeds",
    "net amount",
    "seller amount",
    "seller proceeds",
    "payout amount",
    "net",
    "payout",
  ],
  reportOrderCount: ["report order count"],
  reportRefundCount: ["report refund count"],
  reportStartDate: ["report start date"],
  reportEndDate: ["report end date"],
  reportType: ["report type"],
};

function normalizeHeader(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("The order file has an unclosed quoted field");
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseMoney(value: string) {
  const input = value.trim();
  if (!input) return null;
  const negative = /^\(.*\)$/.test(input) || /^-/.test(input);
  const number = Number(input.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(number)) return null;
  const amount = Math.round(number * 100);
  return negative ? -amount : amount;
}

function parsePositiveInt(value: string, fallback = 1) {
  const number = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function parseNonnegativeInt(value: string) {
  const number = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function parseProductId(value: string) {
  const match = value.match(/\d+/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseSoldAt(value: string) {
  const input = value.trim();
  if (!input) return null;
  const dateOnly = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const usDate = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s|$)/);
  const date = dateOnly
    ? new Date(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T12:00:00.000Z`)
    : usDate
      ? new Date(Date.UTC(Number(usDate[3]), Number(usDate[1]) - 1, Number(usDate[2]), 12))
      : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstAmount(current: number | null, value: string) {
  if (current !== null) return current;
  return parseMoney(value);
}

function isCanceledStatus(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("partial")) return false;
  return ["cancel", "refunded", "void", "rejected"].some((word) =>
    normalized.includes(word),
  );
}

type OrderAccumulator = {
  orderNumber: string;
  soldAt: string | null;
  status: string;
  isAggregateSummary: boolean;
  reportedOrderCount: number;
  reportedRefundCount: number;
  reportStartDate: string;
  reportEndDate: string;
  productSubtotalCents: number | null;
  shippingCents: number | null;
  discountCents: number | null;
  taxCents: number | null;
  feesCents: number | null;
  totalCents: number | null;
  netCents: number | null;
  items: TcgplayerCsvItem[];
  sourceRows: number;
};

export function parseTcgplayerSalesCsv(
  text: string,
  now = new Date(),
): TcgplayerCsvParseResult {
  if (!text.trim()) throw new Error("Choose a non-empty TCGplayer order file");
  if (text.length > 5_000_000) {
    throw new Error("That order file is over 5 MB. Export a smaller date range and try again.");
  }

  const rows = parseRows(text);
  if (rows.length < 2) throw new Error("The order file does not contain any order rows");
  if (rows.length > 5_001) {
    throw new Error("That order file has over 5,000 rows. Export a smaller date range and try again.");
  }

  const headers = rows.shift()!.map((header) => header.replace(/^\uFEFF/, "").trim());
  const normalizedHeaders = headers.map(normalizeHeader);
  const indexFor = (key: HeaderKey) => {
    const candidates = aliases[key].map(normalizeHeader);
    return normalizedHeaders.findIndex((header) => candidates.includes(header));
  };
  const indices = Object.fromEntries(
    (Object.keys(aliases) as HeaderKey[]).map((key) => [key, indexFor(key)]),
  ) as Record<HeaderKey, number>;
  const valueAt = (row: string[], key: HeaderKey) =>
    indices[key] >= 0 ? (row[indices[key]] || "").trim() : "";

  if (indices.orderNumber < 0) {
    throw new Error(
      `Defy could not find an Order Number column. Detected: ${headers.slice(0, 12).join(", ")}`,
    );
  }

  const warnings: string[] = [];
  const grouped = new Map<string, OrderAccumulator>();
  let skippedRows = 0;

  for (const row of rows) {
    const orderNumber = valueAt(row, "orderNumber").slice(0, 120);
    if (!orderNumber) {
      skippedRows += 1;
      continue;
    }
    const key = orderNumber.toUpperCase();
    const current = grouped.get(key) || {
      orderNumber,
      soldAt: null,
      status: "",
      isAggregateSummary: false,
      reportedOrderCount: 0,
      reportedRefundCount: 0,
      reportStartDate: "",
      reportEndDate: "",
      productSubtotalCents: null,
      shippingCents: null,
      discountCents: null,
      taxCents: null,
      feesCents: null,
      totalCents: null,
      netCents: null,
      items: [],
      sourceRows: 0,
    };

    current.sourceRows += 1;
    current.soldAt ||= parseSoldAt(valueAt(row, "orderDate"));
    current.status ||= valueAt(row, "status");
    current.isAggregateSummary ||=
      normalizeHeader(valueAt(row, "reportType")) === "seller tax report" ||
      /^SUMMARY-\d{8}-\d{8}$/i.test(orderNumber);
    current.reportedOrderCount ||= parsePositiveInt(
      valueAt(row, "reportOrderCount"),
      0,
    );
    current.reportedRefundCount ||= parseNonnegativeInt(
      valueAt(row, "reportRefundCount"),
    );
    current.reportStartDate ||= valueAt(row, "reportStartDate").slice(0, 10);
    current.reportEndDate ||= valueAt(row, "reportEndDate").slice(0, 10);
    current.productSubtotalCents = firstAmount(
      current.productSubtotalCents,
      valueAt(row, "productSubtotal"),
    );
    current.shippingCents = firstAmount(current.shippingCents, valueAt(row, "shipping"));
    current.discountCents = firstAmount(current.discountCents, valueAt(row, "discount"));
    current.taxCents = firstAmount(current.taxCents, valueAt(row, "tax"));
    current.feesCents = firstAmount(current.feesCents, valueAt(row, "fees"));
    current.totalCents = firstAmount(current.totalCents, valueAt(row, "orderTotal"));
    current.netCents = firstAmount(current.netCents, valueAt(row, "net"));

    const productName = valueAt(row, "productName").slice(0, 300);
    const sku = valueAt(row, "sku").slice(0, 120);
    const tcgplayerProductId = parseProductId(valueAt(row, "productId"));
    if (productName || sku || tcgplayerProductId) {
      const quantity = parsePositiveInt(valueAt(row, "quantity"));
      const rawLineTotal = parseMoney(valueAt(row, "lineTotal"));
      const rawUnitPrice = parseMoney(valueAt(row, "unitPrice"));
      const unitPriceCents = Math.max(
        0,
        rawUnitPrice ?? (rawLineTotal !== null ? Math.round(rawLineTotal / quantity) : 0),
      );
      const lineTotalCents = Math.max(
        0,
        rawLineTotal ?? unitPriceCents * quantity,
      );
      current.items.push({
        productName: productName || (sku ? `TCGplayer SKU ${sku}` : `TCGplayer product ${tcgplayerProductId}`),
        sku,
        barcode: valueAt(row, "barcode").slice(0, 120),
        tcgplayerProductId,
        game: valueAt(row, "game").slice(0, 120),
        setName: valueAt(row, "setName").slice(0, 200),
        condition: valueAt(row, "condition").slice(0, 120),
        finish: valueAt(row, "finish").slice(0, 120),
        quantity,
        unitPriceCents,
        lineTotalCents,
      });
    }
    grouped.set(key, current);
  }

  if (skippedRows) warnings.push(`${skippedRows} row${skippedRows === 1 ? " was" : "s were"} skipped because the order number was blank.`);
  if (!grouped.size) throw new Error("No TCGplayer orders were found in the order file");

  let missingDates = 0;
  const orders = [...grouped.values()].map((order) => {
    const itemSubtotal = order.items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    const shippingCents = Math.max(0, order.shippingCents ?? 0);
    const discountCents = Math.max(0, order.discountCents ?? 0);
    const taxCents = Math.max(0, order.taxCents ?? 0);
    const explicitTotal = Math.max(0, order.totalCents ?? 0);
    let productSubtotalCents = Math.max(0, order.productSubtotalCents ?? itemSubtotal);
    if (!productSubtotalCents && explicitTotal) {
      productSubtotalCents = Math.max(
        0,
        explicitTotal - shippingCents - taxCents + discountCents,
      );
    }
    const revenueBeforeFees = productSubtotalCents + shippingCents;
    const feesCents = Math.abs(order.feesCents ?? 0);
    const totalCents = explicitTotal || Math.max(0, revenueBeforeFees - discountCents) + taxCents;
    const netCents = order.netCents !== null ? Math.max(0, order.netCents) : null;
    if (!order.soldAt) missingDates += 1;
    const status = order.status || "Imported";
    return {
      orderNumber: order.orderNumber,
      soldAt: order.soldAt || now.toISOString(),
      status,
      isCanceled: isCanceledStatus(status),
      isAggregateSummary: order.isAggregateSummary,
      reportedOrderCount: order.reportedOrderCount,
      reportedRefundCount: order.reportedRefundCount,
      reportStartDate: order.reportStartDate,
      reportEndDate: order.reportEndDate,
      productSubtotalCents,
      shippingCents,
      discountCents,
      taxCents,
      feesCents,
      totalCents,
      netCents,
      items: order.items,
      sourceRows: order.sourceRows,
    };
  });

  const hasLineItems = orders.some((order) => order.items.length > 0);
  const aggregateSummary = orders.find((order) => order.isAggregateSummary);
  if (aggregateSummary) {
    if (orders.length !== 1 || orders.filter((order) => order.isAggregateSummary).length !== 1) {
      throw new Error(
        "A Seller Tax Report cannot be mixed with detailed orders or another summary in one import.",
      );
    }
    const startMatch = aggregateSummary.reportStartDate.match(/^\d{4}-\d{2}-\d{2}$/);
    const endMatch = aggregateSummary.reportEndDate.match(/^\d{4}-\d{2}-\d{2}$/);
    const startDate = startMatch
      ? new Date(`${aggregateSummary.reportStartDate}T12:00:00.000Z`)
      : new Date(Number.NaN);
    const endDate = endMatch
      ? new Date(`${aggregateSummary.reportEndDate}T12:00:00.000Z`)
      : new Date(Number.NaN);
    const expectedOrderNumber = `SUMMARY-${aggregateSummary.reportStartDate.replace(/-/g, "")}-${aggregateSummary.reportEndDate.replace(/-/g, "")}`;
    if (
      aggregateSummary.reportedOrderCount <= 0 ||
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      startDate.toISOString().slice(0, 10) !== aggregateSummary.reportStartDate ||
      endDate.toISOString().slice(0, 10) !== aggregateSummary.reportEndDate ||
      startDate > endDate ||
      aggregateSummary.orderNumber.toUpperCase() !== expectedOrderNumber ||
      aggregateSummary.soldAt.slice(0, 10) !== aggregateSummary.reportEndDate ||
      aggregateSummary.items.length > 0 ||
      aggregateSummary.discountCents >
        aggregateSummary.productSubtotalCents + aggregateSummary.shippingCents ||
      aggregateSummary.totalCents !==
        aggregateSummary.productSubtotalCents +
          aggregateSummary.shippingCents -
          aggregateSummary.discountCents +
          aggregateSummary.taxCents
    ) {
      throw new Error(
        "This Seller Tax summary is incomplete or inconsistent. Upload the original TCGplayer .xlsx report.",
      );
    }
    const start = aggregateSummary.reportStartDate || "the report start";
    const end = aggregateSummary.reportEndDate || "the report end";
    warnings.push(
      `This Seller Tax Report summarizes ${aggregateSummary.reportedOrderCount} orders from ${start} through ${end}. Defy will create one summary sale dated ${end}.`,
    );
    warnings.push(
      "The report has no product details, so inventory and cost of goods will not change.",
    );
    const reportDays = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;
    if (Number.isFinite(reportDays) && reportDays > 31) {
      warnings.push(
        `This report spans ${reportDays} days, so all revenue will appear on ${end}. Monthly exports produce more accurate Defy charts.`,
      );
    }
    warnings.push(
      "After import, Defy will block overlapping TCGplayer dates to prevent double-counting.",
    );
  } else if (!hasLineItems) {
    warnings.push(
      "This is an order-summary export. Sales totals can import, but stock will not change because the file has no line-item columns.",
    );
  }
  if (missingDates) {
    warnings.push(
      `${missingDates} order${missingDates === 1 ? " is" : "s are"} missing a readable date and will use the import time.`,
    );
  }
  if (indices.fees < 0) {
    warnings.push(
      aggregateSummary
        ? "This report has no TCGplayer fee column. Add marketplace fees separately as an expense or reported profit will be too high."
        : "No fee column was detected, so TCGplayer fees will not be added as expenses.",
    );
  }

  return {
    headers,
    orders,
    warnings,
    rowCount: rows.length,
    hasLineItems,
  };
}