"use client";

import Image from "next/image";
import Link from "next/link";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { generateSkuBatch, isGeneratedSku, normalizeSkuPrefix, skuQrSvg } from "@/lib/sku-labels";
import { canonicalInventoryLabelFinish, inventoryLabelIdentityText, inventoryLabelVariantKey } from "@/lib/sku-label-inventory";
import { EMPTY_SKU_INVENTORY_DRAFT, type SkuDraftLabel } from "@/lib/sku-label-draft";
import type { TcgplayerCardLookup } from "@/lib/tcgplayer-card";
import { canonicalizeGame } from "@/lib/tcg-games";
import ThemeToggle from "../theme-toggle";
import SkuInventoryPanel, { type SavedSkuProduct } from "./sku-inventory-panel";
import TcgplayerCardImport from "./tcgplayer-card-import";

type Label = SkuDraftLabel;
type SavedBatch = { version: 1; labels: Label[] };
const STORAGE_KEY = "defy-qr-sku-labels:v1";
const PENDING_RESERVATIONS_KEY = "defy-qr-sku-pending-reservations:v1";
const example: Label = { sku: "DEFY-1234567890", name: "Your single goes here" };

function readSavedBatch(key = STORAGE_KEY): Label[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const saved = JSON.parse(raw) as SavedBatch;
  if (saved.version !== 1 || !Array.isArray(saved.labels) || saved.labels.length > 100 ||
    saved.labels.some((label) => !label || !isGeneratedSku(label.sku) || typeof label.name !== "string" || label.name.length > 1000 ||
      (label.inventory !== undefined && (!label.inventory || typeof label.inventory !== "object" ||
        Object.keys(EMPTY_SKU_INVENTORY_DRAFT).some((key) => typeof label.inventory?.[key as keyof typeof EMPTY_SKU_INVENTORY_DRAFT] !== "string")))) ||
    new Set(saved.labels.map((label) => label.sku)).size !== saved.labels.length) {
    throw new Error("Invalid saved batch");
  }
  if (key !== STORAGE_KEY) return saved.labels;
  // Older drafts kept details separately. Carry them into the batch before link matching.
  try {
    const stored = JSON.parse(localStorage.getItem("defy-qr-sku-inventory-drafts:v1") || "null") as { version?: number; drafts?: Record<string, unknown> } | null;
    if (stored?.version === 1 && stored.drafts) return saved.labels.map((label) => {
      const draft = stored.drafts?.[label.sku];
      if (label.inventory || !draft || typeof draft !== "object" ||
        Object.keys(EMPTY_SKU_INVENTORY_DRAFT).some((key) => typeof (draft as Record<string, unknown>)[key] !== "string")) return label;
      return { ...label, inventory: draft as NonNullable<Label["inventory"]> };
    });
  } catch { /* Existing draft validation in the inventory panel reports a storage warning. */ }
  return saved.labels;
}

type LinkedVariant = Pick<SavedSkuProduct, "name" | "game" | "setName" | "cardNumber" | "condition" | "finish" | "tcgplayerId">;

function sameLinkedVariant(left: LinkedVariant, right: LinkedVariant) {
  if (left.tcgplayerId && right.tcgplayerId && left.tcgplayerId !== right.tcgplayerId) return false;
  return inventoryLabelVariantKey(left) === inventoryLabelVariantKey(right) ||
    Boolean(left.tcgplayerId && left.tcgplayerId === right.tcgplayerId &&
      canonicalizeGame(left.game) === canonicalizeGame(right.game) &&
      inventoryLabelIdentityText(left.condition) === inventoryLabelIdentityText(right.condition) &&
      inventoryLabelIdentityText(canonicalInventoryLabelFinish(left.finish)) === inventoryLabelIdentityText(canonicalInventoryLabelFinish(right.finish)));
}

function draftMatchesVariant(label: Label, variant: LinkedVariant) {
  return Boolean(label.inventory && sameLinkedVariant({ ...label.inventory, name: label.name,
    tcgplayerId: Number(label.inventory.tcgplayerId) || null }, variant));
}

