"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { tcgplayerProductUrl } from "@/lib/catalog-image";
import { parseInventoryCsv } from "@/lib/inventory-csv";
import {
  canonicalizeGame,
  TCG_GAME_OPTIONS,
  type TcgGameName,
} from "@/lib/tcg-games";
import {
  catalogProductSku,
  matchesSkuOrBarcode,
  previewManualSku,
} from "@/lib/product-sku";
import TcgplayerSalesImportModal, {
  type TcgplayerImportResult,
} from "./tcgplayer-sales-import-modal";
import ThemeToggle from "./theme-toggle";

type Product = {
  id: number;
  sku: string;
  barcode: string | null;
  tcgplayerId: number | null;
  tcgplayerUrl: string | null;
  imageUrl: string | null;
  name: string;
  productType: "Single" | "Sealed";
  game: string;
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
  priceUpdatedAt: string | null;
};
type Sale = {
  id: string;
  saleNumber: string;
  channel: string;
  paymentMethod: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  cogsCents: number;
  itemsCount: number;
  note: string;
  soldAt: string;
};
type SaleItem = {
  id: string;
  saleId: string;
  productId: number | null;
  productName: string;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
};
type Expense = {
  id: string;
  category: string;
  vendor: string;
  description: string;
  amountCents: number;
  recurrence: string;
  expenseDate: string;
  note: string;
};
type StoreEvent = {
  id: string;
  name: string;
  game: string;
  eventDate: string;
  entryFeeCents: number;
  players: number;
  prizeCostCents: number;
  otherCostCents: number;
  status: string;
  note: string;
};
type View =
  | "overview"
  | "scanner"
  | "sales"
  | "inventory"
  | "expenses"
  | "events"
  | "reports";
type Modal =
  | "sale"
  | "product"
  | "image"
  | "label"
  | "expense"
  | "event"
  | "import"
  | "tcgSalesImport"
  | null;
type CartLine = {
  key: string;
  productId: number | null;
  productName: string;
  sku: string;
  game: string;
  imageUrl: string | null;
  quantity: number;
  unitPriceCents: number;
  stickerPriceCents: number;
  marketPriceCents: number | null;
  unitCostCents: number;
  stock: number | null;
};
type ScanMode = "lookup" | "receive" | "remove" | "checkout";
type ScanLog = {
  id: string;
  productName: string;
  sku: string;
  action: string;
  time: string;
};
type SheetSyncResult = {
  syncedAt: string;
  products: number;
  units: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  needsImage?: string[];
  needsGame?: string[];
  error?: string;
};

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const compactMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});
const dollars = (cents: number) => currency.format(cents / 100);
const cents = (value: FormDataEntryValue | null) =>
  Math.max(0, Math.round((Number(value) || 0) * 100));
const day = (value: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(value),
  );
const localDateTime = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
const localDate = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

type TcgSummaryRange = {
  start: Date;
  end: Date;
  startKey: string;
  endKey: string;
  isMultiDay: boolean;
};

function compactUtcDate(year: string, month: string, dayOfMonth: string) {
  const parts = [year, month, dayOfMonth].map(Number);
  const [numericYear, numericMonth, numericDay] = parts;
  if (
    !parts.every(Number.isInteger) ||
    numericYear < 1000 ||
    numericMonth < 1 ||
    numericMonth > 12 ||
    numericDay < 1 ||
    numericDay > 31
  )
    return null;

  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(numericYear, numericMonth - 1, numericDay);
  if (
    value.getUTCFullYear() !== numericYear ||
    value.getUTCMonth() !== numericMonth - 1 ||
    value.getUTCDate() !== numericDay
  )
    return null;
  return value;
}

function parseTcgSummaryRange(saleNumber: string): TcgSummaryRange | null {
  const match =
    /^TCG-SUMMARY-(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/.exec(
      saleNumber,
    );
  if (!match) return null;

  const start = compactUtcDate(match[1], match[2], match[3]);
  const end = compactUtcDate(match[4], match[5], match[6]);
  if (!start || !end || start > end) return null;

  const startKey = `${match[1]}${match[2]}${match[3]}`;
  const endKey = `${match[4]}${match[5]}${match[6]}`;
  return {
    start,
    end,
    startKey,
    endKey,
    isMultiDay: startKey !== endKey,
  };
}

function localCalendarKey(value: Date) {
  return [
    value.getFullYear().toString().padStart(4, "0"),
    (value.getMonth() + 1).toString().padStart(2, "0"),
    value.getDate().toString().padStart(2, "0"),
  ].join("");
}

function ProfitIncompleteNotice() {
  return (
    <div
      className="tcg-import-info tcg-summary-profit-warning"
      role="status"
    >
      <strong>Profit is incomplete</strong>
      <span>
        TCGplayer summary revenue is included, but the Seller Tax Report has no
        product costs or marketplace fees. Revenue is included; gross and net
        profit are not available for this period.
      </span>
    </div>
  );
}

function Empty({
  title,
  copy,
  action,
  label,
}: {
  title: string;
  copy: string;
  action: () => void;
  label: string;
}) {
  return (
    <div className="empty">
      <span>＋</span>
      <strong>{title}</strong>
      <p>{copy}</p>
      <button className="dark-button" onClick={action}>
        {label}
      </button>
    </div>
  );
}
function ProductThumb({
  product,
  className = "",
}: {
  product: { name: string; game: string; imageUrl: string | null };
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState("");
  const showImage = Boolean(product.imageUrl && failedUrl !== product.imageUrl);
  return (
    <span className={`product-thumb ${className}`.trim()}>
      {showImage ? (
        <Image
          src={product.imageUrl!}
          alt={`${product.name} product`}
          fill
          sizes="64px"
          unoptimized
          onError={() => setFailedUrl(product.imageUrl || "")}
        />
      ) : (
        <b>{product.game.slice(0, 2).toUpperCase() || "TC"}</b>
      )}
    </span>
  );
}

function EditableNumber({
  label,
  value,
  money = false,
  onCommit,
}: {
  label: string;
  value: number;
  money?: boolean;
  onCommit: (value: number) => Promise<boolean>;
}) {
  const format = (amount: number) =>
    money ? (amount / 100).toFixed(2) : String(amount);
  const [draft, setDraft] = useState(() => format(value));
  const [saving, setSaving] = useState(false);
  async function commit() {
    if (saving) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDraft(format(value));
      return;
    }
    const next = money ? Math.round(parsed * 100) : Math.round(parsed);
    if (next === value) {
      setDraft(format(value));
      return;
    }
    setSaving(true);
    const saved = await onCommit(next);
    setDraft(saved ? format(next) : format(value));
    setSaving(false);
  }
  return (
    <label
      className={`editable-number ${money ? "money" : "stock"} ${saving ? "saving" : ""}`.trim()}
    >
      {money && <span aria-hidden="true">$</span>}
      <input
        aria-label={label}
        type="number"
        min="0"
        step={money ? "0.01" : "1"}
        inputMode={money ? "decimal" : "numeric"}
        value={draft}
        disabled={saving}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(format(value));
            event.currentTarget.blur();
          }
        }}
      />
      {saving && <i aria-label="Saving" />}
    </label>
  );
}

const code39Patterns: Record<string, string> = {
  "0": "nnnwwnwnn",
  "1": "wnnwnnnnw",
  "2": "nnwwnnnnw",
  "3": "wnwwnnnnn",
  "4": "nnnwwnnnw",
  "5": "wnnwwnnnn",
  "6": "nnwwwnnnn",
  "7": "nnnwnnwnw",
  "8": "wnnwnnwnn",
  "9": "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  "*": "nwnnwnwnn",
};

function barcodeGeometry(rawValue: string) {
  const value = rawValue.toUpperCase().replace(/[^A-Z0-9 .-]/g, "-");
  const encoded = `*${value}*`;
  const bars: Array<{ x: number; width: number }> = [];
  let x = 12;
  for (const character of encoded) {
    const pattern = code39Patterns[character] || code39Patterns["-"];
    for (let index = 0; index < pattern.length; index += 1) {
      const width = pattern[index] === "w" ? 3 : 1;
      if (index % 2 === 0) bars.push({ x, width });
      x += width;
    }
    x += 1;
  }
  return { value, bars, width: x + 11 };
}

function Barcode({ value }: { value: string }) {
  const geometry = barcodeGeometry(value);
  return (
    <svg
      className="barcode"
      viewBox={`0 0 ${geometry.width} 42`}
      role="img"
      aria-label={`Barcode for ${geometry.value}`}
      preserveAspectRatio="none"
    >
      {geometry.bars.map((bar, index) => (
        <rect
          key={`${bar.x}-${index}`}
          x={bar.x}
          y="0"
          width={bar.width}
          height="34"
        />
      ))}
    </svg>
  );
}
function html(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ] || character,
  );
}

