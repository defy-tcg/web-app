"use client";

import { startTransition, useEffect, useRef, useState, type FormEvent } from "react";
import { isGeneratedSku } from "@/lib/sku-labels";
import type { SkuLabelStockRequest, SkuLabelStockResult } from "@/lib/sku-label-stock-types";
import type { ShopifyLabelLink } from "./shopify-link-status";

const STORAGE_KEY = "defy-qr-stock-receipt:v1";
type PendingReceipt = SkuLabelStockRequest & { name: string };
type Card = { sku: string; name: string };

function readPending(): PendingReceipt | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const saved = JSON.parse(raw) as { version?: number; receipt?: PendingReceipt };
  const receipt = saved.receipt;
  if (saved.version !== 1 || !receipt || !isGeneratedSku(receipt.sku) ||
    typeof receipt.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(receipt.requestId) ||
    typeof receipt.name !== "string" || !Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1 || receipt.quantity > 100000) {
    throw new Error("The saved stock request could not be read. Keep this browser's data and ask the owner to review it before adding more stock.");
  }
  return receipt;
}

function isResult(value: unknown, receipt: PendingReceipt): value is SkuLabelStockResult {
  if (!value || typeof value !== "object") return false;
  const result = value as SkuLabelStockResult;
  return result.requestId === receipt.requestId && result.sku === receipt.sku && result.quantity === receipt.quantity &&
    ["complete", "pending", "rejected"].includes(result.status) && typeof result.message === "string" && typeof result.retryable === "boolean" &&
    (result.availableQuantity === undefined || Number.isSafeInteger(result.availableQuantity));
}

export default function SkuStockPanel({ cards, links, disabled, onReceived }: {
  cards: Card[]; links: Record<string, ShopifyLabelLink>; disabled: boolean;
  onReceived: (sku: string, availableQuantity?: number) => void;
}) {
  const [chosenSku, setChosenSku] = useState("");
  const [draft, setDraft] = useState({ sku: "", quantity: "" });
  const [pending, setPending] = useState<PendingReceipt | null>(null);
  const [result, setResult] = useState<(SkuLabelStockResult & { name: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [storageBlocked, setStorageBlocked] = useState(false);
  const submitting = useRef(false);
  const selected = cards.find((card) => card.sku === chosenSku) ?? cards[0];
  const target = pending ?? selected;
  const quantity = pending ? String(pending.quantity) : draft.sku === selected?.sku ? draft.quantity : "";
  const link = target ? links[target.sku] : undefined;
  const validQuantity = quantity.trim() !== "" && Number.isSafeInteger(Number(quantity)) && Number(quantity) >= 1 && Number(quantity) <= 100000;

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !ready || storageBlocked || disabled || !target || !validQuantity) return;
    if (!pending && link?.status !== "ready") return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    // A second tab must join an unfinished request instead of inventing another receipt.
    const receive = async () => {
      const stored = readPending();
      if (stored && (stored.requestId !== pending?.requestId)) {
        setPending(stored);
        throw new Error("An unfinished stock addition was restored. Check its card and quantity, then use Retry stock addition.");
      }
      const receipt = stored ?? pending ?? { requestId: crypto.randomUUID(), sku: target.sku, name: target.name, quantity: Number(quantity) };
      // Fail before sending if this browser cannot retain the exact receipt for recovery.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, receipt }));
      setPending(receipt);
      const response = await fetch("/api/sku-labels/stock", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: receipt.requestId, sku: receipt.sku, quantity: receipt.quantity }),
      });
      if (response.redirected || response.status === 401) throw new Error("Sign in again, then retry this saved stock addition.");
      const data: unknown = await response.json();
      if (!isResult(data, receipt)) throw new Error("Stock was not confirmed. Retry this saved addition; it will not add the same cards twice.");
      setResult({ ...data, name: receipt.name });
      if (data.status === "complete" || data.status === "rejected") {
        // Remove only this confirmed receipt; never erase another tab's pending addition.
        if (readPending()?.requestId === receipt.requestId) localStorage.removeItem(STORAGE_KEY);
        setPending(null);
        setDraft({ sku: receipt.sku, quantity: "" });
        if (data.status === "complete") onReceived(receipt.sku, data.availableQuantity);
      }
    };
    try {
      if (navigator.locks) await navigator.locks.request(STORAGE_KEY, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          const stored = readPending();
          if (stored) setPending(stored);
          throw new Error("A stock addition is processing in another tab. Wait for its result, then retry the saved request if needed.");
        }
        await receive();
      });
      else await receive();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Stock was not confirmed. Retry this saved stock addition.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const resultForTarget = result?.sku === target?.sku ? result : null;
  return <section className="sku-stock-entry" aria-labelledby="sku-stock-entry-title">
    <h3 id="sku-stock-entry-title">Add cards to inventory</h3>
    {target ? <>
      {cards.length > 1 && !pending ? <label>Card to add stock to<select value={selected?.sku} disabled={busy || disabled} onChange={(event) => setChosenSku(event.target.value)}>
        {cards.map((card) => <option key={card.sku} value={card.sku}>{card.name} · {card.sku}</option>)}
      </select></label> : <p className="sku-stock-target"><strong>{target.name}</strong><code>{target.sku}</code></p>}
      <p className="sku-stock-available">{link?.status === "ready" ? typeof link.availableQuantity === "number"
        ? `Shopify stock: ${link.availableQuantity} available` : "Shopify POS linked. The current stock count is unavailable."
        : "Finish linking this saved QR to Shopify POS before adding stock."}</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>Number of cards to add<input aria-label="Number of cards to add" type="number" inputMode="numeric" min={1} max={100000} step={1} required placeholder="e.g. 5" value={quantity}
          disabled={busy || disabled || Boolean(pending) || storageBlocked || link?.status !== "ready"}
          onChange={(event) => setDraft({ sku: target.sku, quantity: event.target.value })} /></label>
        <button className="primary-button" disabled={!ready || busy || disabled || storageBlocked || !validQuantity ||
          (pending ? resultForTarget?.status === "pending" && !resultForTarget.retryable : link?.status !== "ready")}>
          {busy ? "Adding stock…" : pending ? "Retry stock addition" : "Add stock"}
        </button>
      </form>
      <p className="sku-print-help">Adds this many physical cards to Shopify POS using the same QR. Label copies below only control printing.</p>
      {pending && <p className="sku-storage-warning" role="status">Unfinished addition: {pending.quantity} × {pending.name}. {resultForTarget?.status === "pending" && !resultForTarget.retryable
        ? `Ask the owner to review receipt ${pending.requestId} before adding these cards again.`
        : "Retry this saved request to confirm its result before adding more cards."}</p>}
    </> : <p className="sku-print-help">Load a saved card to add more copies. For a new card, enter its starting quantity when saving its QR.</p>}
    {result && <p className={result.status === "complete" ? "sku-success" : "sku-storage-warning"} role="status"><strong>{result.name}:</strong> {result.message}</p>}
    {error && <p className="sku-inline-error" role="alert">{error}</p>}
  </section>;
}
