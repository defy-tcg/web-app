import { canonicalizeGame, gameFromAlias, inferGameFromName, type TcgGameName } from "./tcg-games.ts";
import { legacyCsvFallbackSku } from "./product-sku.ts";

export type InventoryCsvProduct = {
  sku: string | undefined;
  skuWasExplicit: boolean;
  legacySkuCandidates: string[];
  barcode: string | null;
  tcgplayerId: number | null;
  tcgplayerUrl: string | null;
  directImageUrl: string | null;
  name: string;
  productType: "Single" | "Sealed";
  game: TcgGameName;
  setName: string;
  cardNumber: string;
  rarity: string;
  condition: string;
  finish: string;
  quantity: number;
  costCents: number;
  marketPriceCents: number;
  listPriceCents: number;
  location: string;
  lowStockThreshold: number;
  priceSource: string;
};

export function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function money(value: string) {
  return Number(value.replace(/[$,]/g, "")) || 0;
}

function isSealed(name: string, explicit: string) {
  return (
    /sealed/i.test(explicit) ||
    /booster|display|bundle|box|case|deck|collection|tin|pack/i.test(name)
  );
}

export function parseInventoryCsv(text: string): InventoryCsvProduct[] {
  const rows = parseCsvRows(text);
  const headers = (rows.shift() || []).map((header) => header.trim().toLowerCase());
  const column = (row: string[], ...names: string[]) => {
    const index = headers.findIndex((header) =>
      names.some((name) => header === name.toLowerCase()),
    );
    return index >= 0 ? (row[index] || "").trim() : "";
  };

  const products = rows
    .map((row, index) => {
      const name = column(row, "Product Name", "Name", "Business Purchase");
      if (!name) return null;
      const explicitSku = column(row, "SKU");
      const tcgplayerId = Number(column(row, "TCGplayer ID", "Product ID")) || null;
      const condition = column(row, "Condition");
      const finish = column(row, "Printing", "Finish");
      const explicitGame = column(row, "Product Line", "Game");
      const game =
        gameFromAlias(explicitGame)?.name ||
        inferGameFromName(name) ||
        canonicalizeGame(explicitGame);
      const cost = money(
        column(row, "Unit Cost", "Cost Basis", "Cost", "Item Total"),
      );
      const market = money(
        column(row, "TCG Market Price", "Market Price", "Market"),
      );
      const list =
        money(column(row, "TCG Marketplace Price", "My Store Price", "Price")) ||
        market;
      const identity = {
        game,
        name,
        setName: column(row, "Set Name", "Set"),
        cardNumber: column(row, "Number", "Card Number"),
        condition,
        finish,
        tcgplayerId,
      };
      return {
        sku: explicitSku || undefined,
        skuWasExplicit: Boolean(explicitSku),
        legacySkuCandidates: [legacyCsvFallbackSku(identity, index + 1)],
        barcode: column(row, "UPC", "Barcode") || null,
        tcgplayerId,
        tcgplayerUrl: tcgplayerId
          ? `https://www.tcgplayer.com/product/${tcgplayerId}`
          : null,
        directImageUrl:
          column(row, "Image URL", "Product Image", "Picture URL") || null,
        name,
        productType: isSealed(name, column(row, "Product Type"))
          ? "Sealed"
          : "Single",
        game,
        setName: identity.setName,
        cardNumber: identity.cardNumber,
        rarity: column(row, "Rarity"),
        condition,
        finish,
        quantity: Math.max(
          0,
          Number(column(row, "Total Quantity", "Quantity", "Qtty.")) || 0,
        ),
        costCents: Math.round(cost * 100),
        marketPriceCents: Math.round(market * 100),
        listPriceCents: Math.round(list * 100),
        location: column(row, "Location") || "UNASSIGNED",
        lowStockThreshold: 2,
        priceSource: "tcgplayer-csv",
      } satisfies InventoryCsvProduct;
    })
    .filter((product): product is InventoryCsvProduct => Boolean(product));

  if (!products.length) throw new Error("No products found in that CSV");
  return products;
}