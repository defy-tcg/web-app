"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { canonicalInventoryLabelFinish, inventoryLabelIdentityText, LABEL_CONDITIONS, LABEL_FINISHES } from "@/lib/sku-label-inventory";
import { isSavedSkuLabelMatch, sameSkuLabelVariant, savedSkuLabelVariants, type SavedSkuLabelMatch } from "@/lib/sku-label-matching";
import { isGeneratedSku, skuQrSvg } from "@/lib/sku-labels";
import type { TcgplayerCardLookup } from "@/lib/tcgplayer-card";

type TcgplayerCardImportProps = {
  disabled: boolean;
  onAdd: (card: TcgplayerCardLookup, condition: string, finish: string) => Promise<void>;
};

export default function TcgplayerCardImport({ disabled, onAdd }: TcgplayerCardImportProps) {
  const [url, setUrl] = useState("");
  const [card, setCard] = useState<TcgplayerCardLookup | null>(null);
  const [inventory, setInventory] = useState<SavedSkuLabelMatch[] | null>(null);
  const [condition, setCondition] = useState<string>("Near Mint");
  const [finish, setFinish] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const locked = disabled || loading || adding;
  const savedVariants = useMemo(() => card && inventory ? savedSkuLabelVariants(inventory,
    { ...card, tcgplayerId: card.productId, condition: "", finish: "" }) : [], [card, inventory]);
  const existing = card ? savedVariants.find((product) => sameSkuLabelVariant(product,
    { ...card, tcgplayerId: card.productId, condition, finish })) : undefined;
  const legacySku = Boolean(existing && !isGeneratedSku(existing.sku));
  const savedQr = useMemo(() => existing && isGeneratedSku(existing.sku) ? skuQrSvg(existing.sku) : "", [existing]);
  const finishOptions = [...new Set([...(card?.finishes ?? []), ...savedVariants.map((product) => canonicalInventoryLabelFinish(product.finish))])];

  function selectSavedVariant(product: SavedSkuLabelMatch) {
    setCondition(LABEL_CONDITIONS.find((value) => inventoryLabelIdentityText(value) === inventoryLabelIdentityText(product.condition)) ?? product.condition);
    setFinish(canonicalInventoryLabelFinish(product.finish));
    setError("");
  }

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || working.current || !url.trim()) return;
    working.current = true;
    setLoading(true);
    setError("");
    setCard(null);
    setInventory(null);
    setFinish("");
    setImageFailed(false);
    try {
      const [response, inventoryResponse] = await Promise.all([
        fetch("/api/sku-labels/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
        }),
        fetch("/api/inventory", { cache: "no-store" }),
      ]);
      if ([response, inventoryResponse].some((result) => result.redirected || result.status === 401)) throw new Error("Your session expired. Sign in again before loading a card.");
      if (!inventoryResponse.ok) throw new Error("Saved QR codes could not be checked. Load the card again before creating or using a label.");
      const [result, saved] = await Promise.all([
        response.json() as Promise<{ card?: TcgplayerCardLookup; error?: string }>,
        inventoryResponse.json() as Promise<{ products?: unknown[] }>,
      ]);
      if (!response.ok || !result.card) throw new Error(result.error || "Could not load this card. Check the TCGplayer product link and try again.");
      if (!Array.isArray(saved.products) || !saved.products.every(isSavedSkuLabelMatch)) throw new Error("Saved QR codes could not be confirmed. Load the card again before creating a label.");
      const matches = savedSkuLabelVariants(saved.products, { ...result.card, tcgplayerId: result.card.productId, condition: "", finish: "" });
      setInventory(saved.products);
      setCard(result.card);
      if (matches.length) {
        const defaultVariant = result.card.finishes.length === 1 ? matches.find((product) => sameSkuLabelVariant(product,
          { ...result.card!, tcgplayerId: result.card!.productId, condition: "Near Mint", finish: result.card!.finishes[0] })) : undefined;
        selectSavedVariant(defaultVariant ?? matches[0]);
      }
      else {
        setCondition("Near Mint");
        setFinish(result.card.finishes.length === 1 ? result.card.finishes[0] : "");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this card. Please try again.");
    } finally {
      working.current = false;
      setLoading(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || working.current || !card || !inventory || legacySku) return;
    const selectedFinish = finish.trim();
    if (!selectedFinish || selectedFinish.length > 80 || /[\u0000-\u001f\u007f]/u.test(selectedFinish)) {
      setError("Choose a finish, using up to 80 characters.");
      return;
    }
    working.current = true;
    setAdding(true);
    setError("");
    try {
      await onAdd(card, condition, selectedFinish);
      setCard(null);
      setInventory(null);
      setUrl("");
      setFinish("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this card. Please try again.");
    } finally {
      working.current = false;
      setAdding(false);
    }
  }

  return <section className="sku-panel sku-card-import" aria-labelledby="sku-card-import-title" aria-busy={loading || adding}>
    <div className="sku-panel-heading">
      <span className="sku-step" aria-hidden="true">↗</span>
      <div><h2 id="sku-card-import-title">Add a single from TCGplayer</h2><p>Paste a product link, confirm the card variant, and save its QR for every future print.</p></div>
    </div>
    <form className="sku-import-link-form" onSubmit={(event) => void lookup(event)}>
      <label>TCGplayer product link
        <input type="url" required maxLength={2048} value={url} disabled={locked} autoComplete="off" spellCheck={false}
          placeholder="https://www.tcgplayer.com/product/…"
          onChange={(event) => { setUrl(event.target.value); setCard(null); setInventory(null); setFinish(""); setError(""); }} />
      </label>
      <button className="primary-button" disabled={locked || !url.trim()}>{loading ? "Loading card…" : "Load card"}</button>
    </form>
    <p className="sku-import-help">One permanent SKU per card, condition, and finish. Adding it saves the QR in your shared library automatically. New cards start at zero stock; manage quantity, cost, and sell price in Inventory.</p>
    {card ? <div className="sku-import-result">
      <div className="sku-import-image">
        {card.imageUrl && !imageFailed ? <Image src={card.imageUrl} alt={card.name} width={160} height={224} unoptimized onError={() => setImageFailed(true)} /> : <span>Card image unavailable</span>}
      </div>
      <div className="sku-import-details">
        <p className="eyebrow">REVIEW YOUR SINGLE</p>
        <h3>{card.name}</h3>
        <dl><div><dt>Game</dt><dd>{card.game}</dd></div><div><dt>Set</dt><dd>{card.setName || "Not provided"}</dd></div><div><dt>Card number</dt><dd>{card.cardNumber || "Not provided"}</dd></div></dl>
        <a href={card.productUrl} target="_blank" rel="noopener noreferrer" className="sku-import-source">View on TCGplayer <span aria-hidden="true">↗</span></a>
        {card.warnings.length ? <ul className="sku-import-warnings">{card.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul> : null}
        {savedVariants.length ? <div className="sku-import-saved-variants" aria-label="Saved variants for this card">
          <p><strong>Saved variants</strong> · Select the condition and finish on your card.</p>
          <div>{savedVariants.map((product) => <button key={product.id} type="button" className="secondary-button" disabled={locked}
            aria-pressed={existing?.id === product.id} onClick={() => selectSavedVariant(product)}>
            <span>{product.condition} · {canonicalInventoryLabelFinish(product.finish)}</span><code>{product.sku}</code>
          </button>)}</div>
        </div> : null}
        <form onSubmit={(event) => void add(event)}>
          <fieldset disabled={locked} className="sku-import-variant" aria-label="Card variant">
            <label>Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}>{!LABEL_CONDITIONS.some((value) => value === condition) ? <option>{condition}</option> : null}{LABEL_CONDITIONS.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Finish
              {card.finishes.length ? <select required value={finish} onChange={(event) => setFinish(event.target.value)}>
                <option value="" disabled>Choose finish</option>
                {finishOptions.map((value) => <option key={value}>{value}</option>)}
              </select> : <><input required maxLength={80} value={finish} list="sku-import-finishes" placeholder="Choose or enter a finish" onChange={(event) => setFinish(event.target.value)} /><datalist id="sku-import-finishes">{[...new Set([...LABEL_FINISHES, ...finishOptions])].map((value) => <option key={value} value={value} />)}</datalist><small>Confirm the finish printed on your card.</small></>}
            </label>
          </fieldset>
          {existing ? <div className="sku-import-existing" role="status">
            {savedQr ? <div className="sku-import-existing-qr" role="img" aria-label={`Saved QR code for ${existing.sku}`} dangerouslySetInnerHTML={{ __html: savedQr }} /> : null}
            <div><strong>Already saved</strong><code>{existing.sku}</code><p>{legacySku ? "This card uses an existing inventory SKU. Open Inventory to manage it or print its barcode; a new QR will not be created." : "This is the original QR for this variant. Use it again without changing stock or prices."}</p>
              {legacySku ? <Link href="/">Open Inventory →</Link> : null}</div>
          </div> : null}
          <button className="primary-button sku-import-add" disabled={locked || !inventory || !finish.trim() || legacySku}>{adding ? existing ? "Loading saved QR…" : "Saving QR…" : existing ? legacySku ? "Existing inventory SKU" : "Use saved QR" : "Save QR & add to batch"}<span aria-hidden="true">↗</span></button>
        </form>
      </div>
    </div> : null}
    {error ? <p className="sku-inline-error" role="alert">{error}</p> : null}
    <span className="sku-import-announcement" role="status">{loading ? "Loading card details and checking saved QR codes." : card ? existing ? `${card.name} already saved as ${existing.sku}.` : `${card.name} loaded. Confirm its condition and finish.` : ""}</span>
  </section>;
}
