"use client";

import { useRef, useState } from "react";
import type { SkuLabelCatalogDetails, SkuLabelCatalogReview } from "@/lib/sku-label-catalog-types";
import type { SavedSkuProduct } from "./sku-inventory-panel";

const description = (card: SkuLabelCatalogDetails) => `${card.name} · ${card.setName} · ${card.cardNumber} · ${card.finish} · TCGplayer ${card.tcgplayerId}`;

export default function SkuCatalogCorrection({ product, disabled, onBusy, onCorrected }: {
  product: SavedSkuProduct; disabled: boolean; onBusy: (busy: boolean) => void; onCorrected: (product: SavedSkuProduct) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [finish, setFinish] = useState(product.finish);
  const [review, setReview] = useState<SkuLabelCatalogReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const submitting = useRef(false);

  function changed() { setReview(null); setConfirmed(false); setError(""); setMessage(""); }
  async function request(action: "preview" | "apply") {
    if (submitting.current || disabled || (action === "apply" && (!review || !confirmed))) return;
    submitting.current = true; setBusy(true); onBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/sku-labels/correction", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sku: product.sku, url, finish,
          ...(action === "apply" ? { sourceVersion: review!.sourceVersion, targetVersion: review!.targetVersion, confirmed: true } : {}) }) });
      const data = await response.json() as { review?: SkuLabelCatalogReview; product?: SavedSkuProduct; error?: string };
      if (!response.ok) throw new Error(data.error || "The correction could not be confirmed. Retry the same reviewed card.");
      if (action === "preview") {
        if (!data.review || data.review.sku !== product.sku) throw new Error("The card review could not be verified. Try again.");
        setReview(data.review); setConfirmed(false);
      } else {
        if (!data.product || data.product.sku !== product.sku || data.product.id !== product.id) throw new Error("The correction could not be confirmed. Retry the same reviewed card.");
        onCorrected(data.product); setReview(null); setConfirmed(false); setOpen(false);
        setMessage("Catalog details corrected. Use Retry Shopify link below to finish this same QR.");
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Catalog correction is unavailable. Retry the same reviewed card."); }
    finally { submitting.current = false; setBusy(false); onBusy(false); }
  }

  return <div className="sku-catalog-correction">
    {!open && <button className="secondary-button" disabled={disabled || busy} onClick={() => { setOpen(true); setMessage(""); }}>Correct catalog details</button>}
    {open && <>
      <p className="sku-print-help">Use this only when the saved catalog entry or finish differs from the physical card. Defy checks that Shopify has not created this card or received its starting stock. The QR, quantity, cost, and location stay the same.</p>
      <fieldset className="sku-inventory-fields" disabled={disabled || busy}>
        <label>Correct TCGplayer card link<input type="url" value={url} onChange={event => { setUrl(event.target.value); changed(); }} placeholder="https://www.tcgplayer.com/product/222330" /></label>
        <label>Physical card finish<select value={finish} onChange={event => { setFinish(event.target.value); changed(); }}>
          {[...new Set([product.finish, "Normal", "Foil", "Reverse Holo"])].map(value => <option key={value}>{value}</option>)}
        </select></label>
      </fieldset>
      {!review && <button className="secondary-button" disabled={disabled || busy || !url.trim()} onClick={() => void request("preview")}>{busy ? "Checking card…" : "Review correction"}</button>}
      {review && <div className="sku-print-help">
        <p><strong>Saved:</strong> {description(review.source)}</p>
        <p><strong>Corrected:</strong> {description(review.target)}</p>
        <p><strong>Keep:</strong> {review.sku} · {review.condition} · {review.quantity} saved {review.quantity === 1 ? "copy" : "copies"}. Verified sale price: ${(review.priceCents / 100).toFixed(2)}.</p>
        <label className="sku-catalog-confirmation"><input type="checkbox" checked={confirmed} disabled={disabled || busy} onChange={event => setConfirmed(event.target.checked)} /> I checked the physical card and these corrected details match.</label>
        <p><button className="primary-button" disabled={disabled || busy || !confirmed} onClick={() => void request("apply")}>{busy ? "Saving correction…" : "Save corrected catalog"}</button></p>
      </div>}
      <button className="secondary-button" disabled={busy} onClick={() => { setOpen(false); changed(); }}>Close</button>
    </>}
    {error && <p className="sku-inline-error" role="alert">{error}</p>}
    {message && <p className="sku-print-help" role="status">{message}</p>}
  </div>;
}
