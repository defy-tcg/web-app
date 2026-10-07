"use client";

import { useRef, useState, type FormEvent } from "react";
import type { SavedSkuProduct } from "./sku-inventory-panel";
import { isShopifyLabelLink, type ShopifyLabelLink } from "./shopify-link-status";

export default function SkuManualPrice({ product, disabled, onBusy, onLinked }: {
  product: SavedSkuProduct; disabled: boolean;
  onBusy: (busy: boolean) => void; onLinked: (link: ShopifyLabelLink) => void;
}) {
  const [price, setPrice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const entered = price.trim();
  const priceCents = /^\d+(?:\.\d{1,2})?$/.test(entered) ? Math.round(Number(entered) * 100) : 0;
  const valid = Number.isSafeInteger(priceCents) && priceCents > 0 && priceCents <= 100_000_000;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || disabled || !confirmed || !valid) return;
    submitting.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const response = await fetch("/api/sku-labels/manual-price", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku: product.sku, priceCents, confirmed: true,
          card: { name: product.name, game: product.game, setName: product.setName, cardNumber: product.cardNumber,
            condition: product.condition, finish: product.finish, tcgplayerId: product.tcgplayerId } }),
      });
      if (response.redirected || response.status === 401) throw new Error("Sign in again before confirming this card's selling price.");
      const data = await response.json() as { link?: unknown; error?: string };
      if (!response.ok) throw new Error(data.error || "The manual price could not be confirmed. Retry the same price and QR.");
      if (!isShopifyLabelLink(data.link) || data.link.sku !== product.sku) {
        throw new Error("The Shopify result could not be confirmed. Retry the same price and QR.");
      }
      onLinked(data.link);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The manual price could not be confirmed. Retry the same price and QR.");
    } finally { submitting.current = false; setBusy(false); onBusy(false); }
  }

  return <form className="sku-manual-price" onSubmit={event => void submit(event)} aria-label={`Manual selling price for ${product.sku}`}>
    <strong>Set a manual selling price</strong>
    <p>Scrydex has no verified price for this printing. Confirm the physical card and enter the final price to link this same QR.</p>
    <p>{product.name} · {product.setName} · {product.cardNumber} · {product.condition} · {product.finish}</p>
    <fieldset disabled={disabled || busy}>
      <label>Final selling price ($)<input type="text" inputMode="decimal" value={price} maxLength={10}
        onChange={event => { setPrice(event.target.value); setConfirmed(false); setError(""); }} placeholder="0.00" /></label>
      <label className="sku-manual-confirmation"><input type="checkbox" checked={confirmed}
        onChange={event => setConfirmed(event.target.checked)} /> I checked this printing and approve this final selling price.</label>
      <button className="primary-button" type="submit" disabled={!valid || !confirmed}>{busy ? "Saving price & linking…" : "Save price & link Shopify"}</button>
    </fieldset>
    <p>The QR and original starting quantity stay the same. This price is entered manually; no automatic markup is added.</p>
    {error && <p className="sku-inline-error" role="alert">{error}</p>}
  </form>;
}
