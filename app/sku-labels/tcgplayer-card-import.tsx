"use client";

import Image from "next/image";
import { useRef, useState, type FormEvent } from "react";
import { LABEL_CONDITIONS, LABEL_FINISHES } from "@/lib/sku-label-inventory";
import type { TcgplayerCardLookup } from "@/lib/tcgplayer-card";

type TcgplayerCardImportProps = {
  disabled: boolean;
  onAdd: (card: TcgplayerCardLookup, condition: string, finish: string) => Promise<void>;
};

export default function TcgplayerCardImport({ disabled, onAdd }: TcgplayerCardImportProps) {
  const [url, setUrl] = useState("");
  const [card, setCard] = useState<TcgplayerCardLookup | null>(null);
  const [condition, setCondition] = useState<string>("Near Mint");
  const [finish, setFinish] = useState("");
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const locked = disabled || loading || adding;

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || working.current || !url.trim()) return;
    working.current = true;
    setLoading(true);
    setError("");
    setCard(null);
    setFinish("");
    setImageFailed(false);
    try {
      const response = await fetch("/api/sku-labels/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (response.redirected || response.status === 401) throw new Error("Your session expired. Sign in again before loading a card.");
      const result = await response.json() as { card?: TcgplayerCardLookup; error?: string };
      if (!response.ok || !result.card) throw new Error(result.error || "Could not load this card. Check the TCGplayer product link and try again.");
      setCard(result.card);
      setCondition("Near Mint");
      setFinish(result.card.finishes.length === 1 ? result.card.finishes[0] : "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this card. Please try again.");
    } finally {
      working.current = false;
      setLoading(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || working.current || !card) return;
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
          onChange={(event) => { setUrl(event.target.value); setCard(null); setFinish(""); setError(""); }} />
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
        <form onSubmit={(event) => void add(event)}>
          <fieldset disabled={locked} className="sku-import-variant" aria-label="Card variant">
            <label>Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}>{LABEL_CONDITIONS.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Finish
              {card.finishes.length ? <select required value={finish} onChange={(event) => setFinish(event.target.value)}>
                <option value="" disabled>Choose finish</option>
                {card.finishes.map((value) => <option key={value}>{value}</option>)}
              </select> : <><input required maxLength={80} value={finish} list="sku-import-finishes" placeholder="Choose or enter a finish" onChange={(event) => setFinish(event.target.value)} /><datalist id="sku-import-finishes">{LABEL_FINISHES.map((value) => <option key={value} value={value} />)}</datalist><small>Confirm the finish printed on your card.</small></>}
            </label>
          </fieldset>
          <button className="primary-button sku-import-add" disabled={locked || !finish.trim()}>{adding ? "Saving QR…" : "Save QR & add to batch"}<span aria-hidden="true">↗</span></button>
        </form>
      </div>
    </div> : null}
    {error ? <p className="sku-inline-error" role="alert">{error}</p> : null}
    <span className="sku-import-announcement" role="status">{loading ? "Loading card details." : card ? `${card.name} loaded. Confirm its condition and finish.` : ""}</span>
  </section>;
}
