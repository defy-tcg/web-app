const MAX_FILE_BYTES = 5_000_000;
const MAX_DATA_ROWS = 5_000;

type WorkbookSheet = {
  sheet: string;
  data: unknown[][];
};

export type TcgplayerSalesFile = {
  text: string;
  worksheetName: string;
};

const orderHeaders = new Set([
  "order",
  "order number",
  "order no",
  "order id",
  "ordernumber",
]);

const supportingHeaders = new Set([
  "order date",
  "date ordered",
  "ordered at",
  "sale date",
  "transaction date",
  "status",
  "order status",
  "product name",
  "item name",
  "card name",
  "item quantity",
  "quantity",
  "qty",
  "unit price",
  "item price",
  "sale price",
  "product amt",
  "product amount",
  "value of products",
  "shipping amt",
  "shipping amount",
  "total amount",
  "order total",
]);

const aggregateReportHeaders = new Set([
  "state",
  "channel",
  "orders",
  "order count",
  "gross sales",
  "product amount",
  "shipping amt",
  "shipping amount",
  "seller tax amt",
  "tcg tax amt",
  "number of refunds",
  "refunds",
  "total refunds",
  "total fees",
  "net sales",
  "net sales minus fees",
]);

const sellerTaxHeaderAliases = {
  state: ["state"],
  channel: ["channel"],
  orders: ["number of orders", "orders", "order count"],
  refunds: ["number of refunds", "refund count"],
  grossSales: ["gross sales"],
  shipping: ["shipping amt", "shipping amount"],
  sellerTax: ["seller tax amt", "seller tax amount"],
  tcgTax: ["tcg tax amt", "tcg tax amount"],
  refundAmount: ["refunds", "refund amount"],
  refundedShipping: ["refunded shipping amt", "refunded shipping amount"],
  refundedSellerTax: ["refunded seller tax amt", "refunded seller tax amount"],
  refundedTcgTax: ["refunded tcg tax amt", "refunded tcg tax amount"],
  netSales: ["net sales"],
  netShipping: ["net shipping amt", "net shipping amount"],
  netSellerTax: ["net seller tax amt", "net seller tax amount"],
  netTcgTax: ["net tcg tax amt", "net tcg tax amount"],
} as const;

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  return String(value);
}

function normalizeHeader(value: unknown) {
  return cellText(value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function headerScore(row: unknown[]) {
  const headers = row.map(normalizeHeader).filter(Boolean);
  if (!headers.some((header) => orderHeaders.has(header))) return 0;
  const supporting = headers.filter((header) => supportingHeaders.has(header)).length;
  return supporting ? 100 + supporting : 0;
}

function looksLikeAggregateReport(sheets: WorkbookSheet[]) {
  return sheets.some((sheet) => {
    const values = sheet.data
      .slice(0, 25)
      .flat()
      .map(normalizeHeader)
      .filter(Boolean);
    return new Set(values.filter((value) => aggregateReportHeaders.has(value))).size >= 3;
  });
}

function indexForAliases(headers: string[], aliases: readonly string[]) {
  return headers.findIndex((header) => aliases.includes(header));
}

function sellerTaxHeaderScore(row: unknown[]) {
  const headers = row.map(normalizeHeader);
  const required = [
    indexForAliases(headers, sellerTaxHeaderAliases.state),
    indexForAliases(headers, sellerTaxHeaderAliases.channel),
    indexForAliases(headers, sellerTaxHeaderAliases.orders),
    indexForAliases(headers, sellerTaxHeaderAliases.refunds),
    indexForAliases(headers, sellerTaxHeaderAliases.grossSales),
    indexForAliases(headers, sellerTaxHeaderAliases.shipping),
    indexForAliases(headers, sellerTaxHeaderAliases.sellerTax),
    indexForAliases(headers, sellerTaxHeaderAliases.tcgTax),
    indexForAliases(headers, sellerTaxHeaderAliases.refundAmount),
    indexForAliases(headers, sellerTaxHeaderAliases.refundedShipping),
    indexForAliases(headers, sellerTaxHeaderAliases.refundedSellerTax),
    indexForAliases(headers, sellerTaxHeaderAliases.refundedTcgTax),
    indexForAliases(headers, sellerTaxHeaderAliases.netSales),
    indexForAliases(headers, sellerTaxHeaderAliases.netShipping),
    indexForAliases(headers, sellerTaxHeaderAliases.netSellerTax),
    indexForAliases(headers, sellerTaxHeaderAliases.netTcgTax),
  ];
  if (required.some((index) => index < 0)) return 0;
  return 200 + headers.filter((header) => aggregateReportHeaders.has(header)).length;
}

function parseUsDateRange(rows: unknown[][], headerIndex: number) {
  const titleText = rows
    .slice(0, Math.max(1, headerIndex))
    .flat()
    .map(cellText)
    .join(" ");
  const match = titleText.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|–|—|to)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  );
  if (!match) return null;

  const asDate = (month: string, day: string, year: string) => {
    const parts = [Number(year), Number(month), Number(day)] as const;
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
    if (
      date.getUTCFullYear() !== parts[0] ||
      date.getUTCMonth() !== parts[1] - 1 ||
      date.getUTCDate() !== parts[2]
    ) {
      return null;
    }
    return date;
  };

  const start = asDate(match[1], match[2], match[3]);
  const end = asDate(match[4], match[5], match[6]);
  if (!start || !end || start > end) return null;
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function parseNonnegativeInteger(value: unknown, field: string) {
  const input = cellText(value).trim();
  if (!/^\d+$/.test(input)) {
    throw new Error(`Defy could not read the report ${field} value “${input || "blank"}”`);
  }
  const number = Number(input);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`A report ${field} value is too large to import safely`);
  }
  return number;
}