export default function StoreOS() {
  const [view, setView] = useState<View>("overview");
  const [modal, setModal] = useState<Modal>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [events, setEvents] = useState<StoreEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [csvText, setCsvText] = useState("");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("30");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [saleSearch, setSaleSearch] = useState("");
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customCost, setCustomCost] = useState("");
  const [deletingProductId, setDeletingProductId] = useState<number | null>(
    null,
  );
  const [productSku, setProductSku] = useState("");
  const [productSkuManaged, setProductSkuManaged] = useState(true);
  const [productGame, setProductGame] = useState<TcgGameName>("Pokémon");
  const [productTcgplayerId, setProductTcgplayerId] = useState("");
  const [productImageUrl, setProductImageUrl] = useState("");
  const [inventoryGame, setInventoryGame] = useState<"All" | TcgGameName>("All");
  const [imageProduct, setImageProduct] = useState<Product | null>(null);
  const [imageTcgplayerId, setImageTcgplayerId] = useState("");
  const [imageDirectUrl, setImageDirectUrl] = useState("");
  const [labelProduct, setLabelProduct] = useState<Product | null>(null);
  const [labelCopies, setLabelCopies] = useState(1);
  const [labelSize, setLabelSize] = useState<"50x30" | "40x30">("50x30");
  const [labelPrice, setLabelPrice] = useState("");
  const [scanMode, setScanMode] = useState<ScanMode>("lookup");
  const [scanValue, setScanValue] = useState("");
  const [scanResult, setScanResult] = useState<Product | null>(null);
  const [scanError, setScanError] = useState("");
  const [scanPriceStatus, setScanPriceStatus] = useState("");
  const [scanPriceError, setScanPriceError] = useState(false);
  const [scanTcgplayerLink, setScanTcgplayerLink] = useState("");
  const [scanLog, setScanLog] = useState<ScanLog[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [sheetSyncing, setSheetSyncing] = useState(false);
  const [sheetSyncStatus, setSheetSyncStatus] = useState(
    "Master sheet sync is on",
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const [anchorTime] = useState(() => Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const scannerInput = useRef<HTMLInputElement>(null);
  const sheetSyncBusy = useRef(false);

  async function loadAll() {
    setLoading(true);
    try {
      const [inventoryResponse, storeResponse] = await Promise.all([
        fetch("/api/inventory", { cache: "no-store" }),
        fetch("/api/store", { cache: "no-store" }),
      ]);
      const inventory = (await inventoryResponse.json()) as {
        products?: Product[];
        error?: string;
      };
      const store = (await storeResponse.json()) as {
        sales?: Sale[];
        saleItems?: SaleItem[];
        expenses?: Expense[];
        events?: StoreEvent[];
        error?: string;
      };
      if (!inventoryResponse.ok)
        throw new Error(inventory.error || "Could not load inventory");
      if (!storeResponse.ok)
        throw new Error(store.error || "Could not load store reporting");
      setProducts(inventory.products || []);
      setSales(store.sales || []);
      setSaleItems(store.saleItems || []);
      setExpenses(store.expenses || []);
      setEvents(store.events || []);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load store data",
      );
    } finally {
      setLoading(false);
    }
  }

  async function syncMasterSheet(showToast = true) {
    if (sheetSyncBusy.current) return;
    sheetSyncBusy.current = true;
    setSheetSyncing(true);
    try {
      const response = await fetch("/api/inventory/sheet-sync", {
        method: "POST",
        cache: "no-store",
      });
      const result = (await response.json()) as SheetSyncResult;
      if (!response.ok)
        throw new Error(result.error || "Master sheet sync failed");

      const inventoryResponse = await fetch("/api/inventory", {
        cache: "no-store",
      });
      const inventory = (await inventoryResponse.json()) as {
        products?: Product[];
        error?: string;
      };
      if (!inventoryResponse.ok)
        throw new Error(inventory.error || "Could not refresh inventory");
      setProducts(inventory.products || []);
      const syncedTime = new Date(result.syncedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
      setSheetSyncStatus(
        result.needsGame?.length
          ? `Synced ${syncedTime} · ${result.needsGame.length} row${result.needsGame.length === 1 ? " needs" : "s need"} a Game or Product Line`
          : result.needsImage?.length
          ? `Synced ${syncedTime} · ${result.needsImage.length} product${result.needsImage.length === 1 ? " needs" : "s need"} an exact picture`
          : `Synced ${syncedTime} · ${result.products} products · ${result.units} units`,
      );
      setError("");
      if (showToast) {
        notify(
          result.needsGame?.length
            ? `Add a Game or Product Line for: ${result.needsGame[0]}`
            : result.needsImage?.length
            ? `Picture needed before adding: ${result.needsImage[0]}`
            : result.created || result.updated
            ? `Master sheet synced · ${result.created} new · ${result.updated} updated`
            : "Master sheet already matches Defy",
        );
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Master sheet sync failed";
      setSheetSyncStatus(`Sheet sync needs attention · ${message}`);
      if (showToast) notify(message);
    } finally {
      sheetSyncBusy.current = false;
      setSheetSyncing(false);
    }
  }

  useEffect(() => {
    const task = window.setTimeout(() => void loadAll(), 0);
    return () => window.clearTimeout(task);
  }, []);
  useEffect(() => {
    const firstSync = window.setTimeout(
      () => void syncMasterSheet(false),
      2500,
    );
    const recurringSync = window.setInterval(
      () => void syncMasterSheet(false),
      5 * 60 * 1000,
    );
    return () => {
      window.clearTimeout(firstSync);
      window.clearInterval(recurringSync);
    };
    // Run from the stable mount timers; later renders should not restart polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (view !== "scanner" || modal) return;
    const task = window.setTimeout(() => scannerInput.current?.focus(), 0);
    return () => window.clearTimeout(task);
  }, [view, modal, scanMode]);
  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }
  async function storeAction(payload: Record<string, unknown>) {
    const response = await fetch("/api/store", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as {
      error?: string;
      saleNumber?: string;
    };
    if (!response.ok) throw new Error(data.error || "Store update failed");
    return data;
  }
  async function inventoryAction(payload: Record<string, unknown>) {
    const response = await fetch("/api/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as {
      error?: string;
      product?: Product;
      imageMatch?: { matchedName?: string } | null;
    };
    if (!response.ok) throw new Error(data.error || "Inventory update failed");
    return data;
  }

  const startDate = useMemo(
    () =>
      range === "all" ? null : new Date(anchorTime - Number(range) * 86400000),
    [range, anchorTime],
  );
  const filteredSales = useMemo(
    () => {
      if (!startDate) return sales;
      const selectedStartKey = localCalendarKey(startDate);
      const selectedEndKey = localCalendarKey(new Date(anchorTime));
      return sales.filter((item) => {
        const summaryRange = parseTcgSummaryRange(item.saleNumber);
        if (summaryRange)
          return (
            summaryRange.startKey >= selectedStartKey &&
            summaryRange.endKey <= selectedEndKey
          );
        return new Date(item.soldAt) >= startDate;
      });
    },
    [sales, startDate, anchorTime],
  );
  const filteredExpenses = useMemo(
    () =>
      expenses.filter(
        (item) => !startDate || new Date(item.expenseDate) >= startDate,
      ),
    [expenses, startDate],
  );
  const filteredEvents = useMemo(
    () =>
      events.filter(
        (item) => !startDate || new Date(item.eventDate) >= startDate,
      ),
    [events, startDate],
  );
  const metrics = useMemo(() => {
    const revenue = filteredSales.reduce(
      (sum, item) => sum + item.subtotalCents - item.discountCents,
      0,
    );
    const cogs = filteredSales.reduce((sum, item) => sum + item.cogsCents, 0);
    const operating = filteredExpenses.reduce(
      (sum, item) => sum + item.amountCents,
      0,
    );
    const gross = revenue - cogs;
    const net = gross - operating;
    const orderCount = filteredSales.reduce(
      (sum, sale) =>
        sum +
        (parseTcgSummaryRange(sale.saleNumber)
          ? Math.max(1, sale.itemsCount)
          : 1),
      0,
    );
    return {
      revenue,
      cogs,
      operating,
      gross,
      net,
      margin: revenue ? (net / revenue) * 100 : 0,
      orders: orderCount,
      avg: orderCount ? revenue / orderCount : 0,
      units: products.reduce((sum, item) => sum + item.quantity, 0),
      inventoryCost: products.reduce(
        (sum, item) => sum + item.costCents * item.quantity,
        0,
      ),
      inventoryMarket: products.reduce(
        (sum, item) => sum + item.marketPriceCents * item.quantity,
        0,
      ),
      low: products.filter((item) => item.quantity <= item.lowStockThreshold)
        .length,
    };
  }, [filteredSales, filteredExpenses, products]);
  const profitIncomplete = filteredSales.some(
    (sale) => parseTcgSummaryRange(sale.saleNumber) !== null,
  );

  const chartDays = useMemo(() => {
    const result = Array.from({ length: 7 }, (_, index) => {
      const value = new Date();
      value.setHours(0, 0, 0, 0);
      value.setDate(value.getDate() - (6 - index));
      return {
        key: value.toISOString().slice(0, 10),
        label: value.toLocaleDateString("en-US", { weekday: "short" }),
        revenue: 0,
        expenses: 0,
      };
    });
    for (const sale of sales) {
      const summaryRange = parseTcgSummaryRange(sale.saleNumber);
      if (summaryRange?.isMultiDay) continue;
      const key = new Date(sale.soldAt).toISOString().slice(0, 10);
      const target = result.find((item) => item.key === key);
      if (target) target.revenue += sale.subtotalCents - sale.discountCents;
    }
    for (const expense of expenses) {
      const key = new Date(expense.expenseDate).toISOString().slice(0, 10);
      const target = result.find((item) => item.key === key);
      if (target) target.expenses += expense.amountCents;
    }
    return result;
  }, [sales, expenses]);
  const chartMax = Math.max(
    1,
    ...chartDays.flatMap((item) => [item.revenue, item.expenses]),
  );

  const channelMix = useMemo(() => {
    const map = new Map<string, number>();
    for (const sale of filteredSales)
      map.set(
        sale.channel,
        (map.get(sale.channel) || 0) + sale.subtotalCents - sale.discountCents,
      );
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [filteredSales]);
  const expenseMix = useMemo(() => {
    const map = new Map<string, number>();
    for (const expense of filteredExpenses)
      map.set(
        expense.category,
        (map.get(expense.category) || 0) + expense.amountCents,
      );
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [filteredExpenses]);
  const topProducts = useMemo(() => {
    const ids = new Set(filteredSales.map((item) => item.id));
    const map = new Map<
      string,
      { name: string; quantity: number; revenue: number }
    >();
    for (const item of saleItems) {
      if (!ids.has(item.saleId)) continue;
      const key = item.sku || item.productName;
      const current = map.get(key) || {
        name: item.productName,
        quantity: 0,
        revenue: 0,
      };
      current.quantity += item.quantity;
      current.revenue += item.unitPriceCents * item.quantity;
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6);
  }, [filteredSales, saleItems]);

  const visibleProducts = useMemo(() => {
    const needle = query.toLowerCase();
    return products.filter(
      (item) =>
        (inventoryGame === "All" || canonicalizeGame(item.game) === inventoryGame) &&
        (!needle || [item.name, item.sku, item.setName, item.game, item.location]
          .join(" ")
          .toLowerCase()
          .includes(needle)),
    );
  }, [products, query, inventoryGame]);
  const inventoryGameCounts = useMemo(() => {
    const counts = new Map<string, Set<string>>();
    counts.set("All", new Set());
    for (const option of TCG_GAME_OPTIONS) counts.set(option.name, new Set());
    for (const product of products) {
      const sku = product.sku.trim().toUpperCase();
      counts.get("All")?.add(sku);
      counts.get(canonicalizeGame(product.game))?.add(sku);
    }
    return new Map([...counts].map(([game, skus]) => [game, skus.size]));
  }, [products]);
  const visibleSales = useMemo(() => {
    const needle = query.toLowerCase();
    return filteredSales.filter(
      (item) =>
        !needle ||
        [item.saleNumber, item.channel, item.paymentMethod, item.note]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  }, [filteredSales, query]);
  const visibleExpenses = useMemo(() => {
    const needle = query.toLowerCase();
    return filteredExpenses.filter(
      (item) =>
        !needle ||
        [item.description, item.vendor, item.category]
          .join(" ")
          .toLowerCase()
          .includes(needle),
    );
  }, [filteredExpenses, query]);

  function nextSku(game = productGame, tcgplayerId = productTcgplayerId) {
    const id = Number(tcgplayerId);
    return id > 0
      ? catalogProductSku(game, id)
      : previewManualSku(game, products.map((product) => product.sku));
  }
  function openProduct(preselected?: unknown) {
    const game = typeof preselected === "string"
      ? canonicalizeGame(preselected)
      : inventoryGame === "All" ? "Pokémon" : inventoryGame;
    setProductGame(game);
    setProductTcgplayerId("");
    setProductSkuManaged(true);
    setProductSku(previewManualSku(game, products.map((product) => product.sku)));
    setProductImageUrl("");
    setModal("product");
  }
  function openImageLink(product: Product) {
    const catalogUrl = tcgplayerProductUrl(
      product.tcgplayerId,
      product.tcgplayerUrl,
    );
    setImageProduct(product);
    setImageTcgplayerId(product.tcgplayerId ? String(product.tcgplayerId) : "");
    setImageDirectUrl(catalogUrl ? "" : product.imageUrl || "");
    setModal("image");
  }
  function openLabel(product: Product, copies = 1) {
    setLabelProduct(product);
    setLabelCopies(Math.max(1, Math.min(100, copies)));
    setLabelPrice(
      ((product.listPriceCents || product.marketPriceCents) / 100).toFixed(2),
    );
    setModal("label");
  }
  function labelSvg(product: Product) {
    const geometry = barcodeGeometry(product.sku);
    const bars = geometry.bars
      .map(
        (bar) => `<rect x="${bar.x}" y="0" width="${bar.width}" height="34"/>`,
      )
      .join("");
    return `<svg viewBox="0 0 ${geometry.width} 42" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
  }
  function printLabels(product: Product) {
    const printablePrice = dollars(
      Math.max(0, Math.round((Number(labelPrice) || 0) * 100)),
    );
    const detail = [
      product.setName,
      product.cardNumber,
      product.condition,
      product.finish,
    ]
      .filter(Boolean)
      .join(" · ");
    const copies = Array.from(
      { length: labelCopies },
      () =>
        `<section class="label"><header><b>DEFY TCG</b><strong>${html(printablePrice)}</strong></header><h1>${html(product.name)}</h1><p>${html(detail || product.game)}</p>${labelSvg(product)}<footer>${html(product.sku)}</footer></section>`,
    ).join("");
    const width = labelSize === "40x30" ? 40 : 50;
    const compact = width === 40;
    const popup = window.open("", "_blank", "width=560,height=720");
    if (!popup) {
      notify("Allow pop-ups to print labels");
      return;
    }
    popup.document.write(
      `<!doctype html><html><head><title>${html(product.sku)} labels</title><style>@page{size:${width}mm 30mm;margin:0}*{box-sizing:border-box}html,body{margin:0;font-family:Arial,sans-serif;color:#000}.label{width:${width}mm;height:30mm;padding:${compact ? "1.8mm 2mm 1.4mm" : "2.2mm 2.6mm 1.6mm"};overflow:hidden;page-break-after:always}header{display:flex;align-items:flex-end;justify-content:space-between}header b{font-size:${compact ? "6pt" : "7pt"};letter-spacing:.12em}header strong{font-size:${compact ? "14pt" : "17pt"};line-height:1}h1{margin:${compact ? ".8mm" : "1mm"} 0 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:${compact ? "7.5pt" : "8.5pt"};line-height:1.1}p{height:3mm;margin:.5mm 0 .7mm;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:${compact ? "5.5pt" : "6pt"}}svg{display:block;width:100%;height:${compact ? "8mm" : "9mm"};shape-rendering:crispEdges;fill:#000}footer{text-align:center;font:${compact ? "6pt" : "7pt"} monospace;letter-spacing:.08em}</style></head><body>${copies}<script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script></body></html>`,
    );
    popup.document.close();
  }
  function openSale() {
    setCart([]);
    setSaleSearch("");
    setModal("sale");
  }
  function addProduct(product: Product) {
    setCart((current) => {
      const existing = current.find((item) => item.productId === product.id);
      if (existing)
        return current.map((item) =>
          item.productId === product.id
            ? {
                ...item,
                quantity: Math.min(product.quantity, item.quantity + 1),
              }
            : item,
        );
      const stickerPriceCents =
        product.listPriceCents || product.marketPriceCents;
      return [
        ...current,
        {
          key: `p-${product.id}`,
          productId: product.id,
          productName: product.name,
          sku: product.sku,
          game: product.game,
          imageUrl: product.imageUrl,
          quantity: 1,
          unitPriceCents: stickerPriceCents,
          stickerPriceCents,
          marketPriceCents: product.marketPriceCents,
          unitCostCents: product.costCents,
          stock: product.quantity,
        },
      ];
    });
  }
  function addCustom() {
    if (!customName.trim() || !Number(customPrice)) return;
    const priceCents = Math.round(Number(customPrice) * 100);
    setCart((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        productId: null,
        productName: customName.trim(),
        sku: "",
        game: "Other",
        imageUrl: null,
        quantity: 1,
        unitPriceCents: priceCents,
        stickerPriceCents: priceCents,
        marketPriceCents: null,
        unitCostCents: Math.round((Number(customCost) || 0) * 100),
        stock: null,
      },
    ]);
    setCustomName("");
    setCustomPrice("");
    setCustomCost("");
  }
  function updateCart(
    key: string,
    field: "quantity" | "unitPriceCents",
    value: number,
  ) {
    setCart((current) =>
      current.map((item) =>
        item.key === key
          ? {
              ...item,
              [field]:
                field === "quantity"
                  ? Math.max(1, Math.min(item.stock || 9999, Math.round(value)))
                  : Math.max(0, Math.round(value)),
            }
          : item,
      ),
    );
  }
  const cartSubtotal = cart.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0,
  );
  const cartStickerTotal = cart.reduce(
    (sum, item) => sum + item.stickerPriceCents * item.quantity,
    0,
  );
  const cartPriceAdjustment = cartSubtotal - cartStickerTotal;
  const cartCogs = cart.reduce(
    (sum, item) => sum + item.unitCostCents * item.quantity,
    0,
  );

  async function createSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cart.length) {
      notify("Add at least one item");
      return;
    }
    const form = new FormData(event.currentTarget);
    const priceOverrides = cart
      .filter(
        (item) =>
          item.productId && item.unitPriceCents !== item.stickerPriceCents,
      )
      .map(
        (item) =>
          `${item.sku}: ${dollars(item.stickerPriceCents)} → ${dollars(item.unitPriceCents)}`,
      );
    const enteredNote = String(form.get("note") || "").trim();
    const note = [
      enteredNote,
      priceOverrides.length
        ? `Price override — ${priceOverrides.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    try {
      const data = await storeAction({
        action: "createSale",
        channel: form.get("channel"),
        paymentMethod: form.get("paymentMethod"),
        discountCents: cents(form.get("discount")),
        taxCents: cents(form.get("tax")),
        soldAt: form.get("soldAt"),
        note,
        items: cart,
      });
      setModal(null);
      setCart([]);
      await loadAll();
      notify(
        `${data.saleNumber || "Sale"} recorded${priceOverrides.length ? " with price override" : ""}`,
      );
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Could not record sale",
      );
    }
  }

  async function createExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await storeAction({
        action: "createExpense",
        category: form.get("category"),
        vendor: form.get("vendor"),
        description: form.get("description"),
        amountCents: cents(form.get("amount")),
        recurrence: form.get("recurrence"),
        expenseDate: form.get("expenseDate"),
        note: form.get("note"),
      });
      setModal(null);
      await loadAll();
      notify("Expense recorded");
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Could not record expense",
      );
    }
  }
  async function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await storeAction({
        action: "createEvent",
        name: form.get("name"),
        game: form.get("game"),
        eventDate: form.get("eventDate"),
        entryFeeCents: cents(form.get("entryFee")),
        players: Number(form.get("players")) || 0,
        prizeCostCents: cents(form.get("prizeCost")),
        otherCostCents: cents(form.get("otherCost")),
        status: form.get("status"),
        note: form.get("note"),
      });
      setModal(null);
      await loadAll();
      notify("Event saved");
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Could not save event");
    }
  }
  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tcgplayerId = Number(form.get("tcgplayerId")) || null;
    try {
      const data = await inventoryAction({
        action: "create",
        product: {
          sku: productSku.trim().toUpperCase(),
          skuAutoManaged: productSkuManaged,
          barcode: String(form.get("barcode") || "") || null,
          tcgplayerId,
          tcgplayerUrl: tcgplayerId
            ? `https://www.tcgplayer.com/product/${tcgplayerId}`
            : null,
          directImageUrl: productImageUrl.trim() || null,
          name: form.get("name"),
          productType: form.get("productType"),
          game: productGame,
          setName: form.get("setName"),
          cardNumber: form.get("cardNumber"),
          condition: form.get("condition"),
          finish: form.get("finish"),
          quantity: Number(form.get("quantity")) || 0,
          costCents: cents(form.get("cost")),
          marketPriceCents: cents(form.get("market")),
          listPriceCents: cents(form.get("list")),
          location: form.get("location"),
          lowStockThreshold: Number(form.get("lowStockThreshold")) || 2,
          priceSource: "manual",
        },
      });
      await loadAll();
      if (data.product) {
        openLabel(data.product, Math.max(1, data.product.quantity));
        notify(
          data.imageMatch?.matchedName
            ? `Product added with exact picture · ${data.imageMatch.matchedName}`
            : "Product added with picture — label ready",
        );
      } else {
        setModal(null);
        notify("Product added");
      }
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Could not add product",
      );
    }
  }
  async function linkProductImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!imageProduct) return;
    try {
      const data = await inventoryAction({
        action: "linkImage",
        id: imageProduct.id,
        product: {
          tcgplayerId: Number(imageTcgplayerId) || null,
          directImageUrl: imageDirectUrl.trim() || null,
        },
      });
      if (data.product) {
        setProducts((current) =>
          current.map((product) =>
            product.id === data.product!.id ? data.product! : product,
          ),
        );
      }
      setImageProduct(null);
      setModal(null);
      notify(`${imageProduct.name} picture saved`);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Picture update failed");
    }
  }
  async function adjustStock(product: Product, delta: number) {
    try {
      await inventoryAction({
        action: "adjust",
        id: product.id,
        delta,
        reason: delta > 0 ? "manual receive" : "manual removal",
      });
      setProducts((current) =>
        current.map((item) =>
          item.id === product.id
            ? { ...item, quantity: Math.max(0, item.quantity + delta) }
            : item,
        ),
      );
      notify(`${product.name}: ${delta > 0 ? "+" : ""}${delta}`);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Stock update failed");
    }
  }
  async function setStock(product: Product, quantity: number) {
    const delta = quantity - product.quantity;
    if (!delta) return true;
    try {
      const data = await inventoryAction({
        action: "adjust",
        id: product.id,
        delta,
        reason: "manual stock count",
      });
      if (data.product)
        setProducts((current) =>
          current.map((item) =>
            item.id === product.id ? data.product! : item,
          ),
        );
      notify(`${product.name} stock saved`);
      return true;
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Stock update failed");
      return false;
    }
  }
  async function updateProductValue(
    product: Product,
    changes: Partial<Product>,
  ) {
    const marksManual = Object.prototype.hasOwnProperty.call(
      changes,
      "marketPriceCents",
    );
    const next = {
      ...product,
      ...changes,
      priceSource: marksManual ? "manual" : product.priceSource,
    };
    try {
      const data = await inventoryAction({
        action: "update",
        id: product.id,
        product: next,
      });
      if (data.product)
        setProducts((current) =>
          current.map((item) =>
            item.id === product.id ? data.product! : item,
          ),
        );
      notify(`${product.name} saved`);
      return true;
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Product update failed",
      );
      return false;
    }
  }
  async function deleteProduct(product: Product) {
    const stockWarning = product.quantity
      ? ` This will also remove its ${product.quantity} in-stock unit${product.quantity === 1 ? "" : "s"}.`
      : "";
    if (
      !window.confirm(
        `Remove “${product.name}” from the catalog?${stockWarning} Past sales will stay in your reports.`,
      )
    )
      return;
    setDeletingProductId(product.id);
    try {
      await inventoryAction({ action: "delete", id: product.id });
      setProducts((current) =>
        current.filter((item) => item.id !== product.id),
      );
      notify(`${product.name} removed`);
    } catch (caught) {
      notify(
        caught instanceof Error ? caught.message : "Could not remove product",
      );
    } finally {
      setDeletingProductId(null);
    }
  }
  function selectScanMode(mode: ScanMode) {
    setScanMode(mode);
    setScanError("");
    setScanPriceStatus("");
    setScanPriceError(false);
    setScanTcgplayerLink("");
  }
  function recordScan(product: Product, action: string) {
    setScanLog((current) =>
      [
        {
          id: crypto.randomUUID(),
          productName: product.name,
          sku: product.sku,
          action,
          time: new Date().toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
          }),
        },
        ...current,
      ].slice(0, 8),
    );
  }
  async function syncProductPrice(product: Product, tcgplayerId?: number) {
    setScanPriceStatus("Checking the latest TCGplayer market price…");
    setScanPriceError(false);
    try {
      const response = await fetch("/api/prices/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: product.id, tcgplayerId }),
      });
      const data = (await response.json()) as {
        product?: Product;
        match?: { matchedName?: string };
        error?: string;
      };
      if (!response.ok || !data.product)
        throw new Error(data.error || "TCGplayer price refresh failed");
      const updated = data.product;
      setProducts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setScanResult(updated);
      setScanTcgplayerLink("");
      setScanPriceStatus(
        `TCGplayer market updated to ${dollars(updated.marketPriceCents)}${data.match?.matchedName ? ` · ${data.match.matchedName}` : ""}`,
      );
      return updated;
    } catch (caught) {
      setScanPriceError(true);
      setScanPriceStatus(
        caught instanceof Error
          ? caught.message
          : "TCGplayer price refresh failed",
      );
      return product;
    }
  }
  async function handleScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = scanValue.trim();
    if (!value || scanBusy) return;
    setScanBusy(true);
    setScanError("");
    setScanPriceStatus("");
    setScanPriceError(false);
    try {
      const product = products.find((item) => matchesSkuOrBarcode(item, value));
      if (!product)
        throw new Error(`No product found for “${scanValue.trim()}”`);
      if (scanMode === "lookup") {
        setScanResult(product);
        const priced = await syncProductPrice(product);
        recordScan(priced, "Looked up + priced");
      } else if (scanMode === "checkout") {
        const inCart =
          cart.find((item) => item.productId === product.id)?.quantity || 0;
        if (product.quantity <= inCart)
          throw new Error(`${product.name} has no more available stock`);
        setScanResult(product);
        const priced = await syncProductPrice(product);
        addProduct(priced);
        recordScan(priced, "Priced + added to checkout");
        notify(`${product.name} added to sale`);
      } else {
        if (scanMode === "remove" && product.quantity <= 0)
          throw new Error(`${product.name} is already out of stock`);
        const delta = scanMode === "receive" ? 1 : -1;
        await inventoryAction({
          action: "adjust",
          id: product.id,
          delta,
          reason:
            scanMode === "receive" ? "scanner receive" : "scanner removal",
        });
        const updated = {
          ...product,
          quantity: Math.max(0, product.quantity + delta),
        };
        setProducts((current) =>
          current.map((item) => (item.id === product.id ? updated : item)),
        );
        setScanResult(updated);
        recordScan(
          updated,
          scanMode === "receive" ? "Received +1" : "Removed −1",
        );
        notify(`${product.name}: ${delta > 0 ? "+1" : "−1"}`);
      }
    } catch (caught) {
      setScanResult(null);
      setScanError(caught instanceof Error ? caught.message : "Scan failed");
    } finally {
      setScanValue("");
      setScanBusy(false);
      window.setTimeout(() => scannerInput.current?.focus(), 0);
    }
  }

  async function importCsvText(text: string) {
    try {
      const parsed = parseInventoryCsv(text);
      await inventoryAction({ action: "import", products: parsed });
      await loadAll();
      setModal(null);
      setCsvText("");
      notify(`${parsed.length} products imported`);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "CSV import failed");
    }
  }
  async function importTcgCsv(file: File) {
    await importCsvText(await file.text());
  }

  function exportReport() {
    const incompleteProfit =
      "Incomplete - TCGplayer summary excludes product costs and marketplace fees";
    const rows = [
      "Metric,Value",
      `Revenue,${(metrics.revenue / 100).toFixed(2)}`,
      `COGS,${(metrics.cogs / 100).toFixed(2)}`,
      `Gross profit,${
        profitIncomplete
          ? incompleteProfit
          : (metrics.gross / 100).toFixed(2)
      }`,
      `Operating expenses,${(metrics.operating / 100).toFixed(2)}`,
      `Net profit,${
        profitIncomplete ? incompleteProfit : (metrics.net / 100).toFixed(2)
      }`,
      `Inventory cost,${(metrics.inventoryCost / 100).toFixed(2)}`,
      `Inventory market,${(metrics.inventoryMarket / 100).toFixed(2)}`,
    ];
    const url = URL.createObjectURL(
      new Blob([rows.join("\n")], { type: "text/csv" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `defy-store-report-${localDate()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const titles: Record<View, [string, string]> = {
    overview: [
      "Command center",
      "Revenue, profit, inventory, and store health at a glance.",
    ],
    scanner: [
      "Scanner",
      "Scan a SKU or barcode to look up, receive, remove, or sell inventory.",
    ],
    sales: ["Sales", "Every transaction and channel in one ledger."],
    inventory: [
      "Inventory",
      "Singles, sealed, pricing, cost, and stock levels.",
    ],
    expenses: [
      "Expenses",
      "Track rent, payroll, inventory buys, utilities, and overhead.",
    ],
    events: [
      "Events",
      "Measure tournament turnout, revenue, and true event profit.",
    ],
    reports: [
      "Reports",
      "Understand what is making money and what needs attention.",
    ],
  };
  const nav: Array<[View, string, string]> = [
    ["overview", "⌂", "Overview"],
    ["scanner", "⌁", "Scanner"],
    ["sales", "↗", "Sales"],
    ["inventory", "▦", "Inventory"],
    ["expenses", "↙", "Expenses"],
    ["events", "◇", "Events"],
    ["reports", "◫", "Reports"],
  ];

  function renderOverview() {
    return (
      <>
        <section className="mobile-quick-actions" aria-label="Quick actions">
          <button onClick={() => setView("scanner")}>
            <span>⌁</span>
            <strong>Scan</strong>
            <small>Find or move stock</small>
          </button>
          <button className="sale-action" onClick={openSale}>
            <span>＋</span>
            <strong>New sale</strong>
            <small>Start checkout</small>
          </button>
          <button onClick={openProduct}>
            <span>▦</span>
            <strong>Add product</strong>
            <small>SKU & label</small>
          </button>
          <button onClick={() => setModal("expense")}>
            <span>↙</span>
            <strong>Expense</strong>
            <small>Record a cost</small>
          </button>
        </section>
        <section className="kpi-grid">
          <article className="kpi hero-kpi">
            <div>
              <span>Net revenue</span>
              <b className="status-dot">Live</b>
            </div>
            <strong>{dollars(metrics.revenue)}</strong>
            <footer>
              <span>{metrics.orders} sales</span>
              <span>Avg {dollars(metrics.avg)}</span>
            </footer>
          </article>
          <article className="kpi">
            <div>
              <span>Gross profit</span>
              <i>GP</i>
            </div>
            <strong>
              {profitIncomplete ? "Incomplete" : dollars(metrics.gross)}
            </strong>
            <footer>
              <span>
                {profitIncomplete
                  ? "TCG costs not included"
                  : "After product cost"}
              </span>
              <em>
                {!profitIncomplete && metrics.revenue
                  ? `${((metrics.gross / metrics.revenue) * 100).toFixed(1)}% margin`
                  : "—"}
              </em>
            </footer>
          </article>
          <article
            className={`kpi ${!profitIncomplete && metrics.net < 0 ? "loss-kpi" : ""}`}
          >
            <div>
              <span>Net profit</span>
              <i>NP</i>
            </div>
            <strong>
              {profitIncomplete ? "Incomplete" : dollars(metrics.net)}
            </strong>
            <footer>
              <span>
                {profitIncomplete
                  ? "TCG costs and fees missing"
                  : "After operating expenses"}
              </span>
              <em>
                {profitIncomplete ? "—" : `${metrics.margin.toFixed(1)}%`}
              </em>
            </footer>
          </article>
          <article className="kpi">
            <div>
              <span>Inventory market</span>
              <i>▦</i>
            </div>
            <strong>{dollars(metrics.inventoryMarket)}</strong>
            <footer>
              <span>{metrics.units} units</span>
              <em>{metrics.low} low stock</em>
            </footer>
          </article>
        </section>
        {profitIncomplete && <ProfitIncompleteNotice />}
        <section className="dashboard-grid">
          <article className="panel revenue-panel">
            <header>
              <div>
                <h2>7-day cash picture</h2>
                <p>Sales revenue vs. operating expenses</p>
              </div>
              <div className="legend">
                <span>
                  <i className="green" />
                  Revenue
                </span>
                <span>
                  <i />
                  Expenses
                </span>
              </div>
            </header>
            <div className="bar-chart">
              {chartDays.map((item) => (
                <div className="bar-day" key={item.key}>
                  <div className="bar-value">
                    {item.revenue
                      ? compactMoney.format(item.revenue / 100)
                      : ""}
                  </div>
                  <div className="bars">
                    <i
                      className="revenue-bar"
                      style={{
                        height: `${Math.max(item.revenue ? 5 : 0, (item.revenue / chartMax) * 100)}%`,
                      }}
                    />
                    <i
                      className="expense-bar"
                      style={{
                        height: `${Math.max(item.expenses ? 5 : 0, (item.expenses / chartMax) * 100)}%`,
                      }}
                    />
                  </div>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </article>
          <article className="panel profit-card">
            <header>
              <div>
                <h2>Profit bridge</h2>
                <p>Where the money went</p>
              </div>
            </header>
            <div className="profit-lines">
              <div>
                <span>Revenue</span>
                <strong>{dollars(metrics.revenue)}</strong>
              </div>
              <div>
                <span>− Cost of goods</span>
                <strong>{dollars(metrics.cogs)}</strong>
              </div>
              <div>
                <span>− Operating expenses</span>
                <strong>{dollars(metrics.operating)}</strong>
              </div>
              <div className="profit-total">
                <span>= Net profit</span>
                <strong>
                  {profitIncomplete ? "Incomplete" : dollars(metrics.net)}
                </strong>
              </div>
            </div>
          </article>
        </section>
        <section className="dashboard-grid lower-grid">
          <article className="panel">
            <header>
              <div>
                <h2>Recent sales</h2>
                <p>Latest store activity</p>
              </div>
              <button className="text-action" onClick={() => setView("sales")}>
                View all →
              </button>
            </header>
            {sales.length ? (
              <div className="compact-list">
                {sales.slice(0, 5).map((sale) => (
                  <div key={sale.id}>
                    <span className="round-icon">
                      {sale.channel.slice(0, 1)}
                    </span>
                    <span>
                      <strong>{sale.saleNumber}</strong>
                      <small>
                        {sale.channel} · {sale.itemsCount}{" "}
                        {parseTcgSummaryRange(sale.saleNumber)
                          ? "orders"
                          : "items"}
                      </small>
                    </span>
                    <b>{dollars(sale.totalCents)}</b>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="No sales yet"
                copy="Record the first transaction to start your revenue dashboard."
                action={openSale}
                label="New sale"
              />
            )}
          </article>
          <article className="panel">
            <header>
              <div>
                <h2>Store pulse</h2>
                <p>Fast operational checks</p>
              </div>
            </header>
            <div className="pulse-list">
              <button onClick={() => setView("inventory")}>
                <span>
                  <i className={metrics.low ? "warn" : "good"} />
                  {metrics.low} low-stock products
                </span>
                <b>Review →</b>
              </button>
              <button onClick={() => setView("expenses")}>
                <span>
                  <i className="neutral" />
                  {filteredExpenses.length} expenses logged
                </span>
                <b>Review →</b>
              </button>
              <button onClick={() => setView("events")}>
                <span>
                  <i className="good" />
                  {
                    events.filter(
                      (item) => new Date(item.eventDate) >= new Date(),
                    ).length
                  }{" "}
                  upcoming events
                </span>
                <b>Review →</b>
              </button>
              <button onClick={() => setView("reports")}>
                <span>
                  <i
                    className={
                      !profitIncomplete && metrics.margin >= 10
                        ? "good"
                        : "warn"
                    }
                  />
                  {profitIncomplete
                    ? "Profit incomplete"
                    : `${metrics.margin.toFixed(1)}% net margin`}
                </span>
                <b>Analyze →</b>
              </button>
            </div>
          </article>
        </section>
      </>
    );
  }

  function renderScannerView() {
    const modes: Array<[ScanMode, string, string]> = [
      ["lookup", "⌕", "Lookup"],
      ["receive", "＋", "Receive +1"],
      ["remove", "−", "Remove −1"],
      ["checkout", "↗", "Checkout"],
    ];
    const checkoutUnits = cart.reduce((sum, item) => sum + item.quantity, 0);
    return (
      <>
        <section className="scanner-grid">
          <article className="panel scanner-console">
            <header>
              <div>
                <h2>USB scanner input</h2>
                <p>
                  Your scanner types the code and presses Enter automatically.
                </p>
              </div>
              <span className="armed">
                <i />
                Input armed
              </span>
            </header>
            <div className="scanner-body">
              <div
                className="scan-modes"
                role="group"
                aria-label="Scanner action"
              >
                {modes.map(([mode, icon, label]) => (
                  <button
                    key={mode}
                    className={scanMode === mode ? "active" : ""}
                    onClick={() => selectScanMode(mode)}
                  >
                    <span>{icon}</span>
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>
              <form className="scan-form" onSubmit={handleScan}>
                <label htmlFor="scanner-code">Scan SKU or barcode</label>
                <div>
                  <span className="scan-beam">⌁</span>
                  <input
                    id="scanner-code"
                    ref={scannerInput}
                    value={scanValue}
                    onChange={(event) => setScanValue(event.target.value)}
                    placeholder="Scanner ready — or type a code"
                    autoComplete="off"
                    disabled={scanBusy}
                  />
                  <button disabled={!scanValue.trim() || scanBusy}>
                    {scanBusy ? "Working…" : "Run"}
                  </button>
                </div>
                <p>
                  Current action:{" "}
                  <strong>
                    {modes.find(([mode]) => mode === scanMode)?.[2]}
                  </strong>{" "}
                  · Keep this field focused while scanning.
                </p>
              </form>
            </div>
          </article>
          <article
            className={`panel scan-result ${scanError ? "scan-failed" : ""}`}
          >
            <header>
              <div>
                <h2>Last scan</h2>
                <p>Matched by custom SKU or product barcode</p>
              </div>
              {scanResult && (
                <span className={`tag ${scanResult.productType.toLowerCase()}`}>
                  {scanResult.productType}
                </span>
              )}
            </header>
            {scanError ? (
              <div className="scan-message">
                <span>!</span>
                <strong>Not found</strong>
                <p>{scanError}</p>
                <button className="secondary-button" onClick={openProduct}>
                  ＋ Add product
                </button>
              </div>
            ) : scanResult ? (
              <div className="scanned-product">
                <div className="scan-product-title">
                  <ProductThumb product={scanResult} />
                  <div>
                    <strong>{scanResult.name}</strong>
                    <small>
                      {[
                        scanResult.setName,
                        scanResult.cardNumber,
                        scanResult.condition,
                        scanResult.finish,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </div>
                </div>
                <div className="scan-facts">
                  <span>
                    <small>SKU</small>
                    <strong>{scanResult.sku}</strong>
                  </span>
                  <span>
                    <small>Stock</small>
                    <strong
                      className={
                        scanResult.quantity <= scanResult.lowStockThreshold
                          ? "warning"
                          : ""
                      }
                    >
                      {scanResult.quantity}
                    </strong>
                  </span>
                  <span>
                    <small>Sticker price</small>
                    <strong>
                      {dollars(
                        scanResult.listPriceCents ||
                          scanResult.marketPriceCents,
                      )}
                    </strong>
                  </span>
                  <span>
                    <small>TCG market</small>
                    <strong>
                      {scanResult.marketPriceCents
                        ? dollars(scanResult.marketPriceCents)
                        : "—"}
                    </strong>
                  </span>
                  <span>
                    <small>Location</small>
                    <strong>{scanResult.location || "UNASSIGNED"}</strong>
                  </span>
                  <span>
                    <small>Price source</small>
                    <strong>
                      {scanResult.priceSource === "tcgplayer-daily"
                        ? "TCGplayer daily"
                        : "Manual / CSV"}
                    </strong>
                  </span>
                </div>
                <div
                  className={`price-sync-status ${scanPriceError ? "failed" : ""}`}
                >
                  <span>
                    <i />
                    {scanPriceStatus ||
                      `Market price ${scanResult.priceUpdatedAt ? "last updated " + new Date(scanResult.priceUpdatedAt).toLocaleString() : "has not synced yet"}`}
                  </span>
                  {scanPriceError && (
                    <label className="tcg-link-field">
                      <span>TCGplayer product ID</span>
                      <div>
                        <input
                          inputMode="numeric"
                          placeholder="Example: 635368"
                          value={scanTcgplayerLink}
                          onChange={(event) =>
                            setScanTcgplayerLink(
                              event.target.value.replace(/\D/g, ""),
                            )
                          }
                        />
                        <button
                          disabled={scanBusy || !Number(scanTcgplayerLink)}
                          onClick={() =>
                            void syncProductPrice(
                              scanResult,
                              Number(scanTcgplayerLink),
                            )
                          }
                        >
                          Link & sync
                        </button>
                      </div>
                    </label>
                  )}
                  <div>
                    {tcgplayerProductUrl(
                      scanResult.tcgplayerId,
                      scanResult.tcgplayerUrl,
                    ) && (
                      <a
                        href={
                          tcgplayerProductUrl(
                            scanResult.tcgplayerId,
                            scanResult.tcgplayerUrl,
                          )!
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open TCGplayer ↗
                      </a>
                    )}
                    <button
                      disabled={scanBusy}
                      onClick={() => void syncProductPrice(scanResult)}
                    >
                      ↻ Sync price
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="scan-message">
                <span className="scanner-glyph">⌁</span>
                <strong>Ready for a scan</strong>
                <p>
                  Scan the Defy SKU barcode on a sleeve, top loader, or sealed
                  product. Lookup and Checkout scans now sync the latest
                  TCGplayer market price.
                </p>
              </div>
            )}
          </article>
        </section>
        <section className="scanner-lower">
          <article className="panel scan-cart">
            <header>
              <div>
                <h2>Checkout queue</h2>
                <p>
                  {checkoutUnits} units · {dollars(cartSubtotal)}
                </p>
              </div>
              <div className="header-actions">
                {cart.length > 0 && (
                  <button className="text-action" onClick={() => setCart([])}>
                    Clear
                  </button>
                )}
                <button
                  className="primary-button"
                  disabled={!cart.length}
                  onClick={() => setModal("sale")}
                >
                  Checkout & edit prices →
                </button>
              </div>
            </header>
            {cart.length ? (
              <div className="scan-cart-lines">
                {cart.map((item) => (
                  <div key={item.key}>
                    <ProductThumb
                      product={{
                        name: item.productName,
                        game: item.game,
                        imageUrl: item.imageUrl,
                      }}
                      className="mini-product-thumb"
                    />
                    <span>
                      <strong>{item.productName}</strong>
                      <small>
                        {item.sku} · Sticker {dollars(item.stickerPriceCents)}
                        {item.marketPriceCents
                          ? ` · Market ${dollars(item.marketPriceCents)}`
                          : ""}
                      </small>
                    </span>
                    <b>×{item.quantity}</b>
                    <strong>
                      {dollars(item.unitPriceCents * item.quantity)}
                    </strong>
                    <button
                      aria-label={`Remove ${item.productName} from checkout`}
                      onClick={() =>
                        setCart((current) =>
                          current.filter((line) => line.key !== item.key),
                        )
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="scan-mini-empty">
                Switch to Checkout and scan products to build a sale.
              </div>
            )}
          </article>
          <article className="panel scan-history">
            <header>
              <div>
                <h2>Recent scans</h2>
                <p>Latest activity from this device</p>
              </div>
            </header>
            {scanLog.length ? (
              <div>
                {scanLog.map((item) => (
                  <div key={item.id}>
                    <span>
                      <strong>{item.action}</strong>
                      <small>
                        {item.productName} · {item.sku}
                      </small>
                    </span>
                    <time>{item.time}</time>
                  </div>
                ))}
              </div>
            ) : (
              <div className="scan-mini-empty">
                Your latest eight scans will appear here.
              </div>
            )}
          </article>
        </section>
      </>
    );
  }

  function renderSalesView() {
    return (
      <section className="panel data-panel">
        <header>
          <div>
            <h2>Sales ledger</h2>
            <p>{visibleSales.length} transactions in this period</p>
          </div>
          <div className="header-actions">
            <button
              className="secondary-button"
              onClick={() => setModal("tcgSalesImport")}
            >
              ↑ TCGplayer file
            </button>
            <button className="primary-button" onClick={openSale}>
              ＋ New sale
            </button>
          </div>
        </header>
        {visibleSales.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>Date</th>
                  <th>Channel</th>
                  <th>Payment</th>
                  <th>Items</th>
                  <th>Revenue</th>
                  <th>COGS</th>
                  <th>Gross profit</th>
                </tr>
              </thead>
              <tbody>
                {visibleSales.map((sale) => {
                  const isSummary = Boolean(
                    parseTcgSummaryRange(sale.saleNumber),
                  );
                  return (
                    <tr key={sale.id}>
                      <td>
                        <strong>{sale.saleNumber}</strong>
                        <small>{sale.note || "Transaction"}</small>
                      </td>
                      <td>{day(sale.soldAt)}</td>
                      <td>
                        <span className="tag">{sale.channel}</span>
                      </td>
                      <td>{sale.paymentMethod}</td>
                      <td>
                        {sale.itemsCount}
                        {isSummary ? " orders" : ""}
                      </td>
                      <td>
                        <strong>
                          {dollars(sale.subtotalCents - sale.discountCents)}
                        </strong>
                      </td>
                      <td>
                        {isSummary
                          ? "Not provided"
                          : dollars(sale.cogsCents)}
                      </td>
                      <td className={isSummary ? "" : "positive"}>
                        {isSummary
                          ? "Incomplete"
                          : dollars(
                              sale.subtotalCents -
                                sale.discountCents -
                                sale.cogsCents,
                            )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No sales in this period"
            copy="Record in-store, online, event, membership, or custom revenue."
            action={openSale}
            label="Record a sale"
          />
        )}
      </section>
    );
  }

  function renderInventoryView() {
    return (
      <section className="panel data-panel">
        <header>
          <div>
            <h2>Stock catalog</h2>
            <p>
              {products.length} products · {metrics.units} units · Click any
              quantity or price to edit ·{" "}
              <span className="sheet-sync-status">{sheetSyncStatus}</span>
            </p>
          </div>
          <div className="header-actions">
            <button
              className="secondary-button sheet-sync-button"
              disabled={sheetSyncing}
              onClick={() => void syncMasterSheet(true)}
            >
              {sheetSyncing ? "Syncing…" : "↻ Sync sheet"}
            </button>
            <input
              ref={fileInput}
              hidden
              type="file"
              accept=".csv,text/csv"
              onChange={(event) =>
                event.target.files?.[0] &&
                void importTcgCsv(event.target.files[0])
              }
            />
            <button
              className="secondary-button"
              onClick={() => fileInput.current?.click()}
            >
              ↑ Inventory CSV
            </button>
            <button
              className="secondary-button"
              onClick={() => setModal("import")}
            >
              Paste CSV
            </button>
            <button className="dark-button" onClick={openProduct}>
              ＋ Product
            </button>
          </div>
        </header>
        <fieldset className="inventory-game-filter">
          <legend className="sr-only">Filter inventory by game</legend>
          <div className="inventory-game-filter-scroll">
            {["All" as const, ...TCG_GAME_OPTIONS.map((option) => option.name)].map((game) => (
              <label key={game}>
                <input
                  type="radio"
                  name="inventory-game"
                  value={game}
                  checked={inventoryGame === game}
                  onChange={() => setInventoryGame(game)}
                />
                <span>{game} <b>{inventoryGameCounts.get(game) || 0}</b></span>
              </label>
            ))}
          </div>
        </fieldset>
        {visibleProducts.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Type</th>
                  <th>Stock</th>
                  <th>Unit cost</th>
                  <th>Market</th>
                  <th>List price</th>
                  <th>Location</th>
                  <th>Margin</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => (
                  <tr key={product.id}>
                    <td>
                      <div className="product-name">
                        <ProductThumb product={product} />
                        <div>
                          <strong>{product.name}</strong>
                          <small className="product-subtitle">
                            <span className="game-pill">{canonicalizeGame(product.game)}</span>
                            <span>{product.sku} ·{" "}
                            {[product.setName, product.condition]
                              .filter(Boolean)
                              .join(" · ")}</span>
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`tag ${product.productType.toLowerCase()}`}
                      >
                        {product.productType}
                      </span>
                    </td>
                    <td
                      className={
                        product.quantity <= product.lowStockThreshold
                          ? "warning"
                          : ""
                      }
                    >
                      <EditableNumber
                        key={`stock-${product.id}-${product.quantity}`}
                        label={`Stock for ${product.name}`}
                        value={product.quantity}
                        onCommit={(quantity) => setStock(product, quantity)}
                      />
                    </td>
                    <td>
                      <EditableNumber
                        key={`cost-${product.id}-${product.costCents}`}
                        label={`Unit cost for ${product.name}`}
                        value={product.costCents}
                        money
                        onCommit={(costCents) =>
                          updateProductValue(product, { costCents })
                        }
                      />
                    </td>
                    <td>
                      <EditableNumber
                        key={`market-${product.id}-${product.marketPriceCents}`}
                        label={`Market price for ${product.name}`}
                        value={product.marketPriceCents}
                        money
                        onCommit={(marketPriceCents) =>
                          updateProductValue(product, { marketPriceCents })
                        }
                      />
                    </td>
                    <td>
                      <EditableNumber
                        key={`list-${product.id}-${product.listPriceCents}`}
                        label={`List price for ${product.name}`}
                        value={product.listPriceCents}
                        money
                        onCommit={(listPriceCents) =>
                          updateProductValue(product, { listPriceCents })
                        }
                      />
                    </td>
                    <td>
                      <code>{product.location}</code>
                    </td>
                    <td>
                      {product.listPriceCents
                        ? `${(((product.listPriceCents - product.costCents) / product.listPriceCents) * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td>
                      <div className="catalog-actions">
                        <div className="stepper">
                          <button
                            aria-label={`Remove one ${product.name} from stock`}
                            onClick={() => adjustStock(product, -1)}
                          >
                            −
                          </button>
                          <button
                            aria-label={`Add one ${product.name} to stock`}
                            onClick={() => adjustStock(product, 1)}
                          >
                            ＋
                          </button>
                        </div>
                        <button
                          className="label-button"
                          aria-label={`Create label for ${product.name}`}
                          onClick={() => openLabel(product)}
                        >
                          Label
                        </button>
                        <button
                          className="label-button"
                          aria-label={`Fix picture for ${product.name}`}
                          onClick={() => openImageLink(product)}
                        >
                          Picture
                        </button>
                        <button
                          className="delete-product"
                          aria-label={`Delete ${product.name} from catalog`}
                          disabled={deletingProductId === product.id}
                          onClick={() => void deleteProduct(product)}
                        >
                          {deletingProductId === product.id
                            ? "Removing…"
                            : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              products.length === 0
                ? "Inventory is empty"
                : (inventoryGameCounts.get(inventoryGame) || 0) === 0
                  ? `No ${inventoryGame} products yet`
                  : "No products match your search"
            }
            copy={
              products.length === 0
                ? "Import an inventory CSV or add your first single or sealed product."
                : (inventoryGameCounts.get(inventoryGame) || 0) === 0
                  ? `Add a ${inventoryGame} product or choose another game.`
                  : `No ${inventoryGame === "All" ? "inventory" : inventoryGame} SKU matches “${query}”.`
            }
            action={
              products.length > 0 && (inventoryGameCounts.get(inventoryGame) || 0) > 0
                ? () => setQuery("")
                : () => openProduct(inventoryGame === "All" ? undefined : inventoryGame)
            }
            label={
              products.length > 0 && (inventoryGameCounts.get(inventoryGame) || 0) > 0
                ? "Clear search"
                : "Add product"
            }
          />
        )}
      </section>
    );
  }

  function renderExpensesView() {
    return (
      <section className="panel data-panel">
        <header>
          <div>
            <h2>Expense ledger</h2>
            <p>
              {dollars(metrics.operating)} across {visibleExpenses.length}{" "}
              entries
            </p>
          </div>
          <button
            className="primary-button"
            onClick={() => setModal("expense")}
          >
            ＋ Add expense
          </button>
        </header>
        {visibleExpenses.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Expense</th>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Vendor</th>
                  <th>Frequency</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {visibleExpenses.map((expense) => (
                  <tr key={expense.id}>
                    <td>
                      <strong>{expense.description}</strong>
                      <small>{expense.note || "Operating expense"}</small>
                    </td>
                    <td>{day(expense.expenseDate)}</td>
                    <td>
                      <span className="tag">{expense.category}</span>
                    </td>
                    <td>{expense.vendor || "—"}</td>
                    <td>{expense.recurrence}</td>
                    <td>
                      <strong>{dollars(expense.amountCents)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No expenses logged"
            copy="Add rent, payroll, card buys, utilities, software, insurance, and other overhead."
            action={() => setModal("expense")}
            label="Add expense"
          />
        )}
      </section>
    );
  }

  function renderEventsView() {
    const eventRevenue = filteredEvents.reduce(
      (sum, item) => sum + item.entryFeeCents * item.players,
      0,
    );
    const eventProfit = filteredEvents.reduce(
      (sum, item) =>
        sum +
        item.entryFeeCents * item.players -
        item.prizeCostCents -
        item.otherCostCents,
      0,
    );
    return (
      <>
        <section className="mini-kpis">
          <article>
            <span>Event revenue</span>
            <strong>{dollars(eventRevenue)}</strong>
          </article>
          <article>
            <span>Event profit</span>
            <strong>{dollars(eventProfit)}</strong>
          </article>
          <article>
            <span>Players</span>
            <strong>
              {filteredEvents.reduce((sum, item) => sum + item.players, 0)}
            </strong>
          </article>
        </section>
        <section className="panel data-panel">
          <header>
            <div>
              <h2>Events & tournaments</h2>
              <p>Turnout and profitability by event</p>
            </div>
            <button
              className="primary-button"
              onClick={() => setModal("event")}
            >
              ＋ New event
            </button>
          </header>
          {events.length ? (
            <div className="event-grid">
              {events.map((item) => {
                const revenue = item.entryFeeCents * item.players;
                const profit =
                  revenue - item.prizeCostCents - item.otherCostCents;
                return (
                  <article key={item.id}>
                    <div className="event-top">
                      <span className="event-game">
                        {item.game.slice(0, 2).toUpperCase()}
                      </span>
                      <span
                        className={`event-status ${item.status.toLowerCase()}`}
                      >
                        {item.status}
                      </span>
                    </div>
                    <h3>{item.name}</h3>
                    <p>
                      {new Date(item.eventDate).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                    <div className="event-stats">
                      <span>
                        <small>Players</small>
                        <strong>{item.players}</strong>
                      </span>
                      <span>
                        <small>Revenue</small>
                        <strong>{dollars(revenue)}</strong>
                      </span>
                      <span>
                        <small>Profit</small>
                        <strong
                          className={profit < 0 ? "negative" : "positive"}
                        >
                          {dollars(profit)}
                        </strong>
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty
              title="No events scheduled"
              copy="Track tournaments, learn-to-play nights, leagues, and community events."
              action={() => setModal("event")}
              label="Create event"
            />
          )}
        </section>
      </>
    );
  }

  function renderReportsView() {
    return (
      <>
        {profitIncomplete && <ProfitIncompleteNotice />}
        <section className="report-summary">
          <article>
            <span>Revenue</span>
            <strong>{dollars(metrics.revenue)}</strong>
          </article>
          <i>−</i>
          <article>
            <span>COGS</span>
            <strong>{dollars(metrics.cogs)}</strong>
          </article>
          <i>−</i>
          <article>
            <span>Expenses</span>
            <strong>{dollars(metrics.operating)}</strong>
          </article>
          <i>=</i>
          <article
            className={
              profitIncomplete
                ? "report-incomplete"
                : metrics.net < 0
                  ? "report-loss"
                  : "report-profit"
            }
          >
            <span>Net profit</span>
            <strong>
              {profitIncomplete ? "Incomplete" : dollars(metrics.net)}
            </strong>
          </article>
        </section>
        <section className="dashboard-grid reports-grid">
          <article className="panel">
            <header>
              <div>
                <h2>Revenue by channel</h2>
                <p>Which sales channels are carrying the store</p>
              </div>
            </header>
            {channelMix.length ? (
              <div className="rank-list">
                {channelMix.map(([label, value]) => (
                  <div key={label}>
                    <span>
                      <strong>{label}</strong>
                      <small>
                        {metrics.revenue
                          ? `${((value / metrics.revenue) * 100).toFixed(1)}% of revenue`
                          : "0%"}
                      </small>
                    </span>
                    <div>
                      <i
                        style={{
                          width: `${metrics.revenue ? (value / metrics.revenue) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <b>{dollars(value)}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="micro-empty">
                Revenue mix appears after sales are recorded.
              </div>
            )}
          </article>
          <article className="panel">
            <header>
              <div>
                <h2>Expense mix</h2>
                <p>Operating spend by category</p>
              </div>
            </header>
            {expenseMix.length ? (
              <div className="rank-list">
                {expenseMix.map(([label, value]) => (
                  <div key={label}>
                    <span>
                      <strong>{label}</strong>
                      <small>
                        {metrics.operating
                          ? `${((value / metrics.operating) * 100).toFixed(1)}% of expenses`
                          : "0%"}
                      </small>
                    </span>
                    <div>
                      <i
                        className="expense-fill"
                        style={{
                          width: `${metrics.operating ? (value / metrics.operating) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <b>{dollars(value)}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="micro-empty">
                Expense mix appears after costs are logged.
              </div>
            )}
          </article>
        </section>
        <section className="dashboard-grid reports-grid">
          <article className="panel">
            <header>
              <div>
                <h2>Top products</h2>
                <p>Ranked by recorded sales revenue</p>
              </div>
            </header>
            {topProducts.length ? (
              <div className="top-list">
                {topProducts.map((item, index) => (
                  <div key={item.name}>
                    <span>{index + 1}</span>
                    <p>
                      <strong>{item.name}</strong>
                      <small>{item.quantity} units sold</small>
                    </p>
                    <b>{dollars(item.revenue)}</b>
                  </div>
                ))}
              </div>
            ) : (
              <div className="micro-empty">
                Product ranking appears after itemized sales.
              </div>
            )}
          </article>
          <article className="panel valuation-card">
            <header>
              <div>
                <h2>Store asset snapshot</h2>
                <p>Inventory value and potential upside</p>
              </div>
              <button className="text-action" onClick={exportReport}>
                Export CSV ↓
              </button>
            </header>
            <div>
              <span>
                <small>Inventory at cost</small>
                <strong>{dollars(metrics.inventoryCost)}</strong>
              </span>
              <span>
                <small>Inventory at market</small>
                <strong>{dollars(metrics.inventoryMarket)}</strong>
              </span>
              <span>
                <small>Unrealized inventory spread</small>
                <strong className="positive">
                  {dollars(metrics.inventoryMarket - metrics.inventoryCost)}
                </strong>
              </span>
            </div>
          </article>
        </section>
      </>
    );
  }

  const content = {
    overview: renderOverview(),
    scanner: renderScannerView(),
    sales: renderSalesView(),
    inventory: renderInventoryView(),
    expenses: renderExpensesView(),
    events: renderEventsView(),
    reports: renderReportsView(),
  }[view];
  const saleCandidates = products
    .filter(
      (item) =>
        item.quantity > 0 &&
        (!saleSearch ||
          [item.name, item.sku, item.game]
            .join(" ")
            .toLowerCase()
            .includes(saleSearch.toLowerCase())),
    )
    .slice(0, 6);
  const imagePreviewUrl = Number(imageTcgplayerId)
    ? `https://tcgplayer-cdn.tcgplayer.com/product/${Math.round(Number(imageTcgplayerId))}_in_1000x1000.jpg`
    : imageDirectUrl.trim();

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Image
            className="brand-mark"
            src="/defy-os-icon.png"
            alt=""
            width={40}
            height={40}
            priority
          />
          <span>
            <strong>defy</strong>
            <small>STORE OS</small>
          </span>
        </div>
        <nav aria-label="Store navigation">
          {nav.map(([key, icon, label]) => (
            <button
              key={key}
              className={`nav-item ${view === key ? "active" : ""}`}
              onClick={() => {
                setView(key);
                setQuery("");
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <ThemeToggle className="sidebar-theme-toggle" />
        <div className="store-health">
          <span>
            <i className={error ? "down" : ""} />
            {error ? "Needs attention" : "Systems healthy"}
          </span>
          <small>
            {products.length} products · {sales.length} sales
          </small>
        </div>
        <div className="profile">
          <span className="avatar">T</span>
          <span>
            <strong>Tan</strong>
            <small>Defy TCG · Redmond</small>
          </span>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <Image
              className="brand-mark"
              src="/defy-os-icon.png"
              alt=""
              width={40}
              height={40}
              priority
            />
            <span>
              <strong>defy</strong>
              <small>{error ? "Needs attention" : "Store online"}</small>
            </span>
          </div>
          <label className="search-box">
            <span>⌕</span>
            <input
              aria-label="Search current section"
              placeholder={`Search ${view}…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>⌘ K</kbd>
          </label>
          <label className="range-select">
            Period
            <select
              value={range}
              onChange={(event) => setRange(event.target.value)}
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
              <option value="all">All time</option>
            </select>
          </label>
          <button
            className={`secondary-button scan-shortcut ${view === "scanner" ? "active" : ""}`}
            onClick={() => setView("scanner")}
          >
            ⌁ Scan
          </button>
          <button
            className="secondary-button quick-expense"
            onClick={() => setModal("expense")}
          >
            ＋ Expense
          </button>
          <button className="primary-button topbar-sale" onClick={openSale}>
            ＋ New sale
          </button>
          <ThemeToggle className="mobile-theme-toggle" />
          <button
            className="mobile-refresh"
            aria-label="Refresh store data"
            onClick={loadAll}
          >
            ↻
          </button>
        </header>
        <div className="content">
          <div className="title-row">
            <div>
              <p className="eyebrow">DEFY TCG · BUY • SELL • TRADE • PLAY</p>
              <h1>{titles[view][0]}</h1>
              <p>{titles[view][1]}</p>
            </div>
            <button className="refresh-button" onClick={loadAll}>
              ↻ Refresh
            </button>
          </div>
          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button onClick={loadAll}>Retry</button>
            </div>
          )}
          {loading ? (
            <div className="loading">
              <i />
              Loading Defy Store OS…
            </div>
          ) : (
            content
          )}
        </div>
      </section>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {(
          [
            ["overview", "⌂", "Home"],
            ["scanner", "⌁", "Scan"],
            ["sales", "↗", "Sales"],
            ["inventory", "▦", "Stock"],
          ] as Array<[View, string, string]>
        ).map(([key, icon, label]) => (
          <button
            key={key}
            className={view === key ? "active" : ""}
            onClick={() => {
              setView(key);
              setQuery("");
              setMoreOpen(false);
            }}
          >
            <span>{icon}</span>
            <small>{label}</small>
          </button>
        ))}
        <button
          className={
            moreOpen ||
            (["expenses", "events", "reports"] as View[]).includes(view)
              ? "active"
              : ""
          }
          onClick={() => setMoreOpen(true)}
        >
          <span>•••</span>
          <small>More</small>
        </button>
      </nav>
      {moreOpen && (
        <div
          className="mobile-more-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setMoreOpen(false)
          }
        >
          <section className="mobile-more-sheet" aria-label="More sections">
            <div className="sheet-handle" />
            <header>
              <div>
                <p className="eyebrow">DEFY STORE OS</p>
                <h2>More</h2>
              </div>
              <button onClick={() => setMoreOpen(false)}>×</button>
            </header>
            <div>
              {(
                [
                  ["expenses", "↙", "Expenses", "Costs & overhead"],
                  ["events", "◇", "Events", "Tournaments & turnout"],
                  ["reports", "◫", "Reports", "Profit & performance"],
                ] as Array<[View, string, string, string]>
              ).map(([key, icon, label, copy]) => (
                <button
                  key={key}
                  onClick={() => {
                    setView(key);
                    setQuery("");
                    setMoreOpen(false);
                  }}
                >
                  <span>{icon}</span>
                  <p>
                    <strong>{label}</strong>
                    <small>{copy}</small>
                  </p>
                  <b>›</b>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget &&
            modal !== "tcgSalesImport" &&
            setModal(null)
          }
        >
          {modal === "tcgSalesImport" && (
            <TcgplayerSalesImportModal
              onClose={() => setModal(null)}
              onComplete={async (result: TcgplayerImportResult) => {
                await loadAll();
                setRange("all");
                setView("sales");
                setModal(null);
                notify(
                  result.aggregateSummary
                    ? `${result.reportedOrders} TCGplayer orders summarized`
                    : `${result.importedOrders} TCGplayer order${result.importedOrders === 1 ? "" : "s"} imported`,
                );
              }}
            />
          )}
          {modal === "sale" && (
            <section
              className="modal sale-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="sale-title"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">POINT OF SALE</p>
                <h2 id="sale-title">Checkout</h2>
                <p>
                  Confirm each item, then change the charge price if you need to
                  match the market, honor a deal, or correct a sticker.
                </p>
              </div>
              <form onSubmit={createSale}>
                <div className="sale-builder">
                  <div className="product-picker">
                    <label>
                      Find inventory
                      <input
                        placeholder="Search product or scan SKU"
                        value={saleSearch}
                        onChange={(event) => setSaleSearch(event.target.value)}
                        autoFocus
                      />
                    </label>
                    <div className="picker-results">
                      {saleCandidates.map((product) => (
                        <button
                          type="button"
                          key={product.id}
                          onClick={() => addProduct(product)}
                        >
                          <ProductThumb
                            product={product}
                            className="picker-product-thumb"
                          />
                          <span>
                            <strong>{product.name}</strong>
                            <small>
                              {product.sku} · {product.quantity} in stock ·
                              Market {dollars(product.marketPriceCents)}
                            </small>
                          </span>
                          <b>
                            {dollars(
                              product.listPriceCents ||
                                product.marketPriceCents,
                            )}{" "}
                            ＋
                          </b>
                        </button>
                      ))}
                    </div>
                    <div className="custom-line">
                      <p>Custom line</p>
                      <input
                        placeholder="Membership, snack, entry fee…"
                        value={customName}
                        onChange={(event) => setCustomName(event.target.value)}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Price"
                        value={customPrice}
                        onChange={(event) => setCustomPrice(event.target.value)}
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Cost"
                        value={customCost}
                        onChange={(event) => setCustomCost(event.target.value)}
                      />
                      <button type="button" onClick={addCustom}>
                        Add
                      </button>
                    </div>
                  </div>
                  <div className="cart">
                    <h3>
                      Sale items{" "}
                      <span>
                        {cart.reduce((sum, item) => sum + item.quantity, 0)}
                      </span>
                    </h3>
                    {cart.length ? (
                      <>
                        <div className="cart-column-heads">
                          <span>Item / reference</span>
                          <span>Qty</span>
                          <span>Charge price</span>
                          <span />
                        </div>
                        {cart.map((item) => {
                          const adjusted =
                            item.unitPriceCents !== item.stickerPriceCents;
                          return (
                            <div
                              className={`cart-line ${adjusted ? "price-overridden" : ""}`}
                              key={item.key}
                            >
                              <span className="cart-item">
                                <ProductThumb
                                  product={{
                                    name: item.productName,
                                    game: item.game,
                                    imageUrl: item.imageUrl,
                                  }}
                                  className="cart-product-thumb"
                                />
                                <span className="cart-item-copy">
                                  <strong>{item.productName}</strong>
                                  <small>{item.sku || "Custom item"}</small>
                                  {item.productId && (
                                    <small className="price-reference">
                                      Sticker {dollars(item.stickerPriceCents)}{" "}
                                      · TCG market{" "}
                                      {item.marketPriceCents
                                        ? dollars(item.marketPriceCents)
                                        : "—"}
                                    </small>
                                  )}
                                </span>
                              </span>
                              <input
                                aria-label={`Quantity for ${item.productName}`}
                                type="number"
                                min="1"
                                max={item.stock || 9999}
                                value={item.quantity}
                                onChange={(event) =>
                                  updateCart(
                                    item.key,
                                    "quantity",
                                    Number(event.target.value),
                                  )
                                }
                              />
                              <div className="checkout-price">
                                <label>
                                  <span>$</span>
                                  <input
                                    aria-label={`Charge price for ${item.productName}`}
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    inputMode="decimal"
                                    value={(item.unitPriceCents / 100).toFixed(
                                      2,
                                    )}
                                    onFocus={(event) =>
                                      event.currentTarget.select()
                                    }
                                    onChange={(event) =>
                                      updateCart(
                                        item.key,
                                        "unitPriceCents",
                                        Number(event.target.value) * 100,
                                      )
                                    }
                                  />
                                </label>
                                {adjusted && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateCart(
                                        item.key,
                                        "unitPriceCents",
                                        item.stickerPriceCents,
                                      )
                                    }
                                  >
                                    Reset to sticker
                                  </button>
                                )}
                              </div>
                              <button
                                type="button"
                                aria-label={`Remove ${item.productName}`}
                                onClick={() =>
                                  setCart((current) =>
                                    current.filter(
                                      (line) => line.key !== item.key,
                                    ),
                                  )
                                }
                              >
                                ×
                              </button>
                              {adjusted && (
                                <span className="override-chip">
                                  Price override{" "}
                                  {item.unitPriceCents > item.stickerPriceCents
                                    ? "+"
                                    : ""}
                                  {dollars(
                                    item.unitPriceCents -
                                      item.stickerPriceCents,
                                  )}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div className="cart-empty">
                        Add products or a custom line to begin.
                      </div>
                    )}
                    <div className="cart-totals">
                      <span>
                        Sticker total{" "}
                        <strong>{dollars(cartStickerTotal)}</strong>
                      </span>
                      {cartPriceAdjustment !== 0 && (
                        <span className="price-change">
                          Price adjustments{" "}
                          <strong>
                            {cartPriceAdjustment > 0 ? "+" : ""}
                            {dollars(cartPriceAdjustment)}
                          </strong>
                        </span>
                      )}
                      <span>
                        Charge subtotal <strong>{dollars(cartSubtotal)}</strong>
                      </span>
                      <span>
                        Product cost <strong>{dollars(cartCogs)}</strong>
                      </span>
                      <span>
                        Gross profit{" "}
                        <strong
                          className={
                            cartSubtotal - cartCogs < 0
                              ? "negative"
                              : "positive"
                          }
                        >
                          {dollars(cartSubtotal - cartCogs)}
                        </strong>
                      </span>
                    </div>
                  </div>
                </div>
                <div className="checkout-fields">
                  <label>
                    Channel
                    <select name="channel">
                      <option>In-store</option>
                      <option>TCGplayer</option>
                      <option>Online store</option>
                      <option>Event</option>
                      <option>Membership</option>
                      <option>Other</option>
                    </select>
                  </label>
                  <label>
                    Payment
                    <select name="paymentMethod">
                      <option>Card</option>
                      <option>Cash</option>
                      <option>Online</option>
                      <option>Store credit</option>
                      <option>Other</option>
                    </select>
                  </label>
                  <label>
                    Date & time
                    <input
                      name="soldAt"
                      type="datetime-local"
                      defaultValue={localDateTime()}
                    />
                  </label>
                  <label>
                    Discount
                    <input
                      name="discount"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                    />
                  </label>
                  <label>
                    Sales tax
                    <input
                      name="tax"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                    />
                  </label>
                  <label>
                    Note
                    <input
                      name="note"
                      placeholder="Optional note — price changes log automatically"
                    />
                  </label>
                </div>
                <div className="modal-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button className="primary-button" disabled={!cart.length}>
                    Complete sale · {dollars(cartSubtotal)}
                  </button>
                </div>
              </form>
            </section>
          )}
          {modal === "expense" && (
            <section
              className="modal form-modal"
              role="dialog"
              aria-modal="true"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">MONEY OUT</p>
                <h2>Add an expense</h2>
                <p>Log operating costs so net profit stays real.</p>
              </div>
              <form className="form-grid" onSubmit={createExpense}>
                <label className="wide">
                  Description
                  <input
                    required
                    name="description"
                    placeholder="August rent, payroll, card collection buy…"
                  />
                </label>
                <label>
                  Category
                  <select name="category">
                    <option>Inventory purchase</option>
                    <option>Rent & CAM</option>
                    <option>Payroll</option>
                    <option>Utilities</option>
                    <option>Insurance</option>
                    <option>Software</option>
                    <option>Marketing</option>
                    <option>Supplies</option>
                    <option>Fees</option>
                    <option>Other</option>
                  </select>
                </label>
                <label>
                  Vendor
                  <input name="vendor" placeholder="Landlord, distributor…" />
                </label>
                <label>
                  Amount
                  <input
                    required
                    name="amount"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Date
                  <input
                    required
                    name="expenseDate"
                    type="date"
                    defaultValue={localDate()}
                  />
                </label>
                <label>
                  Frequency
                  <select name="recurrence">
                    <option>One-time</option>
                    <option>Monthly</option>
                    <option>Weekly</option>
                    <option>Annual</option>
                  </select>
                </label>
                <label className="wide">
                  Note
                  <input name="note" placeholder="Optional details" />
                </label>
                <div className="modal-actions wide">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button className="dark-button">Save expense</button>
                </div>
              </form>
            </section>
          )}
          {modal === "event" && (
            <section
              className="modal form-modal"
              role="dialog"
              aria-modal="true"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">PLAY AT DEFY</p>
                <h2>Create an event</h2>
                <p>
                  Track turnout, prize cost, revenue, and true event profit.
                </p>
              </div>
              <form className="form-grid" onSubmit={createEvent}>
                <label className="wide">
                  Event name
                  <input
                    required
                    name="name"
                    placeholder="Friday Night Riftbound"
                  />
                </label>
                <label>
                  Game
                  <select
                    name="game"
                    value={productGame}
                    onChange={(event) => {
                      const game = canonicalizeGame(event.target.value);
                      setProductGame(game);
                      if (productSkuManaged) setProductSku(nextSku(game, productTcgplayerId));
                    }}
                  >
                    {TCG_GAME_OPTIONS.map((option) => (
                      <option key={option.name} value={option.name}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select name="status">
                    <option>Scheduled</option>
                    <option>Completed</option>
                    <option>Cancelled</option>
                  </select>
                </label>
                <label className="wide">
                  Date & time
                  <input
                    required
                    name="eventDate"
                    type="datetime-local"
                    defaultValue={localDateTime()}
                  />
                </label>
                <label>
                  Entry fee
                  <input
                    name="entryFee"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="10.00"
                  />
                </label>
                <label>
                  Players
                  <input
                    name="players"
                    type="number"
                    min="0"
                    defaultValue="0"
                  />
                </label>
                <label>
                  Prize cost
                  <input
                    name="prizeCost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Other cost
                  <input
                    name="otherCost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </label>
                <label className="wide">
                  Note
                  <input name="note" placeholder="Format, rounds, capacity…" />
                </label>
                <div className="modal-actions wide">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button className="dark-button">Save event</button>
                </div>
              </form>
            </section>
          )}
          {modal === "import" && (
            <section
              className="modal form-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="import-title"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">INVENTORY IMPORT</p>
                <h2 id="import-title">Paste product CSV</h2>
                <p>
                  Paste CSV rows with product name, SKU, quantity, pricing, and
                  optional unit cost. Matching SKUs update instead of
                  duplicating.
                </p>
              </div>
              <label className="csv-paste-label">
                CSV contents
                <textarea
                  aria-label="CSV contents"
                  value={csvText}
                  onChange={(event) => setCsvText(event.target.value)}
                  placeholder="SKU,Product Name,Quantity,Unit Cost,Market Price,Price…"
                  autoFocus
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="dark-button"
                  disabled={!csvText.trim()}
                  onClick={() => void importCsvText(csvText)}
                >
                  Import CSV
                </button>
              </div>
            </section>
          )}
          {modal === "product" && (
            <section
              className="modal form-modal product-modal"
              role="dialog"
              aria-modal="true"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">INVENTORY</p>
                <h2>Add a product</h2>
                <p>
                  Each card variation gets its own unique Defy SKU. After
                  saving, its price label is ready to print.
                </p>
              </div>
              <form className="form-grid" onSubmit={createProduct}>
                <label className="wide">
                  Product name
                  <input
                    required
                    name="name"
                    placeholder="Card or sealed product"
                  />
                </label>
                <label>
                  Type
                  <select name="productType">
                    <option>Single</option>
                    <option>Sealed</option>
                  </select>
                </label>
                <label>
                  Game
                  <select name="game">
                    <option>Pokémon</option>
                    <option>One Piece</option>
                    <option>Magic</option>
                    <option>Riftbound</option>
                    <option>Lorcana</option>
                    <option>Gundam</option>
                    <option>Dragon Ball</option>
                    <option>Other</option>
                  </select>
                </label>
                <label>
                  Set
                  <input name="setName" placeholder="Set name" />
                </label>
                <label>
                  Card number
                  <input name="cardNumber" placeholder="223/197" />
                </label>
                <label>
                  Condition
                  <select name="condition">
                    <option value="">N/A</option>
                    <option>Near Mint</option>
                    <option>Lightly Played</option>
                    <option>Moderately Played</option>
                    <option>Damaged</option>
                  </select>
                </label>
                <label>
                  Finish
                  <select name="finish">
                    <option value="">Normal</option>
                    <option>Foil</option>
                    <option>Holofoil</option>
                    <option>Reverse Holofoil</option>
                  </select>
                </label>
                <label className="sku-field">
                  SKU
                  <div>
                    <input
                      required
                      name="sku"
                      value={productSku}
                      onChange={(event) => {
                        setProductSkuManaged(false);
                        setProductSku(
                          event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9 .-]/g, "-"),
                        );
                      }}
                      placeholder="DEFY-PKM-000001"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setProductSkuManaged(true);
                        setProductSku(nextSku());
                      }}
                    >
                      Generate
                    </button>
                  </div>
                  <small>{productSkuManaged ? "Auto-managed — changes with Game or TCGplayer ID" : "Custom SKU — Defy will never overwrite it"}</small>
                </label>
                <label>
                  UPC / barcode
                  <input name="barcode" placeholder="Sealed UPC (optional)" />
                </label>
                <label>
                  TCGplayer ID
                  <input
                    name="tcgplayerId"
                    inputMode="numeric"
                    placeholder="509980"
                    value={productTcgplayerId}
                    onChange={(event) => {
                      const value = event.target.value.replace(/\D/g, "");
                      setProductTcgplayerId(value);
                      if (productSkuManaged) setProductSku(nextSku(productGame, value));
                    }}
                  />
                </label>
                <label className="wide">
                  Exact product image URL
                  <input
                    name="imageUrl"
                    type="url"
                    inputMode="url"
                    placeholder="Optional when the TCGplayer ID or exact catalog name is available"
                    value={productImageUrl}
                    onChange={(event) => setProductImageUrl(event.target.value)}
                  />
                  <small>
                    Defy auto-matches only one exact catalog result. Paste the
                    product image when a catalog match is unavailable.
                  </small>
                </label>
                <label>
                  Location
                  <input name="location" placeholder="CASE-A1" />
                </label>
                <label>
                  Quantity
                  <input
                    name="quantity"
                    type="number"
                    min="0"
                    defaultValue="1"
                  />
                </label>
                <label>
                  Low-stock alert
                  <input
                    name="lowStockThreshold"
                    type="number"
                    min="0"
                    defaultValue="2"
                  />
                </label>
                <label>
                  Unit cost
                  <input
                    name="cost"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </label>
                <label>
                  Market price
                  <input
                    name="market"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </label>
                <label className="wide">
                  List price shown on label
                  <input
                    name="list"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                  />
                </label>
                <div className="modal-actions wide">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button className="dark-button">Add & create label</button>
                </div>
              </form>
            </section>
          )}
          {modal === "image" && imageProduct && (
            <section
              className="modal form-modal product-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="image-title"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">PRODUCT PICTURE</p>
                <h2 id="image-title">Fix exact picture</h2>
                <p>{imageProduct.name}</p>
              </div>
              <form className="form-grid" onSubmit={linkProductImage}>
                <label>
                  TCGplayer ID
                  <input
                    inputMode="numeric"
                    placeholder="Example: 635368"
                    value={imageTcgplayerId}
                    onChange={(event) => {
                      setImageTcgplayerId(event.target.value.replace(/\D/g, ""));
                      if (event.target.value) setImageDirectUrl("");
                    }}
                  />
                </label>
                <label className="wide">
                  Exact product image URL
                  <input
                    type="url"
                    inputMode="url"
                    placeholder="https://…/exact-product-image.jpg"
                    value={imageDirectUrl}
                    onChange={(event) => {
                      setImageDirectUrl(event.target.value);
                      if (event.target.value) setImageTcgplayerId("");
                    }}
                  />
                </label>
                {imagePreviewUrl && (
                  <div className="image-link-preview wide">
                    <Image
                      src={imagePreviewUrl}
                      alt={`Preview for ${imageProduct.name}`}
                      width={180}
                      height={180}
                      unoptimized
                    />
                    <span>Confirm this is the exact product before saving.</span>
                  </div>
                )}
                <div className="modal-actions wide">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setModal(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="dark-button"
                    disabled={!Number(imageTcgplayerId) && !imageDirectUrl.trim()}
                  >
                    Save exact picture
                  </button>
                </div>
              </form>
            </section>
          )}
          {modal === "label" && labelProduct && (
            <section
              className="modal label-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="label-title"
            >
              <button className="modal-close" onClick={() => setModal(null)}>
                ×
              </button>
              <div className="modal-heading">
                <p className="eyebrow">READY FOR SUPVAN T50M PRO</p>
                <h2 id="label-title">Print price label</h2>
                <p>
                  The barcode contains this product’s exact Defy SKU. Your
                  scanner will pull up the matching inventory item.
                </p>
              </div>
              <div className="label-workspace">
                <div
                  className={`label-preview ${labelSize === "40x30" ? "compact-label" : ""}`.trim()}
                >
                  <div className="label-brand">
                    <b>DEFY TCG</b>
                    <strong>
                      {dollars(
                        Math.max(
                          0,
                          Math.round((Number(labelPrice) || 0) * 100),
                        ),
                      )}
                    </strong>
                  </div>
                  <h3>{labelProduct.name}</h3>
                  <p>
                    {[
                      labelProduct.setName,
                      labelProduct.cardNumber,
                      labelProduct.condition,
                      labelProduct.finish,
                    ]
                      .filter(Boolean)
                      .join(" · ") || labelProduct.game}
                  </p>
                  <Barcode value={labelProduct.sku} />
                  <code>{labelProduct.sku}</code>
                </div>
                <div className="label-settings">
                  <span>Label controls</span>
                  <label>
                    Label size
                    <select
                      value={labelSize}
                      onChange={(event) =>
                        setLabelSize(event.target.value as "50x30" | "40x30")
                      }
                    >
                      <option value="50x30">50 × 30 mm</option>
                      <option value="40x30">40 × 30 mm</option>
                    </select>
                  </label>
                  <label>
                    Printed price ($)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={labelPrice}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setLabelPrice(event.target.value)}
                    />
                  </label>
                  <label>
                    Copies
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={labelCopies}
                      onChange={(event) =>
                        setLabelCopies(
                          Math.max(
                            1,
                            Math.min(100, Number(event.target.value) || 1),
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(labelProduct.sku);
                      notify("SKU copied");
                    }}
                  >
                    Copy SKU
                  </button>
                </div>
              </div>
              <div className="label-help">
                <strong>Printer setup</strong>
                <p>
                  Choose the T50M Pro in your device’s print dialog and use{" "}
                  {labelSize === "40x30" ? "40 × 30" : "50 × 30"} mm paper at
                  100% scale. If your tablet does not show the printer, copy the
                  SKU into the SUPVAN app and choose a Code 39 barcode.
                </p>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setModal(null)}
                >
                  Done
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => printLabels(labelProduct)}
                >
                  Print {labelCopies} label{labelCopies === 1 ? "" : "s"}
                </button>
              </div>
            </section>
          )}
        </div>
      )}
      {toast && (
        <div className="toast">
          <span>✓</span>
          {toast}
        </div>
      )}
    </main>
  );
}