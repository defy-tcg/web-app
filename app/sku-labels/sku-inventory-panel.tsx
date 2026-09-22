"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { LABEL_CONDITIONS, LABEL_FINISHES, validateInventoryLabels } from "@/lib/sku-label-inventory";
import { isGeneratedSku } from "@/lib/sku-labels";
import { TCG_GAME_OPTIONS } from "@/lib/tcg-games";
import { EMPTY_SKU_INVENTORY_DRAFT as emptyDraft, type SkuInventoryDraft as Draft, type SkuDraftLabel as Label } from "@/lib/sku-label-draft";
import ShopifyLinkStatus, { isShopifyLabelLink, pendingShopifyLink, type ShopifyLabelLink } from "./shopify-link-status";

export type SavedSkuProduct = Label & {
  id: number; productType: string; game: string; setName: string; cardNumber: string;
  condition: string; finish: string; quantity: number; costCents: number;
  listPriceCents: number; location: string; tcgplayerId: number | null;
};
const DRAFT_KEY = "defy-qr-sku-inventory-drafts:v1";

function productDraft(product: SavedSkuProduct): Draft {
  return { game: product.game, setName: product.setName, cardNumber: product.cardNumber,
    condition: product.condition, finish: product.finish, quantity: String(product.quantity),
    cost: (product.costCents / 100).toFixed(2), price: (product.listPriceCents / 100).toFixed(2),
    location: product.location, tcgplayerId: product.tcgplayerId ? String(product.tcgplayerId) : "" };
}

function cents(value: string, field: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error(`${field} must be a dollar amount with up to two decimal places.`);
  return Math.round(Number(value) * 100);
}

