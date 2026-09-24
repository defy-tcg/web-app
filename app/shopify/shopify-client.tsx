"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ThemeToggle from "../theme-toggle";
import PricingPanel from "./pricing-panel";
import ReceivingPanel from "./receiving-panel";

type InventoryRow = {
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string;
  status: string | null;
  sku: string;
  barcode: string;
  tracked: boolean | null;
  price: string | number;
  locationId: string;
  available: number | null;
  onHand: number | null;
  committed: number | null;
  updatedAt: string;
};
type OrderRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  financialStatus: string;
  fulfillmentStatus: string;
  cancelledAt: string | null;
  total: string | number;
  currencyCode: string;
  itemCount: number;
};
type SyncSnapshot = {
  configured: boolean;
  enabled: boolean;
  ordersEnabled: boolean;
  shop: string;
  locationId: string;
  status: "disabled" | "setup_required" | "ready" | "error";
  blockers: string[];
  inventory: InventoryRow[];
  orders: OrderRow[];
  summary: {
    products: number;
    variants: number;
    inventory: number;
    orders: number | null;
    pending: number;
    failed: number;
    lastSyncedAt: string | null;
  };
  recentErrors: { topic: string; error: string; updatedAt: string }[];
};
type SyncPage = {
  processed: number;
  nextCursor: string | null;
  done: boolean;
  pendingProcessed: number;
};
type Checkpoint = { cursor: string; processed: number };

