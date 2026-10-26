"use client";

import { startTransition, useEffect, useRef, useState, type FormEvent } from "react";

export type NativeOrderForPricing = {
  warehouseId: string; orderId: string; reference: string; status: string;
  copyCount: number; createdAt: string; fingerprint: string; copyIds: string[];
};
type OrderSaleRequest = {
  requestId: string; warehouseId: string; orderId: string; expectedFingerprint: string;
  copyIds: string[]; note: string;
  sale: { subtotalCents: number; discountCents: number; taxCents: number; totalCostCents: number | null;
    soldAt: string; channel: string; paymentMethod: string };
};
type Saved = { version: 1; body: string; createdAt: string };
const STORAGE_KEY = "defy-bulk-native-order-sale:v1";
const LOCK_NAME = "defy-bulk-native-order-sale";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function restore(raw: string | null): Saved | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || typeof value.body !== "string" || value.body.length > 2_000_000 || typeof value.createdAt !== "string") throw new Error("Invalid saved sale");
  const request: unknown = JSON.parse(value.body);
  if (!object(request) || typeof request.requestId !== "string" || !UUID.test(request.requestId) ||
    typeof request.warehouseId !== "string" || !UUID.test(request.warehouseId) || typeof request.orderId !== "string" ||
    typeof request.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedFingerprint) ||
    !Array.isArray(request.copyIds) || request.copyIds.some(id => typeof id !== "string") || !object(request.sale)) throw new Error("Invalid saved sale");
  return value as Saved;
}
async function locked<T>(action: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("Use an updated browser that can safely save this sale request.");
  return navigator.locks.request(LOCK_NAME, action);
}
function cents(value: string, label: string, max = 2_000_000_000) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error(`${label} needs a dollar amount with up to two decimal places.`);
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > max) throw new Error(`${label} is outside the supported amount.`);
  return amount;
}
function localNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function BulkNativeOrderSales({ orders, total, warehouseNames, disabled, onRecorded }: {
  orders: NativeOrderForPricing[]; total: number; warehouseNames: Record<string, string>; disabled: boolean; onRecorded: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<NativeOrderForPricing | null>(null);
  const [subtotal, setSubtotal] = useState("");
  const [discount, setDiscount] = useState("0.00");
  const [tax, setTax] = useState("0.00");
  const [cost, setCost] = useState("");
  const [soldAt, setSoldAt] = useState("");
  const [channel, setChannel] = useState("TCGplayer");
  const [paymentMethod, setPaymentMethod] = useState("Marketplace");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    const read = () => {
      try { const value = restore(localStorage.getItem(STORAGE_KEY)); startTransition(() => { setSaved(value); setReady(true); setStorageError(""); }); }
      catch { startTransition(() => { setReady(true); setStorageError("The browser could not read its saved order sale. New order sales are blocked until this saved request can be recovered."); }); }
    };
    const changed = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) read(); };
    read(); window.addEventListener("storage", changed);
    return () => { mounted.current = false; controller.current?.abort(); window.removeEventListener("storage", changed); };
  }, []);
  useEffect(() => { if (draft) heading.current?.focus(); }, [draft]);

  const stale = Boolean(draft && !orders.some(order => order.warehouseId === draft.warehouseId && order.orderId === draft.orderId && order.fingerprint === draft.fingerprint));
  const blocked = disabled || !ready || Boolean(saved) || Boolean(storageError) || sending;
  const savedRequest = saved ? JSON.parse(saved.body) as OrderSaleRequest : null;
  let preview: number | null = null;
  try { const amount = cents(subtotal, "Subtotal"); preview = amount - cents(discount || "0", "Discount", amount) + cents(tax || "0", "Tax"); }
  catch { /* Validation is shown when the operator submits the form. */ }

  function open(order: NativeOrderForPricing) {
    setDraft(order); setSubtotal(""); setDiscount("0.00"); setTax("0.00"); setCost("");
    setSoldAt(localNow()); setNote(""); setError(""); setNotice("");
  }
  async function clear(pending: Saved) {
    await locked(() => {
      const current = restore(localStorage.getItem(STORAGE_KEY));
      if (current?.body === pending.body) {
        localStorage.removeItem(STORAGE_KEY);
        if (localStorage.getItem(STORAGE_KEY) !== null) throw new Error("The browser could not clear the saved sale.");
      } else if (current) throw new Error("The saved order sale changed in another tab. Reload to review it.");
    });
    if (mounted.current) setSaved(null);
  }
  async function transmit(pending: Saved) {
    const request = JSON.parse(pending.body) as OrderSaleRequest;
    const abort = new AbortController(); controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 25_000);
    try {
      const response = await fetch("/api/bulk-warehouse/orders/sale", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: pending.body, signal: abort.signal });
      const result: unknown = await response.json();
      if (!response.ok) {
        if (response.status === 400 && object(result) && typeof result.error === "string") await clear(pending);
        throw new Error(response.status === 401 ? "Sign in again, then retry this exact saved sale." : object(result) && typeof result.error === "string" ? result.error : "The sale was not confirmed. Retry the saved request.");
      }
      if (!object(result) || result.id !== request.requestId || !["applied", "rejected"].includes(String(result.status)) || typeof result.message !== "string") throw new Error("The response did not match this sale. Retry the same saved request.");
      if (!mounted.current) return;
      if (result.status === "applied") window.dispatchEvent(new Event("defy-bulk-warehouse-updated"));
      setNotice(result.message); setDraft(null);
      try { await clear(pending); setStorageError(""); }
      catch { setStorageError("The server received this sale, but the browser could not clear its saved copy. Retry it to recover safely."); }
      await onRecorded();
    } catch (caught) {
      if (mounted.current) setError(abort.signal.aborted ? "Confirmation timed out. Your exact sale is saved; retry it safely." : caught instanceof Error ? caught.message : "Retry the saved sale to check its status.");
    } finally { window.clearTimeout(timeout); }
  }
  async function retry() {
    if (submitting.current || !saved) return;
    submitting.current = true; setSending(true); setError("");
    try {
      const current = await locked(() => restore(localStorage.getItem(STORAGE_KEY)));
      if (!current || current.body !== saved.body) throw new Error("The saved sale changed in another tab. Reload before retrying.");
      await transmit(current);
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "The saved sale could not be read."); }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || blocked || !draft) return;
    submitting.current = true; setSending(true); setError("");
    try {
      if (stale) throw new Error("This order changed or was already priced. Close the form and refresh.");
      const amount = cents(subtotal, "Order subtotal");
      if (amount < 1) throw new Error("Enter the actual order subtotal, greater than $0.00.");
      const date = new Date(soldAt);
      if (!Number.isFinite(date.getTime()) || date.getTime() < Date.UTC(2000, 0, 1) || date.getTime() > Date.now() + 300_000) throw new Error("Enter the actual sale date, no later than now.");
      const request: OrderSaleRequest = {
        requestId: crypto.randomUUID(), warehouseId: draft.warehouseId, orderId: draft.orderId,
        expectedFingerprint: draft.fingerprint, copyIds: [...draft.copyIds].sort(), note: note.trim(),
        sale: { subtotalCents: amount, discountCents: cents(discount || "0", "Discount", amount), taxCents: cents(tax || "0", "Tax"),
          totalCostCents: cost.trim() ? cents(cost, "Total card cost") : null, soldAt: date.toISOString(), channel, paymentMethod },
      };
      const pending: Saved = { version: 1, body: JSON.stringify(request), createdAt: new Date().toISOString() };
      await locked(() => {
        if (localStorage.getItem(STORAGE_KEY) !== null) throw new Error("Another order sale is saved. Reload and retry it first.");
        const serialized = JSON.stringify(pending);
        localStorage.setItem(STORAGE_KEY, serialized);
        if (localStorage.getItem(STORAGE_KEY) !== serialized) throw new Error("The browser could not save this request. No sale was sent.");
      });
      setSaved(pending); await transmit(pending);
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : "The order sale could not be saved."); }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  }

  return <section className="bw-activity bw-native-orders" aria-labelledby="bw-native-orders-title">
    <header><div><h3 id="bw-native-orders-title">Native orders awaiting a sale amount</h3><p>Shipped orders across all game workspaces appear here until you record the actual amount paid. Saving an amount updates sales reports and keeps physical stock as it is.</p></div></header>
    {storageError && <p className="bw-alert bw-alert-error" role="alert">{storageError}</p>}
    {error && <p className="bw-alert bw-alert-error" role="alert">{error}</p>}
    {notice && <p className="bw-alert" role="status">{notice}</p>}
    {savedRequest && <div className="bw-retry" role="status"><div><strong>Confirm your saved order sale</strong><p>The exact amounts, date, order, and request ID are saved. Retrying checks the original request.</p><details><summary>Saved sale details</summary><p>Order: {savedRequest.orderId} · {warehouseNames[savedRequest.warehouseId] || "Warehouse"}</p><p>{savedRequest.copyIds.length} cards · Subtotal {currency.format(savedRequest.sale.subtotalCents / 100)} · Discount {currency.format(savedRequest.sale.discountCents / 100)} · Tax {currency.format(savedRequest.sale.taxCents / 100)}</p><p>Sale date: {new Date(savedRequest.sale.soldAt).toLocaleString()}</p><code>{savedRequest.requestId}</code></details></div><button type="button" className="bw-button bw-button-primary" disabled={sending} onClick={() => void retry()}>{sending ? "Checking sale…" : "Retry saved order sale"}</button></div>}
    {draft && <form className="bw-composer" onSubmit={event => void submit(event)} aria-labelledby="bw-native-sale-title">
      <header><div><h3 id="bw-native-sale-title" ref={heading} tabIndex={-1}>Record sale amount</h3><p>{draft.reference} · {warehouseNames[draft.warehouseId] || "Warehouse"} · {draft.copyCount} {draft.copyCount === 1 ? "card" : "cards"}</p></div><button type="button" className="bw-button bw-button-subtle" disabled={sending} onClick={() => { setDraft(null); setError(""); }}>Close</button></header>
      <p className="bw-form-help">Use the complete order amounts from the receipt. The order is stored as one sale total; per-card selling prices are not inferred. This form does not collect payment.</p>
      <details className="bw-copy-review"><summary>Review order and copy IDs</summary><p>Order ID: {draft.orderId}</p><p>{draft.copyIds.join(", ")}</p></details>
      {stale && <p className="bw-alert bw-alert-error" role="alert">This order changed or has already been priced. Close this form and refresh.</p>}
      <fieldset disabled={blocked}>
        <div className="bw-sale-fields">
          <label>Order subtotal ($)<input type="number" inputMode="decimal" min="0.01" step="0.01" required value={subtotal} onChange={event => setSubtotal(event.target.value)} /></label>
          <label>Total card cost ($)<input type="number" inputMode="decimal" min="0" step="0.01" aria-label="Total card cost ($)" aria-describedby="bw-native-cost-note" value={cost} onChange={event => setCost(event.target.value)} placeholder="Unknown" /><small id="bw-native-cost-note">Blank keeps cost unknown and profit incomplete.</small></label>
          <label>Actual sale date and time<input type="datetime-local" required value={soldAt} onChange={event => setSoldAt(event.target.value)} /></label>
          <label>Sales channel<select value={channel} onChange={event => setChannel(event.target.value)}><option>TCGplayer</option><option>In-store</option><option>Online</option><option>Other</option></select></label>
          <label>Payment method<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option>Marketplace</option><option>Card</option><option>Cash</option><option>Other</option></select></label>
          <label>Total discount ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
          <label>Total tax ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={tax} onChange={event => setTax(event.target.value)} /></label>
        </div>
        <label className="bw-note">Note (optional)<textarea rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="Payment receipt or marketplace order reference" /></label>
      </fieldset>
      <footer><div><strong>Sale total: {preview === null ? "Enter the order subtotal" : currency.format(preview / 100)}</strong><p>Saved once against this native order. No additional stock movement.</p></div><button type="submit" className="bw-button bw-button-primary" disabled={blocked || stale}>{sending ? "Saving sale…" : "Save order sale"}</button></footer>
    </form>}
    {orders.length ? <><ul>{orders.map(order => <li key={`${order.warehouseId}:${order.orderId}`}><div><strong>{order.reference}</strong><p>{warehouseNames[order.warehouseId] || "Warehouse"} · {order.copyCount} {order.copyCount === 1 ? "card" : "cards"} · Shipped · Sale amount needed</p><small>Order ID: <code>{order.orderId}</code></small></div><button type="button" className="bw-button" disabled={blocked || Boolean(draft)} onClick={() => open(order)}>Record sale amount</button></li>)}</ul>{total > orders.length && <p className="bw-activity-empty">Showing {orders.length} of {total} orders awaiting amounts. More orders appear as these are recorded.</p>}</> : <p className="bw-activity-empty">No shipped native orders are waiting for a sale amount.</p>}
  </section>;
}