function parseMoneyCents(value: unknown) {
  const input = cellText(value).trim();
  if (!input) return 0;
  const parenthesized = /^\(.*\)$/.test(input);
  const cleaned = input.replace(/[^0-9.-]/g, "");
  const match = cleaned.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`Defy could not read the report amount “${input}”`);
  const fraction = `${match[3] || ""}000`;
  let cents = Number(match[2]) * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) throw new Error("A report amount is too large to import safely");
  return parenthesized || match[1] === "-" ? -cents : cents;
}

function centsText(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function compactDate(value: string) {
  return value.replace(/-/g, "");
}

function sellerTaxReportToCsv(candidate: {
  sheetName: string;
  rows: unknown[][];
  headerIndex: number;
}): TcgplayerSalesFile {
  const headers = candidate.rows[candidate.headerIndex].map(normalizeHeader);
  const indices = {
    state: indexForAliases(headers, sellerTaxHeaderAliases.state),
    channel: indexForAliases(headers, sellerTaxHeaderAliases.channel),
    orders: indexForAliases(headers, sellerTaxHeaderAliases.orders),
    refunds: indexForAliases(headers, sellerTaxHeaderAliases.refunds),
    grossSales: indexForAliases(headers, sellerTaxHeaderAliases.grossSales),
    shipping: indexForAliases(headers, sellerTaxHeaderAliases.shipping),
    sellerTax: indexForAliases(headers, sellerTaxHeaderAliases.sellerTax),
    tcgTax: indexForAliases(headers, sellerTaxHeaderAliases.tcgTax),
    refundAmount: indexForAliases(headers, sellerTaxHeaderAliases.refundAmount),
    refundedShipping: indexForAliases(headers, sellerTaxHeaderAliases.refundedShipping),
    refundedSellerTax: indexForAliases(headers, sellerTaxHeaderAliases.refundedSellerTax),
    refundedTcgTax: indexForAliases(headers, sellerTaxHeaderAliases.refundedTcgTax),
    netSales: indexForAliases(headers, sellerTaxHeaderAliases.netSales),
    netShipping: indexForAliases(headers, sellerTaxHeaderAliases.netShipping),
    netSellerTax: indexForAliases(headers, sellerTaxHeaderAliases.netSellerTax),
    netTcgTax: indexForAliases(headers, sellerTaxHeaderAliases.netTcgTax),
  };
  const range = parseUsDateRange(candidate.rows, candidate.headerIndex);
  if (!range) {
    throw new Error(
      "Defy found a Seller Tax Report but could not read its date range. Export it again without renaming the report title.",
    );
  }

  const dataRows = candidate.rows
    .slice(candidate.headerIndex + 1)
    .filter((row) => row.some((cell) => cellText(cell).trim()));
  if (!dataRows.length) throw new Error("The Seller Tax Report does not contain any sales rows");

  for (const row of dataRows) {
    if (normalizeHeader(row[indices.channel]) !== "tcgplayer marketplace") {
      throw new Error(
        "This Seller Tax Report includes a channel Defy cannot safely summarize. Export only TCGplayer Marketplace activity.",
      );
    }
    parseNonnegativeInteger(row[indices.orders], "order count");
    parseNonnegativeInteger(row[indices.refunds], "refund count");
    const amount = (key: keyof typeof indices) => {
      const column = indices[key];
      return column < 0 ? 0 : parseMoneyCents(row[column]);
    };
    const identities = [
      [amount("grossSales") - amount("refundAmount"), amount("netSales")],
      [amount("shipping") - amount("refundedShipping"), amount("netShipping")],
      [amount("sellerTax") - amount("refundedSellerTax"), amount("netSellerTax")],
      [amount("tcgTax") - amount("refundedTcgTax"), amount("netTcgTax")],
    ];
    if (identities.some(([calculated, reported]) => calculated !== reported)) {
      throw new Error(
        "The Seller Tax Report totals do not reconcile. Download a fresh report from TCGplayer and retry.",
      );
    }
  }

  const total = (key: keyof typeof indices, parser: (value: unknown) => number) => {
    const column = indices[key];
    if (column < 0) return 0;
    return dataRows.reduce((sum, row) => sum + parser(row[column]), 0);
  };
  const reportedOrders = total("orders", (value) =>
    parseNonnegativeInteger(value, "order count"),
  );
  const reportedRefunds = total("refunds", (value) =>
    parseNonnegativeInteger(value, "refund count"),
  );
  const productCents = total("grossSales", parseMoneyCents);
  const shippingCents = total("shipping", parseMoneyCents);
  const discountCents =
    total("refundAmount", parseMoneyCents) + total("refundedShipping", parseMoneyCents);
  const taxCents =
    total("netSellerTax", parseMoneyCents) + total("netTcgTax", parseMoneyCents);
  const totalCents = productCents + shippingCents - discountCents + taxCents;
  if (reportedOrders <= 0 || totalCents < 0) {
    throw new Error("The Seller Tax Report does not contain a positive sales summary");
  }

  const syntheticRows = [
    [
      "Order Number",
      "Order Date",
      "Order Status",
      "Product Amount",
      "Shipping Amount",
      "Discount Amount",
      "Tax Amount",
      "Total Amount",
      "Report Order Count",
      "Report Refund Count",
      "Report Start Date",
      "Report End Date",
      "Report Type",
    ],
    [
      `SUMMARY-${compactDate(range.startDate)}-${compactDate(range.endDate)}`,
      range.endDate,
      "Summary report",
      centsText(productCents),
      centsText(shippingCents),
      centsText(discountCents),
      centsText(taxCents),
      centsText(totalCents),
      String(reportedOrders),
      String(reportedRefunds),
      range.startDate,
      range.endDate,
      "Seller Tax Report",
    ],
  ];
  return {
    text: syntheticRows.map((row) => row.map(csvCell).join(",")).join("\n"),
    worksheetName: candidate.sheetName,
  };
}

function trimTrailingEmptyCells(row: unknown[]) {
  let end = row.length;
  while (end > 0 && !cellText(row[end - 1]).trim()) end -= 1;
  return row.slice(0, end);
}

function csvCell(value: unknown) {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function workbookSheetsToCsv(sheets: WorkbookSheet[]): TcgplayerSalesFile {
  const candidates: Array<{
    sheetName: string;
    rows: unknown[][];
    headerIndex: number;
    score: number;
  }> = [];
  const sellerTaxCandidates: Array<{
    sheetName: string;
    rows: unknown[][];
    headerIndex: number;
    score: number;
  }> = [];

  for (const sheet of sheets) {
    let sheetCandidate: (typeof candidates)[number] | undefined;
    let sellerTaxCandidate: (typeof sellerTaxCandidates)[number] | undefined;
    const scanLimit = Math.min(sheet.data.length, 25);
    for (let index = 0; index < scanLimit; index += 1) {
      const score = headerScore(sheet.data[index] || []);
      if (score > (sheetCandidate?.score || 0)) {
        sheetCandidate = {
          sheetName: sheet.sheet,
          rows: sheet.data,
          headerIndex: index,
          score,
        };
      }
      const taxScore = sellerTaxHeaderScore(sheet.data[index] || []);
      if (taxScore > (sellerTaxCandidate?.score || 0)) {
        sellerTaxCandidate = {
          sheetName: sheet.sheet,
          rows: sheet.data,
          headerIndex: index,
          score: taxScore,
        };
      }
    }
    if (sheetCandidate) candidates.push(sheetCandidate);
    if (sellerTaxCandidate) sellerTaxCandidates.push(sellerTaxCandidate);
  }

  if (!candidates.length) {
    if (sellerTaxCandidates.length > 1) {
      throw new Error(
        `Multiple worksheets look like Seller Tax Reports (${sellerTaxCandidates.map((candidate) => candidate.sheetName).join(", ")}). Upload a workbook containing only one report.`,
      );
    }
    if (sellerTaxCandidates.length === 1) {
      return sellerTaxReportToCsv(sellerTaxCandidates[0]);
    }
    if (looksLikeAggregateReport(sheets)) {
      throw new Error(
        "This aggregate TCGplayer workbook does not match the Seller Tax Report format Defy supports.",
      );
    }
    throw new Error(
      "Defy could not find a TCGplayer order worksheet. Make sure the file has an Order Number column plus order details.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple worksheets look like order data (${candidates.map((candidate) => candidate.sheetName).join(", ")}). Upload a workbook containing only the worksheet you want to import.`,
    );
  }

  const best = candidates[0];

  const rows = best.rows
    .slice(best.headerIndex)
    .map(trimTrailingEmptyCells)
    .filter((row) => row.some((cell) => cellText(cell).trim()));

  if (rows.length < 2) {
    throw new Error("The TCGplayer worksheet does not contain any order rows");
  }
  if (rows.length > MAX_DATA_ROWS + 1) {
    throw new Error(
      "That worksheet has over 5,000 rows. Export a smaller date range and try again.",
    );
  }

  return {
    text: rows.map((row) => row.map(csvCell).join(",")).join("\n"),
    worksheetName: best.sheetName,
  };
}

export async function readTcgplayerSalesFile(file: File): Promise<TcgplayerSalesFile> {
  const lowerName = file.name.toLowerCase();
  const isCsv = lowerName.endsWith(".csv");
  const isXlsx = lowerName.endsWith(".xlsx");

  if (!isCsv && !isXlsx) {
    throw new Error("Choose a .xlsx or .csv file exported from TCGplayer");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("That file is over 5 MB. Export a smaller date range and try again.");
  }

  if (isCsv) {
    return { text: await file.text(), worksheetName: "" };
  }

  let sheets: WorkbookSheet[];
  try {
    const { default: readExcelFile } = await import("read-excel-file/browser");
    sheets = (await readExcelFile<string>(file, {
      parseNumber: (rawValue) => rawValue,
    })) as WorkbookSheet[];
  } catch {
    throw new Error(
      "Defy could not read that Excel file. Download it again from TCGplayer and retry.",
    );
  }

  const converted = workbookSheetsToCsv(sheets);
  if (converted.text.length > MAX_FILE_BYTES) {
    throw new Error(
      "That Excel file expands past the 5 MB import limit. Export a smaller date range and try again.",
    );
  }
  return converted;
}