function isSavedProduct(value: unknown): value is SavedSkuProduct {
  if (!value || typeof value !== "object") return false;
  const product = value as Record<string, unknown>;
  return isGeneratedSku(product.sku) && product.productType === "Single" &&
    ["name", "game", "setName", "cardNumber", "condition", "finish", "location"].every((field) => typeof product[field] === "string") &&
    ["id", "quantity", "costCents", "listPriceCents"].every((field) => typeof product[field] === "number" && Number.isSafeInteger(product[field]) && Number(product[field]) >= 0) &&
    Number(product.id) > 0 && (product.tcgplayerId === null || (typeof product.tcgplayerId === "number" && Number.isSafeInteger(product.tcgplayerId) && product.tcgplayerId > 0));
}

function QrLabel({ label }: { label: Label }) {
  const svg = useMemo(() => skuQrSvg(label.sku), [label.sku]);
  const displayName = Array.from(label.name.trim().replace(/\s+/g, " ")).slice(0, 48).join("");
  return (
    <div className="sku-paper">
      <div className="sku-qr" role="img" aria-label={`QR code for ${label.sku}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="sku-paper-text">
        <div className="sku-paper-brand">Defy TCG - Redmond</div>
        {displayName && <strong>{displayName}</strong>}
        <code>{label.sku}</code>
      </div>
    </div>
  );
}

export default function SkuLabelsClient() {
  const [prefix, setPrefix] = useState("DEFY");
  const [name, setName] = useState("");
  const [count, setCount] = useState("1");
  const [copies, setCopies] = useState("1");
  const [labels, setLabels] = useState<Label[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [savedProducts, setSavedProducts] = useState<SavedSkuProduct[]>([]);
  const [printReady, setPrintReady] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const generated = useRef(new Set<string>());
  const pendingReservations = useRef<Label[]>([]);
  const generating = useRef(false);
  const downloadingPdf = useRef(false);
  const printDialog = useRef<HTMLDialogElement>(null);
  const savedSkus = useMemo(() => new Set(savedProducts.map((product) => product.sku)), [savedProducts]);
  const total = labels.length * Number(copies);
  const validCopies = Number.isInteger(Number(copies)) && Number(copies) >= 1 && Number(copies) <= 100;
  const canPrint = labels.length > 0 && validCopies && total <= 1000;
  const printLabels = useMemo(() => labels.map((label) => ({ ...label, name: Array.from(label.name.trim().replace(/\s+/g, " ")).slice(0, 48).join(""), svg: skuQrSvg(label.sku) })), [labels]);

  const inventoryLoaded = useCallback((products: SavedSkuProduct[]) => {
    setSavedProducts(products);
    setLabels((current) => current.map((label) => {
      const saved = products.find((product) => product.sku === label.sku);
      return saved ? { sku: saved.sku, name: saved.name } : label;
    }));
  }, []);

  useEffect(() => {
    if (printReady && !printDialog.current?.open) printDialog.current?.showModal();
  }, [printReady]);

  useEffect(() => {
    let saved: Label[] = [];
    let warning = "";
    try {
      saved = readSavedBatch();
      saved.forEach((label) => generated.current.add(label.sku));
    } catch {
      warning = "The last batch could not be restored. Download new labels to keep a copy.";
    }
    try {
      pendingReservations.current = readSavedBatch(PENDING_RESERVATIONS_KEY);
      pendingReservations.current.forEach((label) => generated.current.add(label.sku));
    } catch { /* Inventory lookup still finds a reservation if its response was lost. */ }
    startTransition(() => {
      setLabels(saved);
      setStorageWarning(warning);
      setReady(true);
    });
  }, []);

  function saveBatch(next: Label[]) {
    setLabels(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, labels: next } satisfies SavedBatch));
      setStorageWarning("");
    } catch {
      setStorageWarning("This browser could not save your batch. Download the CSV before leaving this page.");
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generating.current || inventoryBusy || !ready) return;
    setError("");
    setMessage("");
    try {
      const normalized = normalizeSkuPrefix(prefix);
      const amount = Number(count);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new Error("Choose 1 to 100 SKUs per batch.");
      generating.current = true;
      setBusy(true);
      // Read inventory only. This workspace never mounts the store's sheet-sync timers.
      const response = await fetch("/api/inventory", { cache: "no-store" });
      if (response.redirected) throw new Error("Your session expired. Sign in again before generating labels.");
      if (!response.ok) throw new Error(response.status === 401
        ? "Your session expired. Sign in again before generating labels."
        : "Inventory could not be checked for duplicate SKUs. Try again.");
      const data = await response.json() as { products?: { sku: string; barcode: string | null }[] };
      if (!Array.isArray(data.products) || data.products.some((product) => !product || typeof product.sku !== "string")) {
        throw new Error("Inventory could not be checked for duplicate SKUs. Try again.");
      }
      const excluded = new Set(generated.current);
      for (const product of data.products) {
        excluded.add(product.sku.trim().toUpperCase());
        if (product.barcode) excluded.add(product.barcode.trim().toUpperCase());
      }
      try { readSavedBatch().forEach((label) => excluded.add(label.sku)); } catch { /* Saving below reports unavailable storage. */ }
      const skus = generateSkuBatch(amount, excluded, normalized);
      skus.forEach((sku) => generated.current.add(sku));
      saveBatch(skus.map((sku) => ({ sku, name: name.trim() })));
      setPrefix(normalized);
      setMessage(`${skus.length} QR label${skus.length === 1 ? "" : "s"} ready. Each SKU was checked against current Defy inventory.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Labels could not be generated. Try again.");
    } finally {
      generating.current = false;
      setBusy(false);
    }
  }

  async function addLinkedCard(card: TcgplayerCardLookup, condition: string, finish: string) {
    if (generating.current || inventoryBusy || inventoryLoading || !ready) throw new Error("Wait for the current batch to finish.");
    generating.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      if (response.redirected) throw new Error("Your session expired. Sign in again before adding a card.");
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again before adding a card." : "Inventory could not be checked. Try again.");
      const data = await response.json() as { products?: (SavedSkuProduct & { barcode?: string | null })[] };
      if (!Array.isArray(data.products)) throw new Error("Inventory could not be checked. Try again.");
      const identity = { ...card, condition, finish, tcgplayerId: card.productId };
      const existing = data.products.find((product) => product.productType === "Single" &&
        sameLinkedVariant(product, identity));
      if (existing && !isGeneratedSku(existing.sku)) throw new Error(`This variant already uses SKU ${existing.sku}. Open Inventory to manage its stock or print its existing barcode.`);
      const inBatch = labels.find((label) => label.sku === existing?.sku || draftMatchesVariant(label, identity));
      if (!inBatch && labels.length >= 100) throw new Error("Clear the current batch before adding more than 100 SKUs. Saved QR codes stay in your library.");
      let storedLabels: Label[] = [];
      try { storedLabels = readSavedBatch(); } catch { /* Saving below reports unavailable storage. */ }
      let storedPending: Label[] = [];
      try { storedPending = readSavedBatch(PENDING_RESERVATIONS_KEY); } catch { /* The in-memory candidate remains available for retries. */ }
      const draft = [...labels, ...storedLabels, ...pendingReservations.current, ...storedPending].find((label) => draftMatchesVariant(label, identity));
      const excluded = new Set([...generated.current, ...labels.map((label) => label.sku)]);
      for (const product of data.products) {
        excluded.add(product.sku.trim().toUpperCase());
        if (product.barcode) excluded.add(product.barcode.trim().toUpperCase());
      }
      [...storedLabels, ...storedPending].forEach((label) => excluded.add(label.sku));
      const sku = existing?.sku ?? draft?.sku ?? generateSkuBatch(1, excluded, normalizeSkuPrefix(prefix))[0];
      generated.current.add(sku);
      const candidate: Label = { sku, name: card.name, inventory: {
        ...EMPTY_SKU_INVENTORY_DRAFT, game: card.game, setName: card.setName, cardNumber: card.cardNumber,
        condition, finish, tcgplayerId: String(card.productId),
      } };
      // Retain the proposed SKU before the request: a failed response must not cause a new QR on retry.
      pendingReservations.current = [...pendingReservations.current.filter((label) => !draftMatchesVariant(label, identity)), candidate].slice(-100);
      try {
        localStorage.setItem(PENDING_RESERVATIONS_KEY, JSON.stringify({ version: 1, labels: pendingReservations.current } satisfies SavedBatch));
      } catch { /* The candidate remains in memory; the server also reuses saved variants. */ }
      const reserved = await fetch("/api/sku-labels/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: { sku, name: card.name, game: card.game, setName: card.setName,
          cardNumber: card.cardNumber, condition, finish, tcgplayerId: card.productId,
          quantity: 0, costCents: 0, listPriceCents: 0 } }),
      });
      if (reserved.redirected || reserved.status === 401) throw new Error("Your session expired. Sign in again before saving the QR code.");
      const result = await reserved.json() as { product?: unknown; created?: boolean; error?: string };
      if (!reserved.ok) throw new Error(result.error || "The QR code could not be saved. Try again to keep the same SKU.");
      if (!isSavedProduct(result.product) || typeof result.created !== "boolean" || !sameLinkedVariant(result.product, identity)) {
        throw new Error("The saved QR code could not be confirmed. Try again to load its original SKU.");
      }
      // Another browser may have saved this variant first. Its confirmed original SKU wins.
      const product = result.product;
      generated.current.add(product.sku);
      setSavedProducts((current) => [...current.filter((saved) => saved.sku !== product.sku), product]);
      saveBatch([...labels.filter((label) => label.sku !== product.sku && !draftMatchesVariant(label, identity)), { sku: product.sku, name: product.name }]);
      pendingReservations.current = pendingReservations.current.filter((label) => !draftMatchesVariant(label, identity));
      try {
        localStorage.setItem(PENDING_RESERVATIONS_KEY, JSON.stringify({ version: 1, labels: pendingReservations.current } satisfies SavedBatch));
      } catch { /* A retained candidate is safe: a later retry returns the same saved product. */ }
      setMessage(result.created
        ? `${product.name} saved with permanent SKU ${product.sku}. Reprint it anytime from Saved labels. Starting stock is 0; set stock and prices in Inventory.`
        : `Loaded the original QR for ${product.name}: ${product.sku}. It stays in Saved labels. Stock and prices are unchanged.`);
    } finally {
      generating.current = false;
      setBusy(false);
    }
  }

  function savedForPrint(products: SavedSkuProduct[], createdCount: number, existingCount: number) {
    saveBatch(products.map(({ sku, name }) => ({ sku, name })));
    setError("");
    const confirmation = createdCount === 0 ? "Your QR labels are already saved. Reprinting keeps their original SKUs, stock, and prices unchanged."
      : `${createdCount} new single${createdCount === 1 ? "" : "s"} saved to inventory.${existingCount ? ` ${existingCount} already saved; stock and prices unchanged.` : ""}`;
    setMessage(confirmation);
    setPrintReady(confirmation);
  }

  function loadSavedLabel(product: SavedSkuProduct) {
    saveBatch([{ sku: product.sku, name: product.name }]);
    setCopies("1");
    setError("");
    setMessage(`Loaded ${product.sku}. Print or download its label below. Reprinting does not change stock.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function copySkus(values: string[]) {
    setError("");
    try {
      await navigator.clipboard.writeText(values.join("\n"));
      setMessage(values.length === 1 ? "SKU copied." : `${values.length} SKUs copied.`);
    } catch {
      setError("Clipboard access is unavailable. Select a SKU to copy it, or download the CSV.");
    }
  }

  function downloadCsv() {
    const cell = (value: string) => {
      const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const rows = ["SKU,Card name", ...labels.map((label) => [label.sku, label.name].map(cell).join(","))];
    const url = URL.createObjectURL(new Blob(["\uFEFF", rows.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "defy-singles-qr-skus.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("SKU list downloaded. Keep it with your card records.");
  }

  function print() {
    setError("");
    setMessage("Use paper width 38 mm across the roll and height 13 mm in the feed direction, at 100% / actual size. Sideways or split labels in Mac Chrome? Choose More settings → Print using system dialog (Option + Command + P), then select your 38 × 13 mm paper and Portrait with no additional rotation.");
    try {
      // Keep the print request in the click event and avoid unsupported popup windows.
      window.print();
    } catch (caught) {
      setError(caught instanceof Error ? `${caught.message} Use Download PDF to print this batch.` : "Printing is unavailable here. Use Download PDF to print this batch.");
    }
  }

  async function downloadPdf() {
    if (!canPrint || downloadingPdf.current) return;
    downloadingPdf.current = true;
    setPdfBusy(true);
    setError("");
    setMessage("");
    try {
      const { createSkuLabelPdf } = await import("@/lib/sku-label-pdf");
      const bytes = await createSkuLabelPdf(labels, Number(copies));
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "defy-singles-labels-38x13mm.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage("PDF ready. Open it in Preview, select your thermal printer and paper width 38 mm across the roll × height 13 mm in the feed direction. Use Portrait, no additional rotation, and 100% / actual size.");
    } catch (caught) {
      setError(caught instanceof Error ? `PDF could not be created: ${caught.message}` : "PDF could not be created. Try again.");
    } finally {
      downloadingPdf.current = false;
      setPdfBusy(false);
    }
  }

  return (
    <>
    <main className="sku-shell">
      <header className="sku-topbar">
        <Link href="/" className="sku-brand">
          <Image src="/defy-os-icon.png" alt="" width={38} height={38} />
          <span>defy<small>STORE OS</small></span>
        </Link>
        <div className="sku-top-actions"><Link href="/">← Back to store</Link><ThemeToggle /></div>
      </header>
      <div className="sku-main">
        <header className="sku-hero">
          <div><p className="eyebrow">SINGLES · LABEL STUDIO</p><h1>Make it yours.<br /><span>Scan it in.</span></h1>
            <p>Paste a TCGplayer card link to save its QR code in your shared library. Reuse the same SKU whenever you print it.</p>
          </div>
          <div className="sku-size-badge"><b>38 × 13</b><span>mm thermal label</span></div>
        </header>

        <TcgplayerCardImport disabled={!ready || busy || inventoryBusy || inventoryLoading || pdfBusy} onAdd={addLinkedCard} />

        <div className="sku-workbench">
          <section className="sku-panel sku-controls" aria-labelledby="sku-settings-title">
            <div className="sku-panel-heading"><span className="sku-step">01</span><div><h2 id="sku-settings-title">Customize your batch</h2><p>A short prefix, a random number, your card.</p></div></div>
            <form onSubmit={generate}>
              <label>SKU prefix<input disabled={inventoryBusy} value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} maxLength={4} pattern="[A-Za-z0-9]{0,4}" placeholder="DEFY" autoComplete="off" /><small>Up to 4 letters or numbers. Leave blank for numbers only.</small></label>
              <label>Card name (optional)<input disabled={inventoryBusy} value={name} onChange={(event) => setName(event.target.value)} maxLength={240} placeholder="e.g. Ahri · Spirit Blossom" /><small>Add a name for each card before saving to inventory.</small></label>
              <label>Number of SKUs<input disabled={inventoryBusy} type="number" inputMode="numeric" min={1} max={100} step={1} required value={count} onChange={(event) => setCount(event.target.value)} /><small>1–100 different SKUs per batch.</small></label>
              <button className="primary-button" disabled={!ready || busy || inventoryBusy || pdfBusy}>{busy ? "Checking inventory…" : labels.length ? "Generate new batch" : "Generate QR labels"}<span aria-hidden="true">↗</span></button>
              {labels.length > 0 && <p className="sku-replace-note">A new batch replaces the preview. Imported cards stay in Saved labels; save any manual drafts to keep them.</p>}
            </form>
          </section>

          <section className="sku-panel sku-preview-panel" aria-labelledby="sku-preview-title">
            <div className="sku-panel-heading"><span className="sku-step">02</span><div><h2 id="sku-preview-title">Small label. Ready to scan.</h2><p>Defy TCG - Redmond + QR + card name + SKU</p></div></div>
            <div className="sku-preview-stage"><div className="sku-dimension">← <span>38 mm</span> →</div><QrLabel label={labels[0] ?? example} /><p>{labels.length ? "First label preview · enlarged for clarity" : "Example label · generate a batch to preview yours"}</p></div>
            <div className="sku-print-settings">
              <label>Copies per SKU<input disabled={inventoryBusy || pdfBusy} type="number" inputMode="numeric" min={1} max={100} step={1} value={copies} onChange={(event) => setCopies(event.target.value)} /></label>
              <div className="sku-total"><strong>{canPrint ? total : "—"}</strong><span>labels to print</span></div>
              <div className="sku-print-actions">
                <button className="dark-button" disabled={!canPrint || busy || pdfBusy || inventoryBusy} onClick={() => void downloadPdf()}>{pdfBusy ? "Preparing PDF…" : "Download PDF"}</button>
                <button className="secondary-button" disabled={!canPrint || busy || pdfBusy || inventoryBusy} onClick={print}>Print {canPrint ? total : ""} label{total === 1 ? "" : "s"}</button>
              </div>
            </div>
            {(!validCopies || total > 1000) && <p className="sku-inline-error" role="alert">Use 1–100 copies per SKU, up to 1,000 labels per print job.</p>}
            <p className="sku-print-help"><strong>No print dialog?</strong> Download the PDF and open it in Preview or a browser to print. Your existing SKUs stay the same.</p>
            {labels.some((label) => !savedSkus.has(label.sku)) && <p className="sku-print-help">This batch contains drafts. Use <strong>Save to Inventory &amp; Print</strong> below to add their stock before printing.</p>}
            <p className="sku-print-help">Paper: <strong>38 mm wide across the roll × 13 mm high in the feed direction</strong>. Print at <strong>100% / actual size</strong> with no margins, headers, or footers. Scan one test label with a QR-capable scanner first.</p>
            <p className="sku-print-help"><strong>Sideways or split across labels?</strong> In Mac Chrome, choose <strong>More settings → Print using system dialog</strong> (Option + Command + P). Select your <strong>38 × 13 mm</strong> paper, <strong>Portrait</strong>, no additional rotation, and <strong>100%</strong> scale. The browser cannot force the printer’s orientation.</p>
          </section>
        </div>

        <div className="sku-feedback" aria-live="polite">{message && <p className="sku-success" role="status">{message}</p>}{error && <p className="sku-inline-error" role="alert">{error}</p>}{storageWarning && <p className="sku-storage-warning" role="status">{storageWarning}</p>}</div>

        {labels.length > 0 && <section className="sku-panel sku-batch" aria-labelledby="sku-batch-title">
          <header className="sku-batch-heading"><div><p className="eyebrow">YOUR CURRENT BATCH</p><h2 id="sku-batch-title">{labels.length} custom QR SKU{labels.length === 1 ? "" : "s"}</h2></div><div className="sku-batch-actions"><button className="secondary-button" onClick={() => void copySkus(labels.map((label) => label.sku))}>Copy SKUs</button><button className="secondary-button" onClick={downloadCsv}>Download CSV</button><button className="secondary-button" disabled={inventoryBusy || busy || pdfBusy} onClick={() => { saveBatch([]); setError(""); setMessage("Batch cleared. Your saved QR codes remain in Saved labels for future use."); }}>Clear batch</button></div></header>
          <div className="sku-label-list">{labels.map((label, index) => <article className="sku-label-row" key={label.sku}>
            <span className="sku-row-number">{String(index + 1).padStart(2, "0")}</span><QrLabel label={label} />
            <label>Card name {index + 1}<input disabled={inventoryBusy || busy || pdfBusy || savedSkus.has(label.sku)} maxLength={240} value={label.name} placeholder="Add a card name" onChange={(event) => saveBatch(labels.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />{savedSkus.has(label.sku) && <small>Saved card · edit its name in Inventory.</small>}</label>
            <button className="secondary-button" onClick={() => void copySkus([label.sku])} aria-label={`Copy SKU ${label.sku}`}>Copy SKU</button>
            {!savedSkus.has(label.sku) && <button className="secondary-button sku-remove-draft" disabled={inventoryBusy || busy || pdfBusy} aria-label={`Remove draft ${label.sku}`} onClick={() => saveBatch(labels.filter((item) => item.sku !== label.sku))}>Remove draft</button>}
          </article>)}</div>
        </section>}
        <SkuInventoryPanel labels={labels} products={savedProducts} disabled={busy || pdfBusy || inventoryBusy} canPrint={canPrint} onSavingChange={setInventoryBusy} onLoadingChange={setInventoryLoading} onInventoryLoaded={inventoryLoaded} onSaved={savedForPrint} onLoad={loadSavedLabel} onDraftChange={(sku, inventory) => saveBatch(labels.map((label) => label.sku === sku ? { ...label, inventory } : label))} />
        <footer className="sku-footer"><strong>Your SKU stays with the card.</strong><p>The QR contains the exact SKU saved in Defy inventory. Use the saved-label library to reprint it; adjust stock and prices in Inventory.</p><p>Cards imported from links are saved automatically with zero starting stock. Importing the same card, condition, and finish reuses its original QR. Manual drafts stay in this browser until you save them; downloading or printing alone does not save a draft.</p></footer>
      </div>
      <dialog ref={printDialog} className="sku-print-dialog" aria-labelledby="sku-print-dialog-title" onClose={() => setPrintReady("")}>
        <p className="eyebrow">SAVED TO DEFY INVENTORY</p><h2 id="sku-print-dialog-title">Your labels are ready.</h2><p>{printReady}</p><p>Print {total} label{total === 1 ? "" : "s"} on paper <strong>38 mm across the roll × 13 mm in the feed direction</strong>, at <strong>100% / actual size</strong>.</p>
        <div className="sku-dialog-actions"><button className="primary-button" onClick={() => { printDialog.current?.close(); print(); }}>Print labels</button><button className="secondary-button" onClick={() => { printDialog.current?.close(); void downloadPdf(); }}>Download PDF</button><button className="secondary-button" onClick={() => printDialog.current?.close()}>Print later</button></div>
        <p className="sku-print-help">If no print dialog appears, use Download PDF and open it in Preview. Your cards are already saved, even if you print later.</p>
      </dialog>
    </main>
    {ready && createPortal(
      <div className="sku-print-sheet" aria-hidden="true">
        {canPrint && printLabels.flatMap((label) => Array.from({ length: Number(copies) }, (_, copy) => (
          <section className="sku-thermal-label" key={`${label.sku}-${copy}`}>
            <div className="sku-thermal-qr" dangerouslySetInnerHTML={{ __html: label.svg }} />
            <div className="sku-thermal-details">
              <div className="sku-thermal-brand">Defy TCG - Redmond</div>
              {label.name.trim() && <div className="sku-thermal-name">{label.name.trim()}</div>}
              <div className="sku-thermal-code">{label.sku}</div>
            </div>
          </section>
        )))}
      </div>, document.body,
    )}
    </>
  );
}
