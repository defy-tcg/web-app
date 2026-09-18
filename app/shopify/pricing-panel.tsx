"use client";

import { useEffect, useRef, useState } from "react";

type PricingState = {
  runId: string; startedAt: string; finishedAt: string | null; checked: number;
  updated: number; unchanged: number; skipped: number; running: boolean; done: boolean;
  lastError: string | null;
  issues: { sku: string; title: string; message: string }[];
  samples: { variantId: string; sku: string; title: string; marketCents: number; priceCents: number }[];
};
type PricingStatus = { enabled: boolean; state: PricingState | null; error?: string };
const dollars = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
async function loadStatus(signal?: AbortSignal): Promise<PricingStatus> {
  const response = await fetch("/api/shopify/pricing", { cache: "no-store", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Pricing status could not be loaded.");
  return data;
}

export default function PricingPanel() {
  const [status, setStatus] = useState<PricingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const active = useRef(false);
  const pause = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    loadStatus(controller.signal).then(value => { if (mounted.current) setStatus(value); }).catch(reason => {
      if (mounted.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Pricing status is unavailable.");
    });
    return () => { mounted.current = false; pause.current = true; controller.abort(); };
  }, []);

  async function refreshStatus() {
    try { setStatus(await loadStatus()); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Pricing status is unavailable."); }
  }
  async function refreshPrices() {
    if (active.current) return;
    active.current = true; pause.current = false; setBusy(true); setError("");
    setMessage("Checking Scrydex and updating Shopify prices…");
    let runId = status?.state && !status.state.done ? status.state.runId : undefined;
    try {
      for (let page = 0; page < 100; page++) {
        const response = await fetch("/api/shopify/pricing", { method: "POST",
          headers: { "Content-Type": "application/json", "X-Defy-Sync": "1" }, body: JSON.stringify(runId ? { runId } : {}) });
        const data = await response.json() as PricingStatus;
        if (!response.ok || !data.state) throw new Error(data.error || "Price refresh stopped. Resume the saved run.");
        if (!mounted.current) return;
        setStatus(data); runId = data.state.runId;
        setMessage(`${data.state.checked} checked · ${data.state.updated} updated · ${data.state.unchanged} already current · ${data.state.skipped} need review`);
        if (data.state.done) { setMessage(previous => `${previous}. Refresh complete—allow Shopify POS to sync before scanning.`); break; }
        if (pause.current || page === 99) { setMessage(previous => `${previous}. Paused; resume to check the remaining products.`); break; }
      }
    } catch (reason) {
      if (mounted.current) {
        setError(reason instanceof Error ? reason.message : "Price refresh stopped. Resume the saved run.");
        try { setStatus(await loadStatus()); } catch { /* Keep the last confirmed progress. */ }
      }
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  }
  const state = status?.state;
  return <section className="shopify-panel pricing-panel" aria-labelledby="pos-prices-heading">
    <div className="pricing-panel-heading">
      <div>
        <p className="shopify-eyebrow">SCRYDEX → SHOPIFY POS</p>
        <h2 id="pos-prices-heading">Scan with current prices</h2>
        <p>Sync prices to Shopify, then scan your usual SKU or barcode in POS. The same selling price also applies online.</p>
      </div>
      <div className="pricing-panel-actions">
        <button className="shopify-button" disabled={busy} onClick={() => void refreshStatus()}>Check status</button>
        {busy ? <button className="shopify-button" onClick={() => { pause.current = true; setMessage("Finishing this group, then pausing…"); }}>Pause after this group</button>
          : <button className="shopify-button is-primary" disabled={status?.enabled === false || state?.running} onClick={() => void refreshPrices()}>
            {state?.running ? "Price refresh running…" : state && !state.done ? "Resume price refresh" : "Refresh Scrydex prices"}
          </button>}
      </div>
    </div>
    <p className="pricing-policy">Riftbound singles: market + 10%. Other supported products, including sealed: market. Automatic refresh runs daily; Scrydex quotes can be cached for 24 hours.</p>
    <p>Last completed: {state?.finishedAt ? new Date(state.finishedAt).toLocaleString() : "Not yet"}{status?.enabled === false ? " · Price sync is disabled" : ""}</p>
    {(message || state) && <p role="status" className="pricing-progress">{message || `${state!.checked} checked · ${state!.updated} updated · ${state!.unchanged} already current · ${state!.skipped} need review`}</p>}
    {(error || state?.lastError) && <p role="alert" className="pricing-error">{error || state?.lastError}</p>}
    {!!state?.samples.length && <details><summary>Recently verified Shopify prices</summary>
      <div className="pricing-table-wrap"><table><thead><tr><th>Product / SKU</th><th>Market</th><th>Shopify price</th></tr></thead>
        <tbody>{state.samples.map(row => <tr key={row.variantId}><td>{row.title}<small>{row.sku}</small></td><td>{dollars(row.marketCents)}</td><td>{dollars(row.priceCents)}</td></tr>)}</tbody></table></div>
    </details>}
    {!!state?.issues.length && <details open><summary>{state.skipped} products need review · existing prices kept</summary>
      <ul className="pricing-issues">{state.issues.map((row, index) => <li key={`${row.sku}-${index}`}><strong>{row.title} · {row.sku}</strong><span>{row.message}</span></li>)}</ul>
      {state.skipped > state.issues.length && <p>Showing the first {state.issues.length} issues.</p>}
    </details>}
    <p className="pricing-policy">Only active products already available in POS are checked. Sealed products need a unique matching code and exact product details in Defy inventory.</p>
  </section>;
}
