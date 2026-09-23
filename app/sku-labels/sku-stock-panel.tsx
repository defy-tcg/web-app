"use client";

import { startTransition, useEffect, useRef, useState, type FormEvent } from "react";
import { isGeneratedSku } from "@/lib/sku-labels";
import type { SkuLabelStockRequest, SkuLabelStockResult } from "@/lib/sku-label-stock-types";
import type { ShopifyLabelLink } from "./shopify-link-status";

const STORAGE_KEY = "defy-qr-stock-receipt:v1";
type PendingReceipt = SkuLabelStockRequest & { name: string };
type Card = { sku: string; name: string };
type StockMode = "add" | "set";
type Draft = { sku: string; mode: StockMode; quantity: string; expectedAvailableQuantity?: number };

function readPending(): PendingReceipt | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw) as { version?: number; receipt?: PendingReceipt };
  const receipt = saved.receipt;
  if (saved.version !== 1 || !receipt || !isGeneratedSku(receipt.sku) ||
    typeof receipt.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(receipt.requestId) ||
    typeof receipt.name !== "string" || ![undefined, "add", "set"].includes(receipt.mode) ||
    !Number.isSafeInteger(receipt.quantity) || receipt.quantity < (receipt.mode === "set" ? 0 : 1) || receipt.quantity > 100000 ||
    (receipt.mode === "set" ? !Number.isSafeInteger(receipt.expectedAvailableQuantity) : receipt.expectedAvailableQuantity !== undefined)) {
    throw new Error("The saved inventory change could not be read. Keep this browser's data and ask the owner to review it before changing stock.");
  }
  return receipt;
}

function isResult(value: unknown, receipt: PendingReceipt): value is SkuLabelStockResult {
  if (!value || typeof value !== "object") return false;
  const result = value as SkuLabelStockResult;
  return result.requestId === receipt.requestId && result.sku === receipt.sku && result.quantity === receipt.quantity &&
    (result.mode ?? "add") === (receipt.mode ?? "add") && result.expectedAvailableQuantity === receipt.expectedAvailableQuantity &&
    ["complete", "pending", "rejected"].includes(result.status) && typeof result.message === "string" && typeof result.retryable === "boolean" &&
    (result.availableQuantity === undefined || Number.isSafeInteger(result.availableQuantity));
}