export default function SkuInventoryPanel({ labels, products, disabled, canPrint, shopifyLinks, linkingSkus, onRetryShopify, onSavingChange, onLoadingChange, onInventoryLoaded, onSaved, onLoad, onDraftChange }: {
  labels: Label[]; products: SavedSkuProduct[]; disabled: boolean; canPrint: boolean;
  shopifyLinks: Record<string, ShopifyLabelLink>; linkingSkus: string[];
  onRetryShopify: (sku: string) => void;
  onSavingChange: (busy: boolean) => void;
  onLoadingChange: (busy: boolean) => void;
  onInventoryLoaded: (products: SavedSkuProduct[]) => void;
  onSaved: (products: SavedSkuProduct[], createdCount: number, existingCount: number, links: ShopifyLabelLink[]) => void;
  onLoad: (product: SavedSkuProduct) => void;
  onDraftChange: (sku: string, draft: Draft) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [libraryError, setLibraryError] = useState("");
  const [warning, setWarning] = useState("");
  const submitting = useRef(false);
  const refreshSequence = useRef(0);
  const details = useRef(new Map<string, HTMLDetailsElement>());

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    onLoadingChange(true);
    setLibraryError("");
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to load saved labels." : "Saved labels could not be loaded. Try Refresh.");
      const data = await response.json() as { products: SavedSkuProduct[] };
      if (!Array.isArray(data.products)) throw new Error("Saved labels could not be loaded. Try Refresh.");
      if (sequence !== refreshSequence.current) return;
      const saved = data.products.filter((product) => product.productType === "Single" && isGeneratedSku(product.sku));
      onInventoryLoaded(saved);
    } catch (caught) {
      if (sequence === refreshSequence.current) setLibraryError(caught instanceof Error ? caught.message : "Saved labels could not be loaded.");
    } finally { if (sequence === refreshSequence.current) { setLoading(false); onLoadingChange(false); } }
  }, [onInventoryLoaded, onLoadingChange]);

  useEffect(() => {
    let restored: Record<string, Draft> = {};
    let notice = "";
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { version?: number; drafts?: Record<string, unknown> };
        if (parsed.version !== 1 || !parsed.drafts || typeof parsed.drafts !== "object") throw new Error("Invalid drafts");
        restored = Object.fromEntries(Object.entries(parsed.drafts).filter(([sku, draft]) => isGeneratedSku(sku) && draft && typeof draft === "object" &&
          Object.keys(emptyDraft).every((key) => typeof (draft as Record<string, unknown>)[key] === "string")).slice(-100)) as Record<string, Draft>;
      }
    } catch { notice = "Card details could not be restored from this browser. Saved inventory is still available below."; }
    startTransition(() => { setDrafts(restored); setWarning(notice); setReady(true); void refresh(); });
  }, [refresh]);

  function update(sku: string, key: keyof Draft, value: string) {
    const next = { ...drafts, [sku]: { ...(labels.find((label) => label.sku === sku)?.inventory ?? drafts[sku] ?? emptyDraft), [key]: value } };
    setDrafts(next);
    onDraftChange(sku, next[sku]);
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, drafts: Object.fromEntries(Object.entries(next).slice(-100)) }));
      setWarning("");
    } catch { setWarning("This browser cannot keep draft card details. Save to Inventory before leaving."); }
  }

  async function save() {
    if (submitting.current || loading || disabled || !ready || !canPrint || !labels.length) return;
    setError("");
    try {
      // Include saved cards so a prior Shopify failure can be repaired without a new SKU or stock receipt.
      const inputs = labels.map((label) => {
        const product = products.find((product) => product.sku === label.sku);
        if (product) return validateInventoryLabels({ labels: [product] })[0];
        const draft = label.inventory ?? drafts[label.sku] ?? emptyDraft;
        try {
          return validateInventoryLabels({ labels: [{ ...label, ...draft,
            quantity: draft.quantity.trim() ? Number(draft.quantity) : NaN,
            costCents: cents(draft.cost, "Cost"), listPriceCents: cents(draft.price, "Sell price"),
            tcgplayerId: draft.tcgplayerId.trim() ? Number(draft.tcgplayerId) : null,
          }] })[0];
        } catch (caught) {
          const element = details.current.get(label.sku);
          if (element) { element.open = true; element.scrollIntoView({ behavior: "smooth", block: "center" }); }
          throw new Error(`${label.sku}: ${caught instanceof Error ? caught.message : "Check the card details."}`);
        }
      });
      const normalized = validateInventoryLabels({ labels: inputs });
      submitting.current = true;
      refreshSequence.current += 1;
      setSaving(true);
      onSavingChange(true);
      const response = await fetch("/api/sku-labels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ labels: normalized }) });
      const data = await response.json() as { products?: SavedSkuProduct[]; createdCount?: number; existingCount?: number; shopify?: unknown[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Inventory could not be saved. Your draft is still here; try again.");
      if (!Array.isArray(data.products) || data.products.length !== labels.length ||
        data.products.some((product, index) => product.sku !== labels[index].sku) ||
        typeof data.createdCount !== "number" || typeof data.existingCount !== "number") {
        throw new Error("The save response could not be confirmed. Refresh saved labels or retry with these same SKUs.");
      }
      const returned = data.products;
      const combined = [...returned, ...products.filter((product) => !returned.some((saved) => saved.sku === product.sku))];
      onInventoryLoaded(combined);
      const links = returned.map((product) => {
        const link = data.shopify?.find((value) => isShopifyLabelLink(value) && value.sku === product.sku);
        return isShopifyLabelLink(link) ? link : pendingShopifyLink(product.sku);
      });
      onSaved(labels.map((label) => combined.find((product) => product.sku === label.sku)!), data.createdCount, data.existingCount, links);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Inventory could not be saved. Retry with these same SKUs.");
    } finally {
      submitting.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  }

  const query = search.trim().toLowerCase();
  const allSaved = labels.length > 0 && labels.every((label) => products.some((product) => product.sku === label.sku));
  const allLinked = allSaved && labels.every((label) => shopifyLinks[label.sku]?.status === "ready");
  const matches = products.filter((product) => [product.sku, product.name, product.game, product.setName, product.cardNumber].some((value) => value.toLowerCase().includes(query)));
  return <>
    {labels.length > 0 && <section className="sku-panel sku-inventory" aria-labelledby="sku-inventory-title">
      <div className="sku-panel-heading"><span className="sku-step">03</span><div><h2 id="sku-inventory-title">{allSaved ? "Saved card details" : "Save your singles"}</h2><p>{allSaved ? "Keep the original QR and check its Shopify POS link below." : "One SKU per card variant. Saving also links its QR to Shopify POS."}</p></div></div>
      <div className="sku-inventory-cards">{labels.map((label, index) => {
        const product = products.find((item) => item.sku === label.sku);
        const draft = product ? productDraft(product) : label.inventory ?? drafts[label.sku] ?? emptyDraft;
        const field = (key: keyof Draft, title: string, options: { type?: string; maxLength?: number; min?: number; max?: number; step?: string } = {}) =>
          <label>{title}<input aria-label={`${title} for ${label.sku}`} {...options} value={draft[key]} onChange={(event) => update(label.sku, key, event.target.value)} /></label>;
        return <details className="sku-inventory-card" key={label.sku} open={index === 0 ? true : undefined} ref={(element) => { if (element) details.current.set(label.sku, element); else details.current.delete(label.sku); }}>
          <summary><span><strong>{label.name || `Card ${index + 1}`}</strong><code>{label.sku}</code></span><span className={`sku-save-status${product ? " is-saved" : ""}`}>{product ? "Saved" : "Draft"}</span></summary>
          <fieldset className="sku-inventory-fields" disabled={disabled || saving || Boolean(product)} aria-label={`Inventory details for ${label.sku}`}>
            <label>Game<select aria-label={`Game for ${label.sku}`} value={draft.game} onChange={(event) => update(label.sku, "game", event.target.value)}><option value="">Choose a game</option>{TCG_GAME_OPTIONS.map((game) => <option key={game.name} value={game.name}>{game.label}</option>)}</select></label>
            {field("setName", "Set name", { maxLength: 120 })}
            {field("cardNumber", "Card number", { maxLength: 40 })}
            <label>Condition<select aria-label={`Condition for ${label.sku}`} value={draft.condition} onChange={(event) => update(label.sku, "condition", event.target.value)}>{LABEL_CONDITIONS.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label>Finish<input aria-label={`Finish for ${label.sku}`} list="sku-finish-presets" maxLength={80} value={draft.finish} onChange={(event) => update(label.sku, "finish", event.target.value)} /><small>Keep the exact finish or edition for this card.</small></label>
            {field("quantity", product ? "Defy inventory record" : "Starting quantity", { type: "number", min: 0, max: 100000, step: "1" })}
            {field("cost", "Cost per card ($)", { type: "number", min: 0, max: 1000000, step: "0.01" })}
            {field("price", product ? "Defy recorded price ($)" : "Sell price ($)", { type: "number", min: 0, max: 1000000, step: "0.01" })}
            {field("location", "Location", { maxLength: 80 })}
            {field("tcgplayerId", "TCGplayer ID (optional)", { type: "number", min: 1, max: 2147483647, step: "1" })}
          </fieldset>
          {product && <p className="sku-print-help">Already saved. Use Add stock beside the label preview to receive more cards. Reprinting keeps its original SKU and adds no stock. The fields above show the original Defy inventory record; the live available count comes from Shopify.</p>}
          <ShopifyLinkStatus sku={label.sku} link={shopifyLinks[label.sku]} saved={Boolean(product)} busy={saving || linkingSkus.includes(label.sku)} disabled={disabled || saving} onRetry={onRetryShopify} />
        </details>;
      })}</div>
      <datalist id="sku-finish-presets">{LABEL_FINISHES.map((value) => <option key={value} value={value} />)}</datalist>
      <div className="sku-save-bar"><div><strong>{allSaved ? "Your QR codes are saved." : "Save first. Keep the same SKU."}</strong><p>{allSaved ? "The same QR is used in Defy and Shopify POS. Linking again does not add stock." : "Starting quantity transfers to Shopify once. Copies per SKU only controls printed labels."}</p></div><button className="primary-button" disabled={!ready || loading || disabled || saving || !canPrint} onClick={() => void save()}>{saving ? "Saving & linking Shopify…" : allLinked ? "Print saved labels" : allSaved ? "Link Shopify & print" : "Save to Inventory & Print"}</button></div>
      {error && <p className="sku-inline-error" role="alert">{error}</p>}
      {warning && <p className="sku-storage-warning" role="status">{warning}</p>}
    </section>}
    <section className="sku-panel sku-library" aria-labelledby="sku-library-title">
      <header className="sku-batch-heading"><div><p className="eyebrow">SAVED IN DEFY INVENTORY</p><h2 id="sku-library-title">Saved custom labels <span className="sku-library-count">{products.length}</span></h2></div><button className="secondary-button" disabled={loading || saving || disabled} onClick={() => void refresh()}>{loading ? "Loading…" : "Refresh"}</button></header>
      <p className="sku-print-help">Find a saved single and load its original SKU to print again, from any signed-in device.</p>
      <label className="sku-library-search">Search saved labels<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Card name, SKU, set or card number" /></label>
      {libraryError && <p className="sku-inline-error" role="alert">{libraryError}</p>}
      {!loading && !libraryError && !matches.length && <p className="sku-library-empty">{products.length ? "No saved labels match your search." : "Save your first single above. It will appear here for reprints."}</p>}
      <div className="sku-library-list">{matches.slice(0, 100).map((product) => <article className="sku-library-row" key={product.id}>
        <div><strong>{product.name}</strong><code>{product.sku}</code><p>{product.game} · {product.setName} · {product.cardNumber} · {product.condition} · {product.finish}</p><ShopifyLinkStatus sku={product.sku} link={shopifyLinks[product.sku]} busy={linkingSkus.includes(product.sku)} disabled={disabled || saving} onRetry={onRetryShopify} /></div>
        <span className="sku-stock">{shopifyLinks[product.sku]?.status === "ready" && typeof shopifyLinks[product.sku]?.availableQuantity === "number" ? shopifyLinks[product.sku].availableQuantity : product.quantity}<small>{shopifyLinks[product.sku]?.status === "ready" && typeof shopifyLinks[product.sku]?.availableQuantity === "number" ? "Shopify stock" : "Defy record"}</small></span><button className="secondary-button" disabled={disabled || saving} onClick={() => onLoad(product)}>Load label</button>
      </article>)}</div>
      {matches.length > 100 && <p className="sku-print-help">Showing the first 100 matches. Search to narrow the list.</p>}
    </section>
  </>;
}
