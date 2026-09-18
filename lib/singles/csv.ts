import { canonicalSinglesCondition, type Catalog, type SinglesIntakeRow } from "./types.ts";

export const SINGLES_CSV_TEMPLATE = "Product ID,Name,Set,Number,Finish,Condition,Quantity,Unit Cost,Sell Price\n";
export const MAX_SINGLES_CSV_ROWS = 100;
export type SinglesCsvResult = { rows: SinglesIntakeRow[]; errors: { row: number; message: string }[] };

function csvRows(text: string): Array<{ row: number; values: string[] }> {
  const result: Array<{ row: number; values: string[] }> = [];
  let values: string[] = [], value = "", quoted = false, closed = false, line = 1, startLine = 1;
  const addRow = () => {
    values.push(value);
    if (values.some((cell) => cell.trim())) result.push({ row: startLine, values });
    values = []; value = ""; closed = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') { quoted = false; closed = true; }
      else { value += character; if (character === "\n") line += 1; }
    } else if (character === ",") { values.push(value); value = ""; closed = false; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      addRow(); line += 1; startLine = line;
    } else if (character === '"' && !value && !closed) quoted = true;
    else if (character === '"' || (closed && character.trim())) throw new Error(`Malformed CSV quoting near line ${line}`);
    else if (!closed) value += character;
  }
  if (quoted) throw new Error(`Unclosed CSV quote near line ${startLine}`);
  addRow();
  return result;
}

function cents(value: string, label: string) {
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))
    throw new Error(`${label} must be a nonnegative dollar amount with at most two decimal places`);
  const [whole, fraction = ""] = value.replace(/[$,]/g, "").split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > 2_147_483_647) throw new Error(`${label} is too large`);
  return result;
}

/** Parse and resolve an intake preview. This function never changes inventory. */
export function parseSinglesCsv(text: string, catalog: Catalog): SinglesCsvResult {
  const rows: SinglesIntakeRow[] = [];
  const errors: SinglesCsvResult["errors"] = [];
  if (text.length > 256_000) return { rows, errors: [{ row: 0, message: "CSV is too large; use at most 100 rows" }] };
  let parsed: ReturnType<typeof csvRows>;
  try { parsed = csvRows(text.replace(/^\uFEFF/, "")); }
  catch (error) { return { rows, errors: [{ row: 0, message: error instanceof Error ? error.message : "Invalid CSV" }] }; }
  const header = parsed.shift();
  if (!header || !parsed.length) return { rows, errors: [{ row: 0, message: "CSV needs a header and at least one card row" }] };
  if (parsed.length > MAX_SINGLES_CSV_ROWS) return { rows, errors: [{ row: 0, message: "Import at most 100 card rows at a time" }] };
  const headers = header.values.map((value) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (new Set(headers).size !== headers.length) return { rows, errors: [{ row: header.row, message: "CSV contains duplicate column headers" }] };
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const get = (values: string[], ...names: string[]) => (values[headers.findIndex((name) => names.includes(name))] || "").trim();
  for (const entry of parsed) {
    try {
      if (entry.values.length !== headers.length) throw new Error("Column count does not match the header; quote card names containing commas");
      const finish = get(entry.values, "finish", "printing");
      if (!finish) throw new Error("Finish is required; use the exact catalog finish");
      const condition = canonicalSinglesCondition(get(entry.values, "condition"));
      if (!condition) throw new Error("Condition must be NM, LP, MP, HP, DMG, or its full name");
      const quantityText = get(entry.values, "quantity", "qty");
      const quantity = Number(quantityText);
      if (!/^\d+$/.test(quantityText) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647)
        throw new Error("Quantity must be a positive whole number");
      const costCents = cents(get(entry.values, "unitcost", "cost"), "Unit Cost");
      // Legacy CSV prices remain readable; receiving always replaces them with
      // the reviewed Scrydex quote. New imports may omit the price entirely.
      const price = get(entry.values, "sellprice", "listprice", "price");
      const priceCents = price ? cents(price, "Sell Price") : 0;
      const productIdText = get(entry.values, "productid", "tcgplayerid");
      const name = get(entry.values, "name", "productname");
      const set = get(entry.values, "set", "setname", "setcode");
      const number = get(entry.values, "number", "cardnumber");
      if (productIdText && (!/^\d+$/.test(productIdText) || !Number.isSafeInteger(Number(productIdText)) || Number(productIdText) < 1))
        throw new Error("Product ID must be a positive whole number");
      if (!productIdText && (!name || !set || !number)) throw new Error("Supply Product ID or exact Name, Set, and Number");
      const matches = catalog.cards.filter((card) => {
        if (card.language !== "English" || normalize(card.finish) !== normalize(finish)) return false;
        if (productIdText) return card.productId === Number(productIdText);
        return normalize(card.name) === normalize(name) && normalize(card.number) === normalize(number)
          && [normalize(card.setName), normalize(card.setCode)].includes(normalize(set));
      });
      if (!matches.length) throw new Error("No released English single matches this identity and finish in the catalog");
      if (matches.length !== 1) throw new Error("Ambiguous card identity; use the exact Product ID and Finish");
      const card = matches[0];
      if (productIdText && ((name && normalize(name) !== normalize(card.name)) || (number && normalize(number) !== normalize(card.number)) || (set && ![normalize(card.setName), normalize(card.setCode)].includes(normalize(set)))))
        throw new Error("Product ID conflicts with the supplied Name, Set, or Number");
      rows.push({ cardKey: card.key, condition, quantity, costCents, priceCents });
    } catch (error) {
      errors.push({ row: entry.row, message: error instanceof Error ? error.message : "Invalid card row" });
    }
  }
  return { rows, errors };
}
