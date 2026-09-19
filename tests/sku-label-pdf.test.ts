import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { createSkuLabelPdf, wrapSkuLabelName } from "../lib/sku-label-pdf.ts";

const mm = 72 / 25.4;
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const loadLogo = async () => pixel;

async function pageContent(bytes: Uint8Array, pageIndex = 0) {
  const document = await PDFDocument.load(bytes);
  const streams = document.getPage(pageIndex).node.Contents();
  assert.ok(streams instanceof PDFArray);
  return Array.from({ length: streams.size() }, (_, index) => {
    const stream = document.context.lookup(streams.get(index));
    assert.ok(stream instanceof PDFRawStream);
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }).join("\n");
}

test("PDF labels have one exact 38 by 13 mm page per copy and request actual-size printing", async () => {
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "" }, { sku: "RB-1000000000", name: "" }], 3, undefined, loadLogo);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 6);
  for (const page of document.getPages()) {
    assert.ok(Math.abs(page.getWidth() - 38 * mm) < 0.00001);
    assert.ok(Math.abs(page.getHeight() - 13 * mm) < 0.00001);
  }
  assert.equal(document.catalog.getOrCreateViewerPreferences().getPrintScaling(), "None");
  assert.match(await pageContent(bytes, 0), new RegExp(Buffer.from("DEFY-1234567890").toString("hex").toUpperCase()));
  assert.match(await pageContent(bytes, 2), new RegExp(Buffer.from("DEFY-1234567890").toString("hex").toUpperCase()));
  assert.match(await pageContent(bytes, 3), new RegExp(Buffer.from("RB-1000000000").toString("hex").toUpperCase()));
  for (let page = 0; page < 6; page++) {
    assert.match(await pageContent(bytes, page), new RegExp(Buffer.from("Defy TCG").toString("hex").toUpperCase()));
  }
});

test("PDF contains vector QR modules inside the physical quiet zone, not a raster barcode", async () => {
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "" }], 1, undefined, loadLogo);
  const content = await pageContent(bytes);
  const rectangles = content.split("\nQ\n").filter((section) => section.includes("0 0 m\n") && section.includes("\nf"));
  const translations = rectangles.map((rectangle) => /1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(rectangle)!);
  assert.ok(translations.length > 100);
  const moduleSize = 11 * mm / 29;
  for (const [, x, y] of translations) {
    assert.ok(Number(x) >= mm + 4 * moduleSize - 0.00001);
    assert.ok(Number(x) + moduleSize <= mm + 25 * moduleSize + 0.00001);
    assert.ok(Number(y) >= mm + 4 * moduleSize - 0.00001);
    assert.ok(Number(y) + moduleSize <= mm + 25 * moduleSize + 0.00001);
  }
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict).keys().length, 1, "only the logo is rasterized");
});

test("Unicode names reach the rasterizer intact, are normalized, and reuse one embedded image across copies", async () => {
  const names: string[] = [];
  const bytes = await createSkuLabelPdf([
    { sku: "DEFY-1234567890", name: "  蒼き眼の白龍 \n 🃏  " },
    { sku: "DEFY-1234567891", name: "蒼き眼の白龍 🃏" },
  ], 2, async (name) => { names.push(name); return { png: pixel, heightMm: 2 }; }, loadLogo);
  assert.deepEqual(names, ["蒼き眼の白龍 🃏"]);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 4);
  assert.match(await pageContent(bytes), /\/Image-[\d]+ Do/);
  assert.equal(document.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict).keys().length, 2);
});

test("PDF embeds the supplied brand asset once for the complete job and fits the longest details block", async () => {
  let loads = 0;
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "Long name" }], 3,
    async () => ({ png: pixel, heightMm: 4 }),
    async () => { loads++; return readFile(new URL("../public/defy-tcg-label-logo.png", import.meta.url)); });
  assert.equal(loads, 1);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 3);
  const content = await pageContent(bytes);
  const imagePositions = content.split("\nQ\n").filter((section) => section.includes(" Do"))
    .map((image) => /1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(image)!);
  assert.equal(imagePositions.length, 2);
  assert.ok(Math.abs(Number(imagePositions[0][1]) - 13 * mm) < 0.00001);
  assert.ok(Math.abs(Number(imagePositions[0][2]) - 8 * mm) < 0.00001, "4 mm brand row ends at the 12 mm inset");
  assert.ok(Math.abs(Number(imagePositions[1][2]) - 3.75 * mm) < 0.00001, "name fits between brand and SKU");
});

test("PDF reports a clear error when the brand asset cannot load", async () => {
  await assert.rejects(createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "" }], 1, undefined,
    async () => { throw new Error("Network unavailable"); }), /Defy TCG logo could not load/);
});

test("name wrapping handles words and long Unicode names with at most two fitting lines", () => {
  const measure = (value: string) => Array.from(value).length;
  assert.deepEqual(wrapSkuLabelName("Ahri Spirit Blossom", 12, measure), ["Ahri Spirit", "Blossom"]);
  assert.deepEqual(wrapSkuLabelName("🃏".repeat(30), 8, measure), ["🃏".repeat(8), `${"🃏".repeat(7)}…`]);
  assert.deepEqual(wrapSkuLabelName("A long name with many words", 8, measure), ["A long", "name wi…"]);
  assert.deepEqual(wrapSkuLabelName("Short", 8, measure), ["Short"]);
});

test("PDF validates every label and job limit before rendering names", async () => {
  const label = { sku: "DEFY-1234567890", name: "Name" };
  const unexpectedRender = async () => { assert.fail("invalid jobs must not render"); };
  for (const copies of [0, -1, 1.5, 101, Number.NaN]) {
    await assert.rejects(createSkuLabelPdf([label], copies, unexpectedRender), /between 1 and 100 copies/);
  }
  await assert.rejects(createSkuLabelPdf([], 1, unexpectedRender), /between 1 and 100 SKUs/);
  await assert.rejects(createSkuLabelPdf(Array(101).fill(label), 1, unexpectedRender), /between 1 and 100 SKUs/);
  await assert.rejects(createSkuLabelPdf(Array(11).fill(label), 100, unexpectedRender), /no more than 1,000/);
  await assert.rejects(createSkuLabelPdf([{ ...label, sku: "bad" }], 1, unexpectedRender), /generated SKUs/);
});