const MAX_PAGES_PER_RUN = 20;
const MAX_VISIBLE_ROWS = 100;
const MAX_VISIBLE_ORDERS = 50;
const count = new Intl.NumberFormat("en-US");
const dateTime = (value: string | null) => {
  if (!value) return "Not yet synced";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Date unavailable"
    : date.toLocaleString();
};
const money = (value: string | number, currencyCode: string) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currencyCode}`;
  }
};
const statusLabel = (value: string) =>
  value ? value.toLowerCase().replaceAll("_", " ") : "Unknown";
const errorMessage = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value) return value;
  if (
    value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
  )
    return value.message;
  return fallback;
};
const checkpointKey = (snapshot: SyncSnapshot) =>
  `defy-shopify-sync:v2:${snapshot.shop}:${snapshot.locationId}:${snapshot.ordersEnabled ? "full" : "inventory"}`;

async function readSnapshot(signal?: AbortSignal): Promise<SyncSnapshot> {
  const response = await fetch("/api/shopify/sync", {
    cache: "no-store",
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      errorMessage(data.error, "Shopify sync details could not be loaded."),
    );
  if (
    !data.summary ||
    !Array.isArray(data.inventory) ||
    !Array.isArray(data.orders) ||
    !Array.isArray(data.blockers) ||
    !Array.isArray(data.recentErrors)
  )
    throw new Error(
      "Shopify returned an incomplete dashboard. Refresh to try again.",
    );
  return data;
}

export default function ShopifyClient() {
  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [section, setSection] = useState<"inventory" | "orders">("inventory");
  const [query, setQuery] = useState("");
  const mounted = useRef(false);
  const syncing = useRef(false);
  const pauseRequested = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    async function load() {
      try {
        const data = await readSnapshot(controller.signal);
        if (!mounted.current) return;
        setSnapshot(data);
        try {
          const stored = sessionStorage.getItem(checkpointKey(data));
          if (stored) {
            const saved = JSON.parse(stored) as Checkpoint;
            if (
              typeof saved.cursor === "string" &&
              saved.cursor.length > 0 &&
              saved.cursor.length <= 4096 &&
              Number.isSafeInteger(saved.processed) &&
              saved.processed >= 0
            ) {
              setCheckpoint(saved);
              setMessage(
                "A previous sync is paused. Resume when you’re ready.",
              );
            }
          }
        } catch {
          setStorageWarning(
            "This browser cannot save sync progress. Keep this page open to resume; starting again safely refreshes the same Shopify records.",
          );
        }
      } catch (reason) {
        if (!controller.signal.aborted && mounted.current)
          setError(
            errorMessage(reason, "Shopify sync details could not be loaded."),
          );
      } finally {
        if (!controller.signal.aborted && mounted.current) setLoading(false);
      }
    }
    void load();
    return () => {
      mounted.current = false;
      pauseRequested.current = true;
      controller.abort();
    };
  }, []);

  async function refresh() {
    if (syncing.current) return;
    setRefreshing(true);
    setError("");
    try {
      const data = await readSnapshot();
      if (mounted.current) setSnapshot(data);
    } catch (reason) {
      if (mounted.current)
        setError(
          errorMessage(reason, "Shopify sync details could not be loaded."),
        );
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  function saveCheckpoint(data: SyncSnapshot, next: Checkpoint | null) {
    if (mounted.current) setCheckpoint(next);
    try {
      if (next)
        sessionStorage.setItem(checkpointKey(data), JSON.stringify(next));
      else sessionStorage.removeItem(checkpointKey(data));
    } catch {
      if (mounted.current)
        setStorageWarning(
          "This browser cannot save sync progress. Keep this page open to resume; starting again safely refreshes the same Shopify records.",
        );
    }
  }

  async function synchronize() {
    if (
      syncing.current ||
      !snapshot?.configured ||
      !snapshot.enabled ||
      snapshot.blockers.length
    )
      return;
    syncing.current = true;
    pauseRequested.current = false;
    setRunning(true);
    setPausing(false);
    setError("");
    let cursor = checkpoint?.cursor;
    let processed = checkpoint?.processed ?? 0;
    let pendingProcessed = 0;
    setMessage(snapshot.ordersEnabled ? "Reading the latest inventory and orders from Shopify…" : "Reading the latest inventory from Shopify…");
    try {
      for (let page = 0; page < MAX_PAGES_PER_RUN; page += 1) {
        if (!mounted.current || pauseRequested.current) break;
        const response = await fetch("/api/shopify/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Defy-Sync": "1" },
          body: JSON.stringify(cursor ? { cursor } : {}),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            errorMessage(
              result.error,
              "This sync stopped. You can retry safely.",
            ),
          );
        const progress = result as SyncPage;
        if (
          typeof progress.done !== "boolean" ||
          !Number.isSafeInteger(progress.processed) ||
          progress.processed < 0 ||
          (!progress.done &&
            (typeof progress.nextCursor !== "string" ||
              !progress.nextCursor ||
              progress.nextCursor === cursor))
        )
          throw new Error(
            "Sync returned unexpected progress and has stopped. Refresh the dashboard before trying again.",
          );
        processed += progress.processed;
        pendingProcessed += progress.pendingProcessed || 0;
        cursor = progress.nextCursor ?? undefined;
        saveCheckpoint(
          snapshot,
          progress.done ? null : { cursor: cursor!, processed },
        );
        if (!mounted.current) break;
        setMessage(
          `${count.format(processed)} record${processed === 1 ? "" : "s"} checked${pendingProcessed ? ` · ${count.format(pendingProcessed)} queued update${pendingProcessed === 1 ? "" : "s"} processed` : ""}.`,
        );
        if (progress.done) {
          setMessage(
            `Sync complete. ${count.format(processed)} record${processed === 1 ? "" : "s"} checked${pendingProcessed ? ` and ${count.format(pendingProcessed)} queued update${pendingProcessed === 1 ? "" : "s"} processed` : ""}.`,
          );
          break;
        }
        if (pauseRequested.current || page + 1 === MAX_PAGES_PER_RUN) {
          setMessage(
            `Sync paused after ${count.format(processed)} record${processed === 1 ? "" : "s"}. Resume to continue from this point.`,
          );
          break;
        }
      }
    } catch (reason) {
      if (mounted.current) {
        setMessage(
          `Sync stopped after ${count.format(processed)} record${processed === 1 ? "" : "s"} checked. You can retry when the connection is ready.`,
        );
        setError(
          errorMessage(reason, "This sync stopped. You can retry safely."),
        );
      }
    } finally {
      if (mounted.current) {
        try {
          const data = await readSnapshot();
          if (mounted.current) setSnapshot(data);
        } catch {
          if (mounted.current)
            setError(
              (previous) =>
                previous ||
                "The sync finished, but the dashboard could not refresh. Use Refresh view to load the latest results.",
            );
        }
        if (mounted.current) {
          setRunning(false);
          setPausing(false);
        }
      }
      syncing.current = false;
    }
  }

  const ready =
    !!snapshot?.configured &&
    snapshot.enabled &&
    snapshot.blockers.length === 0;
  const ordersEnabled = snapshot?.ordersEnabled !== false;
  const visibleSection = ordersEnabled ? section : "inventory";
  const search = (visibleSection === section ? query : "").trim().toLowerCase();
  const inventory = (snapshot?.inventory ?? [])
    .slice(0, MAX_VISIBLE_ROWS)
    .filter((row) =>
      [row.title, row.variantTitle, row.sku, row.barcode]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );
  const orders = (snapshot?.orders ?? [])
    .slice(0, MAX_VISIBLE_ORDERS)
    .filter((row) =>
      [row.name, row.financialStatus, row.fulfillmentStatus]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );

  return (
    <div className="shopify-shell">
      <header className="shopify-topbar">
        <Link href="/" className="shopify-brand">
          <Image src="/favicon.svg" alt="" width={38} height={38} />
          <span>
            DEFY <small>STORE OS</small>
          </span>
        </Link>
        <div className="shopify-top-actions">
          <Link href="/reports/monthly-singles">Monthly singles</Link>
          <Link href="/">← Back to Defy OS</Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="shopify-main">
        <section className="shopify-heading">
          <div>
            <p className="shopify-eyebrow">CONNECTED COMMERCE</p>
            <h1>{ordersEnabled ? "Shopify stock & orders" : "Shopify receiving & stock"}</h1>
            <p className="shopify-intro">
              {ordersEnabled ? "Your Shopify inventory and sales, together in Defy OS." : "Your Shopify inventory and receiving history, together in Defy OS."} Receive stock through Shopify POS and review it here.
            </p>
          </div>
          <a href="#shopify-receive-stock" className="shopify-button is-primary">＋ Receive stock</a>
        </section>

        <ReceivingPanel onRefreshed={refresh} />

        <PricingPanel />

        <div className="shopify-boundary">
          <span aria-hidden="true">↔</span>
          <p>
            Shopify is the source of truth for this stock. Receive and sell it through Shopify. These balances stay separate from the sheet-backed Defy OS inventory and checkout.
          </p>
        </div>

        <section
          className="shopify-panel shopify-connection"
          aria-labelledby="shopify-connection-heading"
        >
          <div className="shopify-connection-copy">
            <div className="shopify-connection-title">
              <span
                className={`shopify-status-dot ${ready ? "is-ready" : ""}`}
                aria-hidden="true"
              />
              <h2 id="shopify-connection-heading">
                {loading
                  ? "Checking connection…"
                  : snapshot?.status === "disabled"
                    ? "Sync is switched off"
                    : snapshot?.status === "setup_required"
                      ? "Connection needs setup"
                      : snapshot?.status === "error"
                        ? "Sync needs attention"
                        : ready
                          ? "Shopify connected"
                          : "Connection unavailable"}
              </h2>
            </div>
            {snapshot?.shop && <p>{snapshot.shop}</p>}
            <p>
              Last synced: {dateTime(snapshot?.summary.lastSyncedAt ?? null)}
            </p>
            {snapshot && !ordersEnabled && <p>Orders are not connected. Inventory and receiving remain available here.</p>}
            {snapshot?.status === "disabled" && (
              <p>
                Enable Shopify synchronization in the store configuration to
                start receiving updates here.
              </p>
            )}
            {!!snapshot?.blockers.length && (
              <ul>
                {snapshot.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}
          </div>
          <div className="shopify-sync-controls">
            {running ? (
              <button
                type="button"
                className="shopify-button"
                disabled={pausing}
                onClick={() => {
                  pauseRequested.current = true;
                  setPausing(true);
                  setMessage("Pausing after the current batch finishes…");
                }}
              >
                {pausing ? "Pausing…" : "Pause sync"}
              </button>
            ) : (
              <button
                type="button"
                className="shopify-button is-primary"
                disabled={!ready || refreshing || loading}
                onClick={() => void synchronize()}
              >
                {checkpoint ? "Resume sync" : "Sync now"}
              </button>
            )}
            <button
              type="button"
              className="shopify-button"
              disabled={refreshing || running || loading}
              onClick={() => void refresh()}
            >
              {refreshing ? "Refreshing…" : "↻ Refresh view"}
            </button>
            <p>
              Sync now reads from Shopify.
              <br />
              Refresh view loads saved results.
            </p>
          </div>
        </section>

        <div aria-live="polite" aria-atomic="true">
          {message && <p className="shopify-notice">{message}</p>}
        </div>
        {error && (
          <p role="alert" className="shopify-alert">
            {error}
          </p>
        )}
        {storageWarning && <p className="shopify-notice">{storageWarning}</p>}

        {loading ? (
          <div className="shopify-empty" role="status">
            Loading Shopify connection and stock…
          </div>
        ) : snapshot ? (
          <>
            <section className="shopify-metrics" aria-label="Synced records">
              {(
                [
                  ["Products", snapshot.summary.products],
                  ["Variants", snapshot.summary.variants],
                  [ordersEnabled ? "Orders" : "Stock records", ordersEnabled ? snapshot.summary.orders ?? 0 : snapshot.summary.inventory],
                  ["Queued updates", snapshot.summary.pending],
                ] as const
              ).map(([label, value]) => (
                <div className="shopify-panel" key={label}>
                  <span>{label}</span>
                  <strong>{count.format(value)}</strong>
                </div>
              ))}
            </section>

            {!!snapshot.summary.failed && (
              <p className="shopify-alert">
                {count.format(snapshot.summary.failed)} updates need attention.
                Review the details below, then use Sync now to retry.
              </p>
            )}

            <section
              className="shopify-panel shopify-records"
              aria-labelledby="shopify-records-heading"
            >
              <header>
                <div>
                  <h2 id="shopify-records-heading">
                    {visibleSection === "inventory"
                      ? "Shopify inventory"
                      : "Shopify orders"}
                  </h2>
                  <p>
                    {visibleSection === "inventory"
                      ? "Stock at the configured receiving location."
                      : "Recent order totals and fulfillment status. Customer details are excluded."}
                  </p>
                </div>
                {ordersEnabled && <div
                  className="shopify-sections"
                  role="group"
                  aria-label="Choose Shopify records"
                >
                  <button
                    type="button"
                    aria-pressed={visibleSection === "inventory"}
                    onClick={() => {
                      setSection("inventory");
                      setQuery("");
                    }}
                  >
                    Inventory
                  </button>
                  <button
                    type="button"
                    aria-pressed={visibleSection === "orders"}
                    onClick={() => {
                      setSection("orders");
                      setQuery("");
                    }}
                  >
                    Orders
                  </button>
                </div>}
              </header>
              <div className="shopify-filters">
                <label>
                  <span>
                    Search loaded{" "}
                    {visibleSection === "inventory" ? "inventory" : "orders"}
                  </span>
                  <input
                    type="search"
                    value={visibleSection === section ? query : ""}
                    onChange={(event) => { setSection(visibleSection); setQuery(event.target.value); }}
                    placeholder={
                      visibleSection === "inventory"
                        ? "Product, variant, SKU, or barcode"
                        : "Order number or status"
                    }
                  />
                </label>
                <p>
                  Showing up to{" "}
                  {visibleSection === "inventory"
                    ? MAX_VISIBLE_ROWS
                    : MAX_VISIBLE_ORDERS}{" "}
                  saved{" "}
                  {visibleSection === "inventory" ? "inventory records" : "orders"}.
                  {visibleSection === "orders" &&
                    " Shopify access determines available order history."}
                </p>
              </div>

              {visibleSection === "inventory" ? (
                inventory.length ? (
                  <div
                    className="shopify-table-scroll"
                    tabIndex={0}
                    role="region"
                    aria-label="Shopify inventory table; scroll horizontally for all columns"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Product / variant</th>
                          <th scope="col">SKU</th>
                          <th scope="col">Barcode</th>
                          <th scope="col">Stock tracking</th>
                          <th scope="col">Price (USD)</th>
                          <th scope="col">Available</th>
                          <th scope="col">On hand</th>
                          <th scope="col">Committed</th>
                          <th scope="col">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventory.map((row) => (
                          <tr key={`${row.variantId}:${row.locationId}`}>
                            <th scope="row">
                              <strong>{row.title}</strong>
                              <small>{row.variantTitle}</small>
                              <small>Product status: {row.status ? statusLabel(row.status) : "Not yet synced"}</small>
                            </th>
                            <td className="shopify-sku">{row.sku || "—"}</td>
                            <td className="shopify-sku">{row.barcode || "Not set"}</td>
                            <td>{row.tracked === true ? "Tracked" : row.tracked === false ? "Not tracked" : "Not yet synced"}</td>
                            <td>{money(row.price, "USD")}</td>
                            <td>
                              <strong>
                                {row.available === null
                                  ? "—"
                                  : count.format(row.available)}
                              </strong>
                            </td>
                            <td>
                              {row.onHand === null
                                ? "—"
                                : count.format(row.onHand)}
                            </td>
                            <td>
                              {row.committed === null
                                ? "—"
                                : count.format(row.committed)}
                            </td>
                            <td>{dateTime(row.updatedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="shopify-empty">
                    <h3>
                      {query
                        ? "No matching inventory"
                        : "No Shopify inventory synced yet"}
                    </h3>
                    <p>
                      {query
                        ? "Try another product name, SKU, or barcode among the loaded records."
                        : ready
                          ? "Use Sync now to load stock for the configured location."
                          : "Complete the connection setup to load Shopify inventory."}
                    </p>
                  </div>
                )
              ) : orders.length ? (
                <div
                  className="shopify-table-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Shopify orders table; scroll horizontally for all columns"
                >
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Order</th>
                        <th scope="col">Placed</th>
                        <th scope="col">Payment</th>
                        <th scope="col">Fulfillment</th>
                        <th scope="col">Items</th>
                        <th scope="col">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((row) => (
                        <tr key={row.id}>
                          <th scope="row">
                            <strong>{row.name}</strong>
                            {row.cancelledAt && (
                              <small className="shopify-cancelled">
                                Cancelled {dateTime(row.cancelledAt)}
                              </small>
                            )}
                          </th>
                          <td>{dateTime(row.createdAt)}</td>
                          <td>
                            <span className="shopify-status-label">
                              {statusLabel(row.financialStatus)}
                            </span>
                          </td>
                          <td>
                            <span className="shopify-status-label">
                              {statusLabel(row.fulfillmentStatus)}
                            </span>
                          </td>
                          <td>{count.format(row.itemCount)}</td>
                          <td>
                            <strong>
                              {money(row.total, row.currencyCode)}
                            </strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="shopify-empty">
                  <h3>
                    {query
                      ? "No matching orders"
                      : "No Shopify orders synced yet"}
                  </h3>
                  <p>
                    {query
                      ? "Try another order number or status among the loaded records."
                      : ready
                        ? "Use Sync now to load the order history available to the Shopify app."
                        : "Complete the connection setup to load Shopify orders."}
                  </p>
                </div>
              )}
            </section>

            {!!snapshot.recentErrors.length && (
              <section
                className="shopify-panel shopify-errors"
                aria-labelledby="shopify-errors-heading"
              >
                <h2 id="shopify-errors-heading">Updates needing attention</h2>
                <ul>
                  {snapshot.recentErrors.map((issue, index) => (
                    <li key={`${issue.topic}:${issue.updatedAt}:${index}`}>
                      <strong>{issue.topic}</strong>
                      <p>{issue.error}</p>
                      <small>{dateTime(issue.updatedAt)}</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <div className="shopify-empty">
            <h2>Shopify details are unavailable</h2>
            <p>Use Refresh view to try loading the connection again.</p>
          </div>
        )}
      </main>
    </div>
  );
}
