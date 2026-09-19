import qrcode from "qrcode-generator";

export const MAX_SKU_BATCH = 100;
export const MAX_LABEL_COPIES = 100;
export const MAX_LABELS_PER_PRINT = 1_000;

export type SkuLabel = { sku: string; name: string };

type FillRandomBytes = (bytes: Uint8Array) => void;

export function normalizeSkuPrefix(prefix: string): string {
  const normalized = prefix.trim().toUpperCase();
  if (!/^[A-Z0-9]{0,4}$/.test(normalized)) {
    throw new Error("Use up to 4 letters or numbers for the SKU prefix.");
  }
  return normalized;
}

export function isGeneratedSku(value: unknown): value is string {
  return typeof value === "string" && /^(?:[A-Z0-9]{1,4}-)?[1-9][0-9]{9}$/.test(value);
}

/** Unique within this batch and the supplied exclusions; does not reserve inventory. */
export function generateSkuBatch(
  count: number,
  excluded: Iterable<string> = [],
  prefix = "DEFY",
  fillRandomBytes: FillRandomBytes = (bytes) => {
    globalThis.crypto.getRandomValues(bytes);
  },
): string[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_SKU_BATCH) {
    throw new Error(`Generate between 1 and ${MAX_SKU_BATCH} SKUs at a time.`);
  }
  const normalizedPrefix = normalizeSkuPrefix(prefix);
  const used = new Set(excluded);
  const result: string[] = [];
  const bytes = new Uint8Array(10);
  // Bounded even if a supplied source or browser random provider malfunctions.
  const maxAttempts = count * 20 + 100;
  for (let attempts = 0; attempts < maxAttempts && result.length < count; attempts++) {
    fillRandomBytes(bytes);
    // Rejection sampling avoids bias when mapping 256 byte values to 9 or 10 digits.
    if (bytes[0] >= 252 || bytes.subarray(1).some((value) => value >= 250)) continue;
    let digits = String(1 + bytes[0] % 9);
    for (let index = 1; index < bytes.length; index++) digits += bytes[index] % 10;
    const sku = normalizedPrefix ? `${normalizedPrefix}-${digits}` : digits;
    if (used.has(sku)) continue;
    used.add(sku);
    result.push(sku);
  }
  if (result.length !== count) {
    throw new Error("Could not generate enough unique SKUs. Please try again.");
  }
  return result;
}

/** Version 1 has 21 modules, with the required four-module quiet zone on every side. */
export function skuQrSvg(value: string): string {
  if (!isGeneratedSku(value)) throw new Error("Use a generated SKU for the QR label.");
  const code = qrcode(1, "Q");
  code.addData(value, "Alphanumeric");
  code.make();
  return code.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function createSkuLabelDocument(labels: readonly SkuLabel[], copies: number): string {
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_LABEL_COPIES) {
    throw new Error(`Print between 1 and ${MAX_LABEL_COPIES} copies per SKU.`);
  }
  if (labels.length < 1 || labels.length > MAX_SKU_BATCH) {
    throw new Error(`Print between 1 and ${MAX_SKU_BATCH} SKUs at a time.`);
  }
  if (labels.length * copies > MAX_LABELS_PER_PRINT) {
    throw new Error(`Print no more than ${MAX_LABELS_PER_PRINT.toLocaleString("en-US")} labels at a time.`);
  }
  const pages = labels.flatMap(({ sku, name }) => {
    const svg = skuQrSvg(sku);
    const displayName = Array.from(name.trim().replace(/\s+/g, " ")).slice(0, 48).join("");
    const label = `<section class="label"><div class="qr">${svg}</div><div class="details"><div class="brand"><img src="/defy-tcg-label-logo.png" alt="" width="160" height="160"><span>Defy TCG</span></div>${displayName ? `<div class="name">${escapeHtml(displayName)}</div>` : ""}<div class="sku">${escapeHtml(sku)}</div></div></section>`;
    return Array<string>(copies).fill(label);
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Defy SKU labels</title>
<style>
@page { size: 38mm 13mm; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { width: 38mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.label { width: 38mm; height: 13mm; padding: 1mm; display: flex; align-items: center; gap: 1mm; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
.label + .label { break-before: page; page-break-before: always; }
.qr { width: 11mm; height: 11mm; flex: 0 0 11mm; }
.qr svg { display: block; width: 11mm; height: 11mm; shape-rendering: crispEdges; }
.details { width: 24mm; min-width: 0; display: grid; gap: .25mm; font-family: Arial, sans-serif; }
.brand { display: flex; align-items: center; gap: 1mm; height: 4mm; font: 700 7.5pt/1 Arial, sans-serif; white-space: nowrap; }
.brand img { display: block; width: 4mm; height: 4mm; object-fit: contain; flex-shrink: 0; }
.name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 5.5pt; line-height: 2mm; max-height: 4mm; overflow: hidden; overflow-wrap: anywhere; }
.sku { font: 700 7pt/2.5mm "Courier New", monospace; white-space: nowrap; }
</style></head><body>
${pages}
</body></html>`;
}
