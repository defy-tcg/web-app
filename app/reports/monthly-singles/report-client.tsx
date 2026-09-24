"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { MonthlySinglesReport } from "@/lib/reports/monthly-singles";
import ThemeToggle from "../../theme-toggle";

type ReportResult = {
  requestKey: string;
} & (
  | { report: MonthlySinglesReport; error?: never }
  | { report?: never; error: { message: string; code: string } }
);

const count = new Intl.NumberFormat("en-US");
const isMonth = (value: string) => /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value);
const monthLabel = (value: string) =>
  isMonth(value)
    ? new Date(`${value}-01T12:00:00Z`).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "Selected month";
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
const dateTime = (value: string, timeZone: string) =>
  new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });

function csvCell(value: string | number): string {
  let text = String(value).replaceAll("\0", "");
  if (
    typeof value === "string" &&
    (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text))
  ) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(report: MonthlySinglesReport) {
  const columns = [
    "Rank", "Single", "Variant", "SKU", "Game", "Net copies sold",
    `Item sales before tax (${report.currencyCode})`, "POS copies", "Web copies",
    "Other copies", "Orders", "Shopify variant ID", "Source", "Month",
    "Reporting time zone", "Report updated at",
  ];
  const rows: (string | number)[][] = report.rows.map((row) => [
    row.rank, row.name, row.variantTitle, row.sku, row.game, row.netUnits,
    row.itemSalesCents / 100, row.channels.pos, row.channels.web, row.channels.other,
    row.orderCount, row.variantId, report.source, report.month, report.timeZone,
    report.generatedAt,
  ]);
  const csv = [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `defy-monthly-singles-${report.month}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Exclusions({ report }: { report: MonthlySinglesReport }) {
  const exclusions = [
    ["Test orders", report.excluded.testOrders],
    ["Cancelled orders", report.excluded.cancelledOrders],
    ["Unpaid / fully refunded orders", report.excluded.unpaidOrders],
    ["Non-single item lines", report.excluded.nonSingleLines],
    ["Unclassified item lines", report.excluded.unclassifiedLines],
    ["Deleted item lines", report.excluded.deletedLines],
    ["Zero-quantity item lines", report.excluded.zeroQuantityLines],
  ] as const;
  return (
    <details className="monthly-report-method">
      <summary>Coverage, exclusions &amp; how to read this report</summary>
      <div className="monthly-report-method-body">
        <p>
          Read {count.format(report.totals.scannedOrders)} Shopify orders for this period;
          {" "}{count.format(report.totals.eligibleOrders)} paid or partially refunded orders were eligible before filtering for singles.
          Totals cover all qualifying singles. The table and CSV contain up to 50 variants,
          ranked by net copies sold. Each condition or finish remains its own variant.
        </p>
        <p>
          Reporting window: {dateTime(report.startAt, report.timeZone)} to
          {" "}{dateTime(report.endAt, report.timeZone)} (end exclusive), in {report.timeZone}.
          Shopify shop time zone: {report.shopTimeZone}.
          {report.monthToDate ? " This month is still in progress; results are month to date." : " This is a completed calendar month."}
        </p>
        <dl className="monthly-report-exclusions">
          {exclusions.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{count.format(value)}</dd></div>
          ))}
        </dl>
        {report.notes.length > 0 && (
          <ul>{report.notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul>
        )}
      </div>
    </details>
  );
}

export default function MonthlySinglesClient({ initialMonth }: { initialMonth: string }) {
  const [selection, setSelection] = useState({ month: initialMonth, revision: 0 });
  const [result, setResult] = useState<ReportResult | null>(null);
  const validMonth = isMonth(selection.month) && selection.month <= initialMonth;
  const requestKey = `${selection.month}:${selection.revision}`;
  const currentResult = result?.requestKey === requestKey ? result : null;
  const loading = validMonth && !currentResult;
  const report = currentResult?.report;
  const error = currentResult?.error;
  const needsOrderAccess = error?.code === "ORDER_ACCESS_REQUIRED";
  const needsHistoricalAccess = error?.code === "HISTORICAL_ACCESS_REQUIRED";
  const [currentYear, currentMonth] = initialMonth.split("-").map(Number);
  const monthOptions = Array.from({ length: 24 }, (_, index) => {
    const date = new Date(Date.UTC(currentYear, currentMonth - 1 - index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });

  useEffect(() => {
    if (!validMonth) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/reports/monthly-singles?month=${encodeURIComponent(selection.month)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setResult({
            requestKey,
            error: {
              message: typeof data.error === "string" ? data.error : "The monthly report could not be loaded. Refresh to try again.",
              code: typeof data.code === "string" ? data.code : "REPORT_UNAVAILABLE",
            },
          });
          return;
        }
        if (
          data.month !== selection.month || data.source !== "Shopify" || data.complete !== true ||
          !Array.isArray(data.rows) || !Array.isArray(data.notes) || !data.totals || !data.excluded
        ) {
          throw new Error("Shopify returned an incomplete report. Refresh to try again.");
        }
        setResult({ requestKey, report: data as MonthlySinglesReport });
      } catch (reason) {
        if (!controller.signal.aborted) {
          setResult({
            requestKey,
            error: {
              code: "REPORT_UNAVAILABLE",
              message: reason instanceof Error ? reason.message : "The monthly report could not be loaded. Refresh to try again.",
            },
          });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [requestKey, selection.month, validMonth]);

  return (
    <div className="monthly-report-shell">
      <header className="monthly-report-topbar">
        <Link href="/" className="monthly-report-brand">
          <Image src="/favicon.svg" alt="" width={38} height={38} />
          <span>DEFY <small>STORE OS</small></span>
        </Link>
        <nav className="monthly-report-top-actions" aria-label="Report navigation">
          <Link href="/shopify">Shopify stock &amp; receiving</Link>
          <Link href="/">← Back to Defy OS</Link>
          <ThemeToggle />
        </nav>
      </header>

      <main className="monthly-report-main">
        <div className="monthly-report-heading">
          <p className="monthly-report-eyebrow">DEFY’S SALES · SHOPIFY</p>
          <h1>Monthly singles sales</h1>
          <p>Your 50 best-selling singles by net copies sold, across Shopify POS, web, and other Shopify orders.</p>
        </div>

        <section className="monthly-report-toolbar" aria-label="Report controls">
          <div className="monthly-report-month">
            <label htmlFor="monthly-report-month">Sales month</label>
            <select
              id="monthly-report-month"
              value={selection.month}
              aria-describedby="monthly-period-help"
              onChange={(event) => setSelection((previous) => ({ month: event.target.value, revision: previous.revision + 1 }))}
            >
              {monthOptions.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
            </select>
          </div>
          <p id="monthly-period-help">Calendar months in America/Los_Angeles.<br />Current month shows sales to date.</p>
          <div className="monthly-report-actions">
            <button
              type="button"
              className="monthly-report-button is-primary"
              disabled={!validMonth || loading}
              onClick={() => setSelection((previous) => ({ ...previous, revision: previous.revision + 1 }))}
            >{loading ? "Loading report…" : "Refresh report"}</button>
            <button type="button" className="monthly-report-button" disabled={!report?.rows.length} onClick={() => report && downloadCsv(report)}>
              Download CSV
            </button>
          </div>
        </section>

        <p className="monthly-report-source">
          Source: Defy’s Shopify orders. This report includes sales recorded through Shopify only;
          the historic Defy OS sales ledger is separate. Refreshing reads orders without changing stock or sales.
        </p>

        <div className="monthly-report-results" aria-busy={loading}>
          {!validMonth && <p role="alert" className="monthly-report-alert">Choose a valid month no later than {monthLabel(initialMonth)}.</p>}
          {loading && (
            <div className="monthly-report-state" role="status">
              <span className="monthly-report-spinner" aria-hidden="true" />
              <h2>Reading {monthLabel(selection.month)} sales</h2>
              <p>Checking Shopify order access and collecting the full month’s orders. Larger months may take a little longer.</p>
            </div>
          )}
          {error && (
            <section className={`monthly-report-state ${needsOrderAccess || needsHistoricalAccess ? "is-setup" : "is-error"}`} role="alert">
              <p className="monthly-report-eyebrow">{monthLabel(selection.month)}</p>
              <h2>{needsOrderAccess ? "Shopify order access needs activation" : needsHistoricalAccess ? "Older order history needs access" : "Report could not be loaded"}</h2>
              <p>{error.message}</p>
              {needsOrderAccess && <p>The store owner must activate Shopify order access for the connected app. Once access is approved, refresh this report.</p>}
              {needsHistoricalAccess && <p>The store owner must approve access to older Shopify orders before this month can be reported.</p>}
              <p className="monthly-report-state-note">Sales totals are unavailable for this month. This does not mean zero sales.</p>
            </section>
          )}

          {report && (
            <>
              <div className="monthly-report-period" aria-live="polite">
                <h2>{monthLabel(report.month)} <span>{report.monthToDate ? "Month to date" : "Full month"}</span></h2>
                <p>Updated {dateTime(report.generatedAt, report.timeZone)} · {report.timeZone}</p>
              </div>
              <section className="monthly-report-metrics" aria-label="All qualifying singles for this month">
                <article><span>Net copies sold</span><strong>{count.format(report.totals.netUnits)}</strong><small>All qualifying singles</small></article>
                <article><span>Item sales before tax</span><strong>{money(report.totals.itemSalesCents, report.currencyCode)}</strong><small>{report.currencyCode} · All qualifying singles</small></article>
                <article><span>Single variants sold</span><strong>{count.format(report.totals.distinctVariants)}</strong><small>Conditions &amp; finishes kept separate</small></article>
              </section>

              <section className="monthly-report-table-panel" aria-labelledby="monthly-report-table-heading">
                <header>
                  <div><h2 id="monthly-report-table-heading">Top {report.rows.length || 50} singles</h2><p>Ranked by net copies sold · Channel columns show net copies</p></div>
                  <span>{report.rows.length} of {count.format(report.totals.distinctVariants)} variants</span>
                </header>
                {report.rows.length ? (
                  <div className="monthly-report-table-scroll" tabIndex={0} role="region" aria-label="Ranked monthly singles sales table">
                    <table>
                      <caption className="monthly-report-visually-hidden">{monthLabel(report.month)} Shopify singles ranked by net copies sold</caption>
                      <thead><tr><th scope="col">Rank</th><th scope="col">Single / variant</th><th scope="col">Game</th><th scope="col" className="is-numeric">Net copies</th><th scope="col" className="is-numeric">Item sales<br />before tax</th><th scope="col" className="is-numeric">POS</th><th scope="col" className="is-numeric">Web</th><th scope="col" className="is-numeric">Other</th></tr></thead>
                      <tbody>
                        {report.rows.map((row) => (
                          <tr key={row.variantId}>
                            <td className="monthly-report-rank">{row.rank}</td>
                            <th scope="row"><strong>{row.name}</strong>{row.variantTitle && row.variantTitle !== "Default Title" && <span>{row.variantTitle}</span>}<small>SKU: {row.sku || "Not assigned"}</small></th>
                            <td>{row.game || "Unclassified"}</td>
                            <td className="is-numeric monthly-report-units">{count.format(row.netUnits)}</td>
                            <td className="is-numeric">{money(row.itemSalesCents, report.currencyCode)}</td>
                            <td className="is-numeric">{count.format(row.channels.pos)}</td>
                            <td className="is-numeric">{count.format(row.channels.web)}</td>
                            <td className="is-numeric">{count.format(row.channels.other)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="monthly-report-empty"><h3>No qualifying singles sales</h3><p>Shopify was read successfully for {monthLabel(report.month)}. Review coverage and exclusions below for items that did not qualify.</p></div>
                )}
              </section>
              <Exclusions report={report} />
            </>
          )}
        </div>
      </main>
    </div>
  );
}
