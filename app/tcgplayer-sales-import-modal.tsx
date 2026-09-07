"use client";

import { DragEvent, useRef, useState } from "react";
import { readTcgplayerSalesFile } from "@/lib/tcgplayer-sales-file";

type PreviewItem = {
  productName: string;
  quantity: number;
  lineTotalCents: number;
  productId: number | null;
  matchedName: string;
  defySku: string;
  matchIssue: string;
  stockDeduction: number;
  shortageQuantity: number;
};

type PreviewOrder = {
  orderNumber: string;
  saleNumber: string;
  soldAt: string;
  status: string;
  duplicate: boolean;
  isCanceled: boolean;
  isPending: boolean;
  isAggregateSummary: boolean;
  reportedOrderCount: number;
  reportedRefundCount: number;
  reportStartDate: string;
  reportEndDate: string;
  skipped: boolean;
  skipReason: string;
  productSubtotalCents: number;
  shippingCents: number;
  discountCents: number;
  feesCents: number;
  netCents: number | null;
  items: PreviewItem[];
};

type ImportPreview = {
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
  orders: PreviewOrder[];
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

type Props = {
  onClose: () => void;
  onComplete: (result: TcgplayerImportResult) => void | Promise<void>;
};

type Filter = "all" | "ready" | "attention" | "skipped";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const dollars = (cents: number) => currency.format(cents / 100);

export default function TcgplayerSalesImportModal({
  onClose,
  onComplete,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [worksheetName, setWorksheetName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<TcgplayerImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [acknowledged, setAcknowledged] = useState(false);

  const needsAcknowledgement = Boolean(
    preview &&
      (preview.aggregateSummary ||
        preview.summary.unmatchedItems > 0 ||
        preview.summary.shortageUnits > 0),
  );

  async function previewFile(file: File) {
    setBusy(true);
    setError("");
    setPreview(null);
    setResult(null);
    setAcknowledged(false);
    setWorksheetName("");
    try {
      const source = await readTcgplayerSalesFile(file);
      const response = await fetch("/api/tcgplayer-sales", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          csvText: source.text,
          fileName: file.name,
        }),
      });
      const data = (await response.json()) as { preview?: ImportPreview; error?: string };
      if (!response.ok || !data.preview) {
        throw new Error(data.error || "Defy could not preview that file");
      }
      setCsvText(source.text);
      setFileName(file.name);
      setWorksheetName(source.worksheetName);
      setPreview(data.preview);
      setFilter("all");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Defy could not preview that file");
    } finally {
      setBusy(false);
    }
  }

  function dropFile(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void previewFile(file);
  }

  async function commitImport() {
    if (!preview || busy || !preview.summary.readyOrders) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/tcgplayer-sales", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "commit",
          csvText,
          fileName,
          acknowledgeWarnings: acknowledged,
        }),
      });
      const data = (await response.json()) as {
        result?: TcgplayerImportResult;
        error?: string;
      };
      if (!response.ok || !data.result) {
        throw new Error(data.error || "TCGplayer sales import failed");
      }
      setResult(data.result);
      setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "TCGplayer sales import failed");
    } finally {
      setBusy(false);
    }
  }

  const visibleOrders = (preview?.orders || []).filter((order) => {
    if (filter === "ready") return !order.skipped;
    if (filter === "attention") {
      return (
        !order.skipped &&
        (order.isAggregateSummary ||
          order.items.some((item) => !item.productId || item.shortageQuantity))
      );
    }
    if (filter === "skipped") return order.skipped;
    return true;
  });

  return (
    <section
      className="modal tcg-sales-import-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tcg-sales-import-title"
      aria-busy={busy}
    >
      <button
        className="modal-close"
        onClick={onClose}
        disabled={busy}
        aria-label="Close TCGplayer sales importer"
      >
        ×
      </button>
      <div className="modal-heading">
        <p className="eyebrow">TCGPLAYER SALES</p>
        <h2 id="tcg-sales-import-title">
          {result ? "Import complete" : preview ? "Review before importing" : "Import TCGplayer sales"}
        </h2>
        <p>
          {result
            ? result.aggregateSummary
              ? "The Seller Tax Report is now recorded as one protected revenue summary."
              : "The new orders are now in Defy’s sales ledger. Exact product matches also updated stock."
            : "Upload an order export or Seller Tax Report. Defy ignores buyer names and addresses."}
        </p>
      </div>

      {error && (
        <div className="tcg-import-error" role="alert">
          <span>{error}</span>
          {preview && <button onClick={() => void commitImport()}>Try again</button>}
        </div>
      )}

      {!preview && !result && (
        <div className="tcg-import-select">
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void previewFile(file);
            }}
          />
          <button
            className="import-dropzone"
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={dropFile}
            disabled={busy}
          >
            <span>{busy ? "•••" : "↑"}</span>
            <strong>{busy ? "Reading and matching orders…" : "Choose TCGplayer file"}</strong>
            <small>Tap to browse or drop one file here · Maximum 5 MB</small>
          </button>
          <div className="tcg-import-format-note">
            <strong>What Defy can import</strong>
            <p>
              Per-order Excel or CSV exports add revenue and prevent duplicates. Files with
              product-level rows can also reduce stock. Seller Tax Reports can add one revenue
              summary for the selected date range, but cannot change inventory, product cost, or fees.
            </p>
          </div>
        </div>
      )}

      {preview && (
        <>
          <div className="tcg-import-file">
            <span>{preview.fileName.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV"}</span>
            <p>
              <strong>{preview.fileName}</strong>
              <small>
                {preview.summary.rows} rows · {preview.headers.length} columns detected
                {worksheetName ? ` · ${worksheetName} worksheet` : ""}
              </small>
            </p>
            <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
              Replace
            </button>
            <input
              ref={inputRef}
              hidden
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void previewFile(file);
              }}
            />
          </div>

          <div className="import-summary" aria-label="Import summary">
            <article>
              <small>{preview.aggregateSummary ? "Report orders" : "New orders"}</small>
              <strong>
                {preview.aggregateSummary
                  ? preview.aggregateSummary.reportedOrders
                  : preview.summary.readyOrders}
              </strong>
              <span>
                {preview.aggregateSummary
                  ? `${preview.aggregateSummary.reportedRefunds} refunds`
                  : `${preview.summary.duplicateOrders} duplicate`}
              </span>
            </article>
            <article>
              <small>Sales revenue</small>
              <strong>{dollars(preview.summary.revenueCents)}</strong>
              <span>
                {preview.aggregateSummary
                  ? `${dollars(preview.aggregateSummary.refundCents)} refunded`
                  : preview.summary.feesCents
                    ? `${dollars(preview.summary.feesCents)} fees found`
                    : "No fees detected"}
              </span>
            </article>
            <article>
              <small>Stock change</small>
              <strong>−{preview.summary.stockUnitsToDeduct}</strong>
              <span>{preview.summary.matchedItems} matched lines</span>
            </article>
            <article className={preview.aggregateSummary || preview.summary.unmatchedItems || preview.summary.shortageUnits ? "needs-attention" : ""}>
              <small>Needs attention</small>
              <strong>
                {preview.aggregateSummary
                  ? 1
                  : preview.summary.unmatchedItems + preview.summary.shortageUnits}
              </strong>
              <span>
                {preview.aggregateSummary
                  ? "summary limits"
                  : `${preview.summary.unmatchedItems} unmatched · ${preview.summary.shortageUnits} short`}
              </span>
            </article>
          </div>

          {preview.aggregateSummary ? (
            <div className="tcg-import-info">
              <strong>Revenue summary only</strong>
              <span>
                Gross {dollars(preview.aggregateSummary.grossRevenueCents)} minus{" "}
                {dollars(preview.aggregateSummary.refundCents)} refunded. Tax{" "}
                {dollars(preview.aggregateSummary.netTaxCents)} is excluded from revenue.
                Inventory, product cost, and marketplace fees will not change.
              </span>
            </div>
          ) : !preview.hasLineItems ? (
            <div className="tcg-import-info">
              <strong>Sales totals only</strong>
              <span>This export has no product-level rows, so inventory will not be adjusted.</span>
            </div>
          ) : null}

          {preview.warnings.length > 0 && (
            <details className="tcg-import-warnings" open={needsAcknowledgement}>
              <summary>{preview.warnings.length} import note{preview.warnings.length === 1 ? "" : "s"}</summary>
              <ul>
                {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </details>
          )}

          <div className="import-filter-tabs" aria-label="Filter preview orders">
            {(
              [
                ["all", `All ${preview.summary.totalOrders}`],
                ["ready", `Ready ${preview.summary.readyOrders}`],
                ["attention", `Attention ${preview.orders.filter((order) => !order.skipped && (order.isAggregateSummary || order.items.some((item) => !item.productId || item.shortageQuantity))).length}`],
                ["skipped", `Skipped ${preview.summary.duplicateOrders + preview.summary.canceledOrders + preview.summary.pendingOrders}`],
              ] as Array<[Filter, string]>
            ).map(([key, label]) => (
              <button
                type="button"
                key={key}
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="import-review-list">
            {visibleOrders.slice(0, 60).map((order) => {
              const unmatched = order.items.filter((item) => !item.productId).length;
              const shortages = order.items.reduce((sum, item) => sum + item.shortageQuantity, 0);
              const hasIssue = order.isAggregateSummary || unmatched > 0 || shortages > 0;
              return (
                <article key={order.saleNumber} className={order.skipped ? "is-skipped" : hasIssue ? "has-issue" : ""}>
                  <div className="import-order-id">
                    <strong>{order.isAggregateSummary ? "Seller Tax Report" : order.orderNumber}</strong>
                    <small>
                      {order.isAggregateSummary
                        ? `${order.reportStartDate} – ${order.reportEndDate}`
                        : new Date(order.soldAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </small>
                  </div>
                  <div className="import-order-items">
                    <strong>
                      {order.isAggregateSummary
                        ? `${order.reportedOrderCount} orders summarized`
                        : order.items.length
                        ? order.items.slice(0, 2).map((item) => item.matchedName || item.productName).join(" · ")
                        : "Order summary"}
                    </strong>
                    <small>
                      {order.isAggregateSummary
                        ? `${order.reportedRefundCount} refunds · no product rows`
                        : order.items.length
                        ? `${order.items.reduce((sum, item) => sum + item.quantity, 0)} units · ${order.items.length} lines`
                        : "No product-level rows"}
                    </small>
                  </div>
                  <div className="import-order-status">
                    {order.skipped ? (
                      <span className="import-status skipped">{order.skipReason}</span>
                    ) : order.isAggregateSummary ? (
                      <span className="import-status warning">Summary only</span>
                    ) : unmatched || shortages ? (
                      <span className="import-status warning">{unmatched ? `${unmatched} unmatched` : `${shortages} stock short`}</span>
                    ) : (
                      <span className="import-status ready">Ready</span>
                    )}
                  </div>
                  <strong className="import-order-total">
                    {dollars(
                      order.productSubtotalCents +
                        order.shippingCents -
                        order.discountCents,
                    )}
                  </strong>
                </article>
              );
            })}
            {visibleOrders.length > 60 && (
              <p className="import-list-more">Showing the first 60 of {visibleOrders.length} orders.</p>
            )}
            {!visibleOrders.length && <p className="import-list-more">No orders in this filter.</p>}
          </div>

          {needsAcknowledgement && (
            <label className="tcg-import-confirm">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                <strong>I reviewed the import warnings</strong>
                <small>
                  {preview.aggregateSummary
                    ? "This adds revenue only; inventory, product cost, and fees stay unchanged."
                    : "Unmatched items import without changing stock; shortages stop at zero."}
                </small>
              </span>
            </label>
          )}

          <div className="modal-actions tcg-import-actions">
            <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="dark-button"
              disabled={busy || !preview.summary.readyOrders || (needsAcknowledgement && !acknowledged)}
              onClick={() => void commitImport()}
            >
              {busy
                ? "Importing…"
                : preview.aggregateSummary
                  ? "Add period summary"
                  : `Import ${preview.summary.readyOrders} order${preview.summary.readyOrders === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      )}

      {result && (
        <div className="tcg-import-result" aria-live="polite">
          <div className="result-check">✓</div>
          <h3>
            {result.aggregateSummary
              ? `${result.reportedOrders} TCGplayer orders summarized`
              : `${result.importedOrders} TCGplayer order${result.importedOrders === 1 ? "" : "s"} imported`}
          </h3>
          <p>
            {result.aggregateSummary
              ? `1 summary added · ${result.reportedOrders} orders represented · ${dollars(result.revenueCents)} net revenue`
              : `${dollars(result.revenueCents)} in sales was added to Defy OS.`}
          </p>
          <div>
            <span>
              <small>{result.aggregateSummary ? "Orders summarized" : "Stock deducted"}</small>
              <strong>
                {result.aggregateSummary
                  ? result.reportedOrders
                  : `${result.stockUnitsDeducted} units`}
              </strong>
            </span>
            <span><small>Duplicate orders</small><strong>{result.duplicateOrders}</strong></span>
            <span><small>Unmatched lines</small><strong>{result.unmatchedItems}</strong></span>
            <span><small>Fees recorded</small><strong>{dollars(result.feesCents)}</strong></span>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Close</button>
            <button type="button" className="dark-button" onClick={() => void onComplete(result)}>
              View imported sales →
            </button>
          </div>
        </div>
      )}
    </section>
  );
}