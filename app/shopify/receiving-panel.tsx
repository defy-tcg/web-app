"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { ReceivingHistoryPage, ReceivingHistoryReceipt } from "@/lib/shopify/receiving-history";

const quantity = new Intl.NumberFormat("en-US");

function cost(cents: number, currencyCode: string) {
  if (!Number.isFinite(cents)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currencyCode}`;
  }
}

function date(value: string | null, includeTime = false) {
  if (!value) return "Date unavailable";
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (Number.isNaN(parsed.valueOf())) return "Date unavailable";
  return includeTime ? parsed.toLocaleString() : parsed.toLocaleDateString();
}

async function readHistory(signal: AbortSignal, cursor?: string): Promise<ReceivingHistoryPage> {
  const response = await fetch(`/api/shopify/receiving${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Sign in again to load receiving history." : typeof data.error === "string" ? data.error : "Receiving history could not be loaded. Try again.");
  }
  if (!Array.isArray(data.receipts) || typeof data.hasMore !== "boolean" ||
    (data.hasMore && (typeof data.nextCursor !== "string" || !data.nextCursor || data.nextCursor === cursor))) {
    throw new Error("Receiving history was incomplete. Refresh to try again.");
  }
  return data;
}

export default function ReceivingPanel({ onRefreshed }: { onRefreshed?: () => void | Promise<void> }) {
  const [receipts, setReceipts] = useState<ReceivingHistoryReceipt[]>([]);
  const [page, setPage] = useState<ReceivingHistoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const busy = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    busy.current = true;
    void readHistory(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setReceipts(data.receipts);
      setPage(data);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Receiving history could not be loaded.");
    }).finally(() => {
      if (!controller.signal.aborted) { busy.current = false; setLoading(false); }
    });
    return () => request.current?.abort();
  }, []);

  async function load(cursor?: string) {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController();
    request.current = controller;
    setError("");
    if (cursor) setLoadingMore(true); else setLoading(true);
    try {
      const data = await readHistory(controller.signal, cursor);
      if (controller.signal.aborted) return;
      setReceipts((current) => cursor
        ? [...new Map([...current, ...data.receipts].map((receipt) => [receipt.id, receipt])).values()]
        : data.receipts);
      setPage(data);
      if (!cursor) await onRefreshed?.();
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Receiving history could not be loaded. Try again.");
    } finally {
      if (!controller.signal.aborted) { busy.current = false; setLoading(false); setLoadingMore(false); }
    }
  }

  return <>
    <section className="shopify-panel shopify-receiving-guide" id="shopify-receive-stock" aria-labelledby="shopify-receiving-heading">
      <div className="shopify-receiving-heading"><div><p className="shopify-eyebrow">SHOPIFY POS · DEFY RECEIVING</p><h2 id="shopify-receiving-heading">Receive or count stock</h2><p>Use the Defy Receiving tile on your Shopify POS device to add a delivery or set the current stock at the receiving location.</p></div><span className="shopify-receiving-badge">Shopify stock</span></div>
      <ol className="shopify-receiving-steps">
        <li><strong>Scan the product</strong><p>Open <b>Defy Receiving</b> in Shopify POS and scan the manufacturer barcode.</p></li>
        <li><strong>Find the right variant</strong><p>Check the product and variant. If the barcode is unknown, search existing products before creating a new one.</p></li>
        <li><strong>Choose delivery or current stock</strong><p><b>Receive delivery</b> adds the units received and records acquisition cost per unit. <b>Set current stock</b> replaces the available count with your total available to sell, including zero. Exclude committed or reserved stock. Confirm the location and selling unit.</p></li>
        <li><strong>Set your price and save</strong><p>Enter an optional <b>Store price per selling unit</b> to change the Shopify selling price; blank keeps the current price. Save once, wait for confirmation, then refresh history and stock below.</p></li>
      </ol>
      <div className="shopify-receiving-followup"><p><strong>New product?</strong> Review its selling price, activate it, and publish it to the <strong>Point of Sale</strong> sales channel in Shopify before selling. A new draft may already hold stock. Current-stock counts do not record acquisition costs.</p><Link href="/singles" className="shopify-button">Receive catalog singles</Link></div>
    </section>

    <section className="shopify-panel shopify-records shopify-receiving-history" aria-labelledby="shopify-receiving-history-heading" aria-busy={loading || loadingMore}>
      <header><div><h2 id="shopify-receiving-history-heading">Receiving history</h2><p>Confirmed deliveries and stock counts for the configured receiving location. Refresh history also reloads saved stock. If stock still looks old, use <strong>Sync now</strong> below to read the latest Shopify balances.</p></div><button type="button" className="shopify-button" disabled={loading || loadingMore} onClick={() => void load()}>{loading ? "Loading…" : "↻ Refresh history"}</button></header>
      {error && <p className="shopify-alert shopify-receiving-error" role="alert">{error}</p>}
      {loading && !page ? <div className="shopify-empty" role="status">Loading receiving history…</div> : receipts.length ? <div className="shopify-table-scroll" tabIndex={0} role="region" aria-label="Confirmed Shopify receiving history; scroll horizontally for all columns">
        <table><thead><tr><th scope="col">Product</th><th scope="col">SKU / barcode</th><th scope="col">Quantity</th><th scope="col">Unit cost</th><th scope="col">Total cost</th><th scope="col">Date</th></tr></thead>
          <tbody>{receipts.map((receipt) => <tr key={receipt.id}>
            <th scope="row"><strong>{receipt.name}</strong><small>{receipt.locationName || "Receiving location"} · {receipt.inventoryMode === "set" ? "Stock count" : "Delivery"} · Confirmed in Shopify</small>{receipt.storePriceCents !== undefined && <small>Store price saved: {cost(receipt.storePriceCents, receipt.currencyCode)} per {receipt.unit}</small>}{receipt.createdProduct && <small>Product created with this receipt</small>}{receipt.staged && <small>Draft at receipt</small>}</th>
            <td className="shopify-sku">{receipt.sku || "SKU not set"}<small>{receipt.barcode ? `Barcode: ${receipt.barcode}` : "Barcode not set"}</small></td>
            <td><strong>{receipt.inventoryMode === "set" ? "Set to " : "+"}{quantity.format(receipt.quantity)}</strong><small>{receipt.unit}</small></td>
            <td>{receipt.inventoryMode === "set" ? "—" : cost(receipt.unitCostCents, receipt.currencyCode)}</td><td>{receipt.inventoryMode === "set" ? "—" : cost(receipt.totalCostCents, receipt.currencyCode)}</td>
            <td>{date(receipt.receivedDate)}<small>Confirmed {date(receipt.appliedAt, true)}</small></td>
          </tr>)}</tbody>
        </table>
      </div> : page && !error ? <div className="shopify-empty"><h3>No receipts on the loaded pages</h3><p>{page.hasMore ? "More history is available. Load more to find receipts for this location." : "Confirmed deliveries and stock counts will appear here after saving through Defy Receiving."}</p></div> : null}
      {page && <footer className="shopify-receiving-pagination"><div><p>{quantity.format(receipts.length)} confirmed receipt{receipts.length === 1 ? "" : "s"} loaded · Updated {date(page.fetchedAt, true)}</p>{page.otherLocationCount > 0 && <p>{quantity.format(page.otherLocationCount)} receipt{page.otherLocationCount === 1 ? "" : "s"} from other locations skipped on the last page.</p>}</div>{page.hasMore && page.nextCursor && <button type="button" className="shopify-button" disabled={loading || loadingMore} onClick={() => void load(page.nextCursor!)}>{loadingMore ? "Loading more…" : "Load more receipts"}</button>}</footer>}
    </section>
  </>;
}
