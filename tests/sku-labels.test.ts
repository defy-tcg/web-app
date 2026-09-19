import assert from "node:assert/strict";
import test from "node:test";
import { createSkuLabelDocument, generateSkuBatch, isGeneratedSku, normalizeSkuPrefix, skuQrSvg } from "../lib/sku-labels.ts";

function randomSequence(candidates: number[][]) {
  let index = 0;
  return (bytes: Uint8Array) => {
    assert.ok(index < candidates.length, "generator requested an unexpected candidate");
    bytes.set(candidates[index++]);
  };
}

test("SKU generation skips inventory and batch collisions without modifying exclusions", () => {
  const existing = new Set(["DEFY-1000000000"]);
  const zero = Array<number>(10).fill(0);
  const one = [0, ...Array<number>(9).fill(1)];
  const two = [0, ...Array<number>(9).fill(2)];
  assert.deepEqual(generateSkuBatch(2, existing, "DEFY", randomSequence([zero, one, one, two])), [
    "DEFY-1111111111",
    "DEFY-1222222222",
  ]);
  assert.deepEqual([...existing], ["DEFY-1000000000"]);
});

test("SKU generation normalizes custom prefixes and supports digits alone", () => {
  const fill = (bytes: Uint8Array) => bytes.fill(0);
  assert.deepEqual(generateSkuBatch(1, [], "  rb2 ", fill), ["RB2-1000000000"]);
  assert.deepEqual(generateSkuBatch(1, [], "", fill), ["1000000000"]);
  assert.equal(normalizeSkuPrefix(" a9 "), "A9");
  assert.equal(normalizeSkuPrefix("   "), "");
  for (const prefix of ["FIVE5", "A-B", "A B", "é", "<>"]) {
    assert.throws(() => generateSkuBatch(1, [], prefix, fill), /up to 4 letters or numbers/);
  }
});

test("SKU generation rejects biased byte values before deriving decimal digits", () => {
  const firstRejected = [252, ...Array<number>(9).fill(0)];
  const otherRejected = [0, 250, ...Array<number>(8).fill(0)];
  const largestAccepted = [251, ...Array<number>(9).fill(249)];
  assert.deepEqual(generateSkuBatch(1, [], "", randomSequence([firstRejected, otherRejected, largestAccepted])), ["9999999999"]);
});

test("generation validates quantity before consuming randomness and terminates on repeated collisions", () => {
  for (const count of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => generateSkuBatch(count, [], "", () => assert.fail("randomness must not be consumed")), /between 1 and 100/);
  }
  let calls = 0;
  assert.throws(() => generateSkuBatch(2, [], "", (bytes) => { calls++; bytes.fill(0); }), /unique SKUs/);
  assert.ok(calls <= 200);
  assert.throws(() => generateSkuBatch(1, [], "", (bytes) => bytes.fill(255)), /unique SKUs/);
});

test("generated SKUs have a fixed numeric payload, optional safe prefix, and no leading zero", () => {
  const skus = generateSkuBatch(100);
  assert.equal(new Set(skus).size, 100);
  assert.ok(skus.every((sku) => isGeneratedSku(sku) && sku.length === 15));
  for (const valid of ["DEFY-1234567890", "R-1000000000", "P9-9876543210", "1234567890"]) {
    assert.equal(isGeneratedSku(valid), true, valid);
  }
  for (const invalid of ["", "0123456789", "DEFY-0123456789", "defy-1234567890", "ABCDE-1234567890", "12345", "12345678901", "DEFY-1234567890\n", "<script>1</script>", 1234567890, null, undefined, {}, ["1234567890"], { toString: () => "1234567890" }]) {
    assert.equal(isGeneratedSku(invalid), false, String(invalid));
  }
});

test("QR output has 21 modules and an unpainted four-module quiet zone on every side", () => {
  const svg = skuQrSvg("DEFY-1234567890");
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /fill="white"/);
  const darkModules = [...svg.matchAll(/M(\d+),(\d+)l/g)];
  assert.ok(darkModules.length > 100);
  for (const [, x, y] of darkModules) {
    assert.ok(Number(x) >= 4 && Number(x) <= 24, `quiet zone violated at x=${x}`);
    assert.ok(Number(y) >= 4 && Number(y) <= 24, `quiet zone violated at y=${y}`);
  }
  assert.notEqual(svg, skuQrSvg("DEFY-1234567891"));
  assert.throws(() => skuQrSvg("DEFY-123<script>"), /generated SKU/);
});

test("print document contains exact size pages, all copies, safe names and no trailing page break", () => {
  const html = createSkuLabelDocument([
    { sku: "DEFY-1234567890", name: '  <script>&"\' test  ' },
    { sku: "RB-1000000000", name: "" },
  ], 3);
  assert.match(html, /@page \{ size: 38mm 13mm; margin: 0; \}/);
  assert.match(html, /width: 11mm; height: 11mm/);
  assert.match(html, /shape-rendering: crispEdges/);
  assert.equal((html.match(/<section class="label">/g) ?? []).length, 6);
  assert.equal((html.match(/<div class="sku">DEFY-1234567890<\/div>/g) ?? []).length, 3);
  assert.equal((html.match(/<div class="sku">RB-1000000000<\/div>/g) ?? []).length, 3);
  assert.equal((html.match(/<div class="name">/g) ?? []).length, 3);
  assert.match(html, /&lt;script&gt;&amp;&quot;&#39; test/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /\.label \+ \.label \{ break-before: page; page-break-before: always; \}/);
  assert.doesNotMatch(html, /break-after/);
});

test("print document trims and limits names without splitting Unicode characters", () => {
  const html = createSkuLabelDocument([{ sku: "1234567890", name: `  A\n B ${"🃏".repeat(50)}` }], 1);
  const name = /<div class="name">([^<]*)<\/div>/.exec(html)?.[1] ?? "";
  assert.ok(name.startsWith("A B "));
  assert.equal(Array.from(name).length, 48);
  assert.equal(Array.from(name).at(-1), "🃏");
});

test("print document refuses invalid quantities and oversized jobs", () => {
  const label = { sku: "DEFY-1234567890", name: "Test" };
  for (const copies of [0, -1, 1.5, 101, Number.NaN]) {
    assert.throws(() => createSkuLabelDocument([label], copies), /between 1 and 100 copies/);
  }
  assert.throws(() => createSkuLabelDocument([], 1), /between 1 and 100 SKUs/);
  assert.throws(() => createSkuLabelDocument(Array(101).fill(label), 1), /between 1 and 100 SKUs/);
  assert.throws(() => createSkuLabelDocument(Array(11).fill(label), 100), /no more than 1,000 labels/);
  assert.throws(() => createSkuLabelDocument([{ ...label, sku: "invalid" }], 1), /generated SKU/);
});
