import assert from "node:assert/strict";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { createSkuLabelPdf, wrapSkuLabelName } from "../lib/sku-label-pdf.ts";

const mm = 72 / 25.4;
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "" }, { sku: "RB-1000000000", name: "" }], 3);
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
    assert.match(await pageContent(bytes, page), new RegExp(Buffer.from("Defy TCG - Redmond").toString("hex").toUpperCase()));
    assert.match(await pageContent(bytes, page), new RegExp(Buffer.from("Buy singles at defytcg.com").toString("hex").toUpperCase()));
  }
});

test("PDF contains vector QR modules inside the physical quiet zone, not a raster barcode", async () => {
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "" }], 1);
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
  assert.equal(document.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict).keys().length, 0, "blank-name labels contain no raster images");
});

test("Unicode names reach the rasterizer intact, are normalized, and reuse one embedded image across copies", async () => {
  const names: string[] = [];
  const bytes = await createSkuLabelPdf([
    { sku: "DEFY-1234567890", name: "  蒼き眼の白龍 \n 🃏  " },
    { sku: "DEFY-1234567891", name: "蒼き眼の白龍 🃏" },
  ], 2, async (name) => { names.push(name); return { png: pixel, heightMm: 2 }; });
  assert.deepEqual(names, ["蒼き眼の白龍 🃏"]);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 4);
  assert.match(await pageContent(bytes), /\/Image-[\d]+ Do/);
  assert.equal(document.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict).keys().length, 1);
});

test("PDF fits the longest details block with the Redmond heading and website footer", async () => {
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "Long name" }], 3,
    async () => ({ png: pixel, heightMm: 4 }));
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 3);
  const content = await pageContent(bytes);
  const imagePositions = content.split("\nQ\n").filter((section) => section.includes(" Do"))
    .map((image) => /1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(image)!);
  assert.equal(imagePositions.length, 1);
  assert.ok(Math.abs(Number(imagePositions[0][1]) - 13 * mm) < 0.00001);
  assert.ok(Math.abs(Number(imagePositions[0][2]) - 5.5 * mm) < 0.00001, "two-line name fits between heading and SKU above the website");
});

test("PDF condition rows survive long names, remain bold, and do not change QR modules", async () => {
  const conditions = ["LP", "MP", "HP", "DMG", "Mint", "NM"];
  const name = "A long card name ".repeat(10);
  const renderedNames: { name: string; maxLines?: number }[] = [];
  const bytes = await createSkuLabelPdf(conditions.map((condition) => ({
    sku: "DEFY-1234567890", name, condition,
  })), 2, async (displayName, maxLines) => {
    renderedNames.push({ name: displayName, maxLines });
    return { png: pixel, heightMm: maxLines === 1 ? 2 : 4 };
  });
  assert.deepEqual(renderedNames, [
    { name: name.slice(0, 48), maxLines: 1 },
    { name: name.slice(0, 48), maxLines: 2 },
  ], "the same card name gets separate one-line and two-line images");
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 12);
  const encoded = (text: string) => Buffer.from(text).toString("hex").toUpperCase();
  const expectedConditions = ["Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];
  const qrOperations = (content: string) => content.split("\nQ\n").filter((section) => section.includes("0 0 m\n") && section.includes("\nf"));
  const unconditionedContent = await pageContent(bytes, 8);
  for (let pageIndex = 0; pageIndex < 12; pageIndex++) {
    const page = document.getPage(pageIndex);
    assert.ok(Math.abs(page.getWidth() - 38 * mm) < 0.00001);
    assert.ok(Math.abs(page.getHeight() - 13 * mm) < 0.00001);
    const content = await pageContent(bytes, pageIndex);
    assert.deepEqual(qrOperations(content), qrOperations(unconditionedContent));
    assert.match(content, new RegExp(encoded("DEFY-1234567890")));
    assert.match(content, new RegExp(encoded("Defy TCG - Redmond")));
    assert.match(content, new RegExp(encoded("Buy singles at defytcg.com")));
    if (pageIndex < 8) {
      const condition = expectedConditions[Math.floor(pageIndex / 2)];
      const conditionText = content.split("BT\n").find((section) => section.includes(`<${encoded(condition)}> Tj`));
      assert.ok(conditionText, `${condition} remains visible independently of the long name`);
      assert.match(conditionText, /\/Helvetica-Bold-[\d]+ 5 Tf/);
      const image = content.split("\nQ\n").find((section) => section.includes(" Do"))!;
      const position = /1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(image)!;
      assert.ok(Math.abs(Number(position[2]) - 7.5 * mm) < 0.00001, "one-line name leaves the condition row above the SKU");
    } else {
      for (const condition of [...expectedConditions, "Mint", "Near Mint", "NM"]) {
        assert.doesNotMatch(content, new RegExp(`<${encoded(condition)}> Tj`));
      }
    }
  }
});