export default function SkuStockPanel({ cards, links, disabled, onReceived, onRefresh, onBusyChange }: {
  cards: Card[]; links: Record<string, ShopifyLabelLink>; disabled: boolean;
  onReceived: (sku: string, availableQuantity?: number) => void;
  onRefresh: (sku: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [chosenSku, setChosenSku] = useState("");
  const [draft, setDraft] = useState<Draft>({ sku: "", mode: "add", quantity: "" });
  const [pending, setPending] = useState<PendingReceipt | null>(null);
  const [result, setResult] = useState<(SkuLabelStockResult & { name: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const submitting = useRef(false);
  const selected = cards.find((card) => card.sku === chosenSku) ?? cards[0];
  const target = pending ?? selected;
  const selectedDraft = draft.sku === selected?.sku ? draft : undefined;
  const mode = pending?.mode ?? (pending ? "add" : selectedDraft?.mode ?? "add");
  const quantity = pending ? String(pending.quantity) : selectedDraft?.quantity ?? "";
  const link = target ? links[target.sku] : undefined;
  const liveQuantity = link?.status === "ready" && Number.isSafeInteger(link.availableQuantity) ? link.availableQuantity : undefined;
  const baseline = pending?.expectedAvailableQuantity ?? selectedDraft?.expectedAvailableQuantity;
  const validQuantity = quantity.trim() !== "" && Number.isSafeInteger(Number(quantity)) && Number(quantity) >= (mode === "set" ? 0 : 1) && Number(quantity) <= 100000;
  const staleBaseline = mode === "set" && baseline !== undefined && liveQuantity !== undefined && baseline !== liveQuantity;
  const canStart = link?.status === "ready" && (mode === "add" || (baseline !== undefined && liveQuantity !== undefined && !staleBaseline));

  useEffect(() => {
    function restore() {
      if (submitting.current) return;
      try {
        const receipt = readPending();
        startTransition(() => { setPending(receipt); setStorageBlocked(false); setReady(true); });
      } catch (caught) {
        startTransition(() => { setError(caught instanceof Error ? caught.message : "Saved stock requests could not be restored."); setStorageBlocked(true); setReady(true); });
      }
    }
    restore();
    const changed = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) restore(); };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  async function refreshCount() {
    if (!target || busy || refreshing || disabled || pending) return;
    setRefreshing(true);
    onBusyChange(true);
    setError("");
    try {
      await onRefresh(target.sku);
      // A new absolute total must be entered against the newly displayed count.
      setDraft({ sku: target.sku, mode, quantity: "" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Shopify stock could not be refreshed. Try again.");
    } finally { setRefreshing(false); onBusyChange(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !ready || storageBlocked || disabled || refreshing || !target || !validQuantity) return;
    if (!pending && !canStart) return;
    submitting.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    setResult(null);
    // A second tab must join an unfinished request instead of inventing another receipt.
    const receive = async () => {
      const stored = readPending();
      if (stored && (stored.requestId !== pending?.requestId)) {
        setPending(stored);
        throw new Error("An unfinished inventory change was restored. Check its card and quantity, then use Retry inventory change.");
      }
      const newReceipt = { requestId: crypto.randomUUID(), sku: target.sku, name: target.name, quantity: Number(quantity) };
      const receipt: PendingReceipt = stored ?? pending ?? (mode === "set"
        ? { ...newReceipt, mode: "set", expectedAvailableQuantity: baseline! }
        : { ...newReceipt, mode: "add" });
      // Fail before sending if this browser cannot retain the exact receipt for recovery.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, receipt }));
      setPending(receipt);
      const response = await fetch("/api/sku-labels/stock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: receipt.requestId, sku: receipt.sku, quantity: receipt.quantity,
          ...(receipt.mode ? { mode: receipt.mode } : {}),
          ...(receipt.mode === "set" ? { expectedAvailableQuantity: receipt.expectedAvailableQuantity } : {}) }),
      });
      if (response.redirected || response.status === 401) throw new Error("Sign in again, then retry this saved inventory change.");
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new Error("Stock was not confirmed. Retry this saved inventory change; it will not apply the same change twice."); }
      if (!isResult(data, receipt)) throw new Error("Stock was not confirmed. Retry this saved inventory change; it will not apply the same change twice.");
      setResult({ ...data, name: receipt.name });
      if (data.status === "complete" || data.status === "rejected") {
        // Remove only this confirmed receipt; never erase another tab's pending change.
        if (readPending()?.requestId === receipt.requestId) localStorage.removeItem(STORAGE_KEY);
        setPending(null);
        setDraft({ sku: receipt.sku, mode: receipt.mode ?? "add", quantity: "" });
        // A rejected compare also needs a fresh count before another total is entered.
        onReceived(receipt.sku, data.status === "complete" ? data.availableQuantity : undefined);
      }
    };
    try {
      if (navigator.locks) await navigator.locks.request(STORAGE_KEY, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          const stored = readPending();
          if (stored) setPending(stored);
          throw new Error("An inventory change is processing in another tab. Wait for its result, then retry the saved request if needed.");
        }
        await receive();
      });
      else await receive();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stock was not confirmed. Retry this saved inventory change.");
    } finally {
      submitting.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  const resultForTarget = result?.sku === target?.sku ? result : null;
  return <section className="sku-stock-entry" id="sku-stock-entry" aria-labelledby="sku-stock-entry-title">
    <h3 id="sku-stock-entry-title">Change inventory</h3>
    {target ? <>
      {cards.length > 1 && !pending ? <label>Card to update<select value={selected?.sku} disabled={busy || refreshing || disabled} onChange={(event) => { setChosenSku(event.target.value); setDraft({ sku: event.target.value, mode: "add", quantity: "" }); }}>
        {cards.map((card) => <option key={card.sku} value={card.sku}>{card.name} · {card.sku}</option>)}
      </select></label> : <p className="sku-stock-target"><strong>{target.name}</strong><code>{target.sku}</code></p>}
      <div className="sku-stock-live"><p className="sku-stock-available" aria-live="polite">{link?.status === "ready" ? liveQuantity !== undefined
        ? <><strong>{liveQuantity}</strong> currently available in Shopify</> : "Shopify POS linked. The current stock count is unavailable."
        : "Stock is unavailable until this card is linked to Shopify POS. Resolve its link status below, then retry the link."}</p>
        {link?.status === "ready" && <button type="button" className="secondary-button" disabled={busy || refreshing || disabled || Boolean(pending)} onClick={() => void refreshCount()}>{refreshing ? "Refreshing…" : "Refresh count"}</button>}
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label>Inventory change<select aria-label="Inventory change" value={mode} disabled={busy || refreshing || disabled || Boolean(pending) || storageBlocked}
          onChange={(event) => setDraft({ sku: target.sku, mode: event.target.value as StockMode, quantity: "", expectedAvailableQuantity: undefined })}>
          <option value="add">Add copies</option><option value="set">Set total available</option>
        </select></label>
        <label>{mode === "set" ? "Total available" : "Copies to add"}<input aria-label={mode === "set" ? "Total available" : "Copies to add"} type="number" inputMode="numeric" min={mode === "set" ? 0 : 1} max={100000} step={1} required placeholder={mode === "set" ? "e.g. 3" : "e.g. 5"} value={quantity}
          disabled={busy || refreshing || disabled || Boolean(pending) || storageBlocked || link?.status !== "ready" || (mode === "set" && liveQuantity === undefined)}
          onChange={(event) => setDraft({ sku: target.sku, mode, quantity: event.target.value,
            ...(mode === "set" ? { expectedAvailableQuantity: baseline ?? liveQuantity } : {}) })} /></label>
        <button className="primary-button" disabled={!ready || busy || refreshing || disabled || storageBlocked || !validQuantity ||
          (pending ? resultForTarget?.status === "pending" && !resultForTarget.retryable : !canStart)}>
          {busy ? "Updating inventory…" : pending ? "Retry inventory change" : mode === "set" ? "Set total available" : "Add copies"}
        </button>
      </form>
      <p className="sku-print-help">{mode === "set" ? "Enter the total copies available now, including 0 when sold out. This replaces the available count in Shopify."
        : "Enter the newly received copies to add to Shopify's available count."} Your original QR stays the same. Copies per SKU only controls printing.</p>
      {mode === "set" && baseline !== undefined && <p className="sku-print-help">{pending ? "Saved change" : "Count when you entered this total"}: {baseline} available → {quantity || "…"} available. {pending ? "Retry keeps this exact saved change." : "If stock changes before this update, refresh and enter the total again."}</p>}
      {staleBaseline && !pending && <p className="sku-storage-warning" role="status">The available count changed while you were editing. Choose Refresh count, check the new count, then enter your total again.</p>}
      {pending && <p className="sku-storage-warning" role="status">Unfinished change: {pending.mode === "set" ? `set ${pending.quantity} total available` : `add ${pending.quantity} copies`} for {pending.name}. {resultForTarget?.status === "pending" && !resultForTarget.retryable
        ? `Ask the owner to review receipt ${pending.requestId} before changing stock again.`
        : "Retry this saved request to confirm its result before changing more stock."}</p>}
    </> : <p className="sku-print-help">Load a saved card to add copies or set its total available. For a new card, enter its starting quantity when saving its QR.</p>}
    {result && <p className={result.status === "complete" ? "sku-success" : "sku-storage-warning"} role="status"><strong>{result.name}:</strong> {result.message}</p>}
    {error && <p className="sku-inline-error" role="alert">{error}</p>}
  </section>;
}
