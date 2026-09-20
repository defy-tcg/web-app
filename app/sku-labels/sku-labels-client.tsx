"use client";

import Image from "next/image";
import Link from "next/link";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { generateSkuBatch, isGeneratedSku, normalizeSkuPrefix, skuQrSvg } from "@/lib/sku-labels";
import ThemeToggle from "../theme-toggle";
import SkuInventoryPanel, { type SavedSkuProduct } from "./sku-inventory-panel";

type Label = { sku: string; name: string };
type SavedBatch = { version: 1; labels: Label[] };
const STORAGE_KEY = "defy-qr-sku-labels:v1";
const example: Label = { sku: "DEFY-1234567890", name: "Your single goes here" };

function readSavedBatch(): Label[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const saved = JSON.parse(raw) as SavedBatch;
  if (saved.version !== 1 || !Array.isArray(saved.labels) || saved.labels.length > 100 ||
    saved.labels.some((label) => !label || !isGeneratedSku(label.sku) || typeof label.name !== "string" || label.name.length > 1000) ||
    new Set(saved.labels.map((label) => label.sku)).size !== saved.labels.length) {
    throw new Error("Invalid saved batch");
  }
  return saved.labels;
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
  const [savedProducts, setSavedProducts] = useState<SavedSkuProduct[]>([]);
  const [printReady, setPrintReady] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const generated = useRef(new Set<string>());
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

  function savedForPrint(products: SavedSkuProduct[], createdCount: number, existingCount: number) {
    saveBatch(products.map(({ sku, name }) => ({ sku, name })));
    setError("");
    const confirmation = `${createdCount} new single${createdCount === 1 ? "" : "s"} saved to inventory.${existingCount ? ` ${existingCount} already saved; stock and prices unchanged.` : ""}`;
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
    setMessage("If no printer dialog appears, choose Download PDF, open the file in Preview or your browser, and print it at actual size.");
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
      setMessage("PDF ready. Open the downloaded file in Preview or your browser, select your thermal printer, and print at 100% / actual size on 38 × 13 mm paper.");
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
            <p>Custom QR SKUs for your singles. Generate a batch, save the cards to inventory, and print your thermal labels.</p>
          </div>
          <div className="sku-size-badge"><b>38 × 13</b><span>mm thermal label</span></div>
        </header>

        <div className="sku-workbench">
          <section className="sku-panel sku-controls" aria-labelledby="sku-settings-title">
            <div className="sku-panel-heading"><span className="sku-step">01</span><div><h2 id="sku-settings-title">Customize your batch</h2><p>A short prefix, a random number, your card.</p></div></div>
            <form onSubmit={generate}>
              <label>SKU prefix<input disabled={inventoryBusy} value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} maxLength={4} pattern="[A-Za-z0-9]{0,4}" placeholder="DEFY" autoComplete="off" /><small>Up to 4 letters or numbers. Leave blank for numbers only.</small></label>
              <label>Card name (optional)<input disabled={inventoryBusy} value={name} onChange={(event) => setName(event.target.value)} maxLength={48} placeholder="e.g. Ahri · Spirit Blossom" /><small>Add a name for each card before saving to inventory.</small></label>
              <label>Number of SKUs<input disabled={inventoryBusy} type="number" inputMode="numeric" min={1} max={100} step={1} required value={count} onChange={(event) => setCount(event.target.value)} /><small>1–100 different SKUs per batch.</small></label>
              <button className="primary-button" disabled={!ready || busy || inventoryBusy || pdfBusy}>{busy ? "Checking inventory…" : labels.length ? "Generate new batch" : "Generate QR labels"}<span aria-hidden="true">↗</span></button>
              {labels.length > 0 && <p className="sku-replace-note">A new batch replaces the preview. Save this batch to inventory to keep it in your library.</p>}
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
            <p className="sku-print-help">Printer settings: <strong>38 × 13 mm</strong> paper, <strong>100% / actual size</strong>, no margins, headers, or footers. Scan a test label first. Use a QR-capable scanner; a 1D barcode scanner cannot read QR codes.</p>
          </section>
        </div>

        <div className="sku-feedback" aria-live="polite">{message && <p className="sku-success" role="status">{message}</p>}{error && <p className="sku-inline-error" role="alert">{error}</p>}{storageWarning && <p className="sku-storage-warning" role="status">{storageWarning}</p>}</div>

        {labels.length > 0 && <section className="sku-panel sku-batch" aria-labelledby="sku-batch-title">
          <header className="sku-batch-heading"><div><p className="eyebrow">YOUR CURRENT BATCH</p><h2 id="sku-batch-title">{labels.length} custom QR SKU{labels.length === 1 ? "" : "s"}</h2></div><div className="sku-batch-actions"><button className="secondary-button" onClick={() => void copySkus(labels.map((label) => label.sku))}>Copy SKUs</button><button className="secondary-button" onClick={downloadCsv}>Download CSV</button></div></header>
          <div className="sku-label-list">{labels.map((label, index) => <article className="sku-label-row" key={label.sku}>
            <span className="sku-row-number">{String(index + 1).padStart(2, "0")}</span><QrLabel label={label} />
            <label>Card name {index + 1}<input disabled={inventoryBusy || busy || pdfBusy || savedSkus.has(label.sku)} maxLength={48} value={label.name} placeholder="Add a card name" onChange={(event) => saveBatch(labels.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />{savedSkus.has(label.sku) && <small>Saved card · edit its name in Inventory.</small>}</label>
            <button className="secondary-button" onClick={() => void copySkus([label.sku])} aria-label={`Copy SKU ${label.sku}`}>Copy SKU</button>
          </article>)}</div>
        </section>}
        <SkuInventoryPanel labels={labels} disabled={busy || pdfBusy || inventoryBusy} canPrint={canPrint} onSavingChange={setInventoryBusy} onInventoryLoaded={inventoryLoaded} onSaved={savedForPrint} onLoad={loadSavedLabel} />
        <footer className="sku-footer"><strong>Your SKU stays with the card.</strong><p>The QR contains the exact SKU saved in Defy inventory. Use the saved-label library to reprint it; adjust stock and prices in Inventory.</p><p>Drafts stay in this browser until you save. Saving reserves each SKU and records starting stock once. Downloading or printing alone does not save inventory.</p></footer>
      </div>
      <dialog ref={printDialog} className="sku-print-dialog" aria-labelledby="sku-print-dialog-title" onClose={() => setPrintReady("")}>
        <p className="eyebrow">SAVED TO DEFY INVENTORY</p><h2 id="sku-print-dialog-title">Your labels are ready.</h2><p>{printReady}</p><p>Print {total} label{total === 1 ? "" : "s"} on <strong>38 × 13 mm</strong> paper at <strong>100% / actual size</strong>.</p>
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