test("PDF includes a normalized Unicode set line once per card and preserves copies and QR modules", async () => {
  const calls: { value: string; maxLines?: number; typography?: { fontPt: number; lineMm: number } }[] = [];
  const label = { sku: "DEFY-1234567890", name: "バクフーン", setName: "  Neo Premium\n File 1  日本語 🃏 ", condition: "NM" };
  const bytes = await createSkuLabelPdf([label, { ...label, sku: "DEFY-1234567891" }], 2, async (value, maxLines, typography) => {
    calls.push({ value, maxLines, typography });
    return { png: pixel, heightMm: 2 };
  });
  assert.deepEqual(calls, [
    { value: "バクフーン", maxLines: 1, typography: { fontPt: 5.5, lineMm: 2 } },
    { value: "Neo Premium File 1 日本語 🃏", maxLines: 1, typography: { fontPt: 5.5, lineMm: 2 } },
  ]);
  const document = await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(), 4);
  const content = await pageContent(bytes);
  const images = content.split("\nQ\n").filter(section => section.includes(" Do"));
  assert.equal(images.length, 2, "name and set each have a Unicode-safe image, independent of standard PDF fonts");
  const y = images.map(image => Number(/1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(image)![2]) / mm);
  assert.ok(Math.abs(y[0] - 7.625) < 0.00001);
  assert.ok(Math.abs(y[1] - 5.375) < 0.00001);
  const plain = await createSkuLabelPdf([{ sku: label.sku, name: "" }], 1);
  const qrOperations = (value: string) => value.split("\nQ\n").filter(section => section.includes("0 0 m\n") && section.includes("\nf"));
  assert.deepEqual(qrOperations(content), qrOperations(await pageContent(plain)));
  const encoded = (value: string) => Buffer.from(value).toString("hex").toUpperCase();
  assert.match(content, new RegExp(encoded(label.sku)));
  assert.doesNotMatch(content, new RegExp(`<${encoded("Near Mint")}> Tj`));
});

test("long set and card names leave separate compact rows for bold condition, SKU, brand and footer", async () => {
  const name = "長いカードの名前🃏 ".repeat(20), setName = "とても長いセットの名前🃏 ".repeat(20);
  const calls: { value: string; maxLines?: number; typography?: { fontPt: number; lineMm: number } }[] = [];
  const bytes = await createSkuLabelPdf([{ sku: "DEFY-1234567890", name, setName, condition: "LP" }], 1,
    async (value, maxLines, typography) => {
      calls.push({ value, maxLines, typography });
      return { png: pixel, heightMm: typography!.lineMm };
    });
  assert.deepEqual(calls, [
    { value: Array.from(name.trim()).slice(0, 48).join(""), maxLines: 1, typography: { fontPt: 5, lineMm: 1.75 } },
    { value: setName.trim(), maxLines: 1, typography: { fontPt: 5, lineMm: 1.75 } },
  ]);
  const content = await pageContent(bytes);
  const images = content.split("\nQ\n").filter(section => section.includes(" Do"));
  assert.equal(images.length, 2);
  const positions = images.map(image => Number(/1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(image)![2]) / mm);
  assert.ok(Math.abs(positions[0] - 8.6) < 0.00001, "card name remains above the set row");
  assert.ok(Math.abs(positions[1] - 6.7) < 0.00001, "set remains above the condition row");
  assert.ok(positions[1] + 1.75 + 0.15 <= positions[0] + 0.00001, "name and set do not overlap");
  const encoded = (value: string) => Buffer.from(value).toString("hex").toUpperCase();
  const condition = content.split("BT\n").find(section => section.includes(`<${encoded("Lightly Played")}> Tj`))!;
  assert.match(condition, /\/Helvetica-Bold-[\d]+ 5 Tf/);
  const conditionY = Number(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(condition)![2]) / mm;
  assert.ok(conditionY >= 4.8 && conditionY < 6.55, "condition stays in its own row below the set");
  const sku = content.split("BT\n").find(section => section.includes(`<${encoded("DEFY-1234567890")}> Tj`))!;
  assert.match(sku, /\/Courier-Bold-[\d]+ 7 Tf/);
  const brand = content.split("BT\n").find(section => section.includes(`<${encoded("Defy TCG - Redmond")}> Tj`))!;
  assert.match(brand, /\/Helvetica-Bold-[\d]+ 6 Tf/);
  const brandY = Number(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(brand)![2]) / mm;
  assert.ok(brandY >= 10.5 && brandY < 12.5, "all details fit inside the 13 mm page with a half-millimeter margin");
  assert.match(content, new RegExp(encoded("Buy singles at defytcg.com")));
});

test("name wrapping handles words and long Unicode names with at most two fitting lines", () => {
  const measure = (value: string) => Array.from(value).length;
  assert.deepEqual(wrapSkuLabelName("Ahri Spirit Blossom", 12, measure), ["Ahri Spirit", "Blossom"]);
  assert.deepEqual(wrapSkuLabelName("🃏".repeat(30), 8, measure), ["🃏".repeat(8), `${"🃏".repeat(7)}…`]);
  assert.deepEqual(wrapSkuLabelName("A long name with many words", 8, measure), ["A long", "name wi…"]);
  assert.deepEqual(wrapSkuLabelName("Short", 8, measure), ["Short"]);
  assert.deepEqual(wrapSkuLabelName("Ahri Spirit Blossom", 12, measure, 1), ["Ahri Spirit…"]);
  assert.deepEqual(wrapSkuLabelName("🃏".repeat(30), 8, measure, 1), [`${"🃏".repeat(7)}…`]);
  assert.deepEqual(wrapSkuLabelName("Short", 8, measure, 1), ["Short"]);
});

test("PDF condition layout rejects a name image that would occupy its condition row", async () => {
  await assert.rejects(createSkuLabelPdf([{ sku: "DEFY-1234567890", name: "Long name", condition: "LP" }], 1,
    async () => ({ png: pixel, heightMm: 4 })), /card name could not fit/);
});

test("set-name PDF rows reject oversized images and malformed set data before rendering", async () => {
  const label = { sku: "DEFY-1234567890", name: "", setName: "Neo Premium File 1" };
  await assert.rejects(createSkuLabelPdf([label], 1, async () => ({ png: pixel, heightMm: 4 })), /set name could not fit/);
  await assert.rejects(createSkuLabelPdf([{ ...label, condition: "LP" }], 1, async () => ({ png: pixel, heightMm: 2 })), /set name could not fit/);
  await assert.rejects(createSkuLabelPdf([{ ...label, setName: 42 as unknown as string }], 1,
    async () => { assert.fail("invalid set names must not render"); }), /valid card names/);
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
