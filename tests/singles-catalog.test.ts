import assert from "node:assert/strict";
import test from "node:test";
import { buildRiftboundCatalog, readRiftboundCatalog, searchCatalog, type CatalogSource, type SourceProduct } from "../lib/singles/catalog.ts";
import { parseSinglesCsv, SINGLES_CSV_TEMPLATE } from "../lib/singles/csv.ts";
import type { Catalog, CatalogCard } from "../lib/singles/types.ts";

const card: CatalogCard = {
  key: "100:Normal", productId: 100, groupId: 1, name: "Ahri, Fox",
  setName: "Origins", setCode: "OGN", number: "001/100", rarity: "Rare",
  finish: "Normal", language: "English", imageUrl: "", productUrl: "https://www.tcgplayer.com/product/100", marketCents: 250,
};
const catalog: Catalog = {
  sourceUpdatedAt: "2026-09-16T20:05:50+0000", fetchedAt: "2026-09-16T21:00:00Z", warnings: [],
  cards: [card, { ...card, key: "100:Foil", finish: "Foil" }, { ...card, productId: 101, key: "101:Foil", name: "Ahri, Fox (Alternate Art)", finish: "Foil", number: "101/100" }],
};
function csv(row: string) { return `${SINGLES_CSV_TEMPLATE}${row}\n`; }

test("CSV keeps separate finishes, art printings and conditions with exact cent amounts", () => {
  const result = parseSinglesCsv(csv("100,,,,Normal,NM,2,0.29,4.99\n100,,,,Foil,LP,1,1.25,5\n101,,,,Foil,HP,3,0,12.01"), catalog);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [
    { cardKey: "100:Normal", condition: "Near Mint", quantity: 2, costCents: 29, priceCents: 499 },
    { cardKey: "100:Foil", condition: "Lightly Played", quantity: 1, costCents: 125, priceCents: 500 },
    { cardKey: "101:Foil", condition: "Heavily Played", quantity: 3, costCents: 0, priceCents: 1201 },
  ]);
});

test("name lookup requires exact set and number and handles quoted names", () => {
  const result = parseSinglesCsv(csv(',"Ahri, Fox",OGN,001/100,Foil,DMG,1,0,0'), catalog);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].cardKey, "100:Foil");
  assert.equal(result.rows[0].condition, "Damaged");
  assert.match(parseSinglesCsv(csv(',"Ahri, Fox",OGN,,Foil,NM,1,0,1'), catalog).errors[0].message, /exact Name, Set, and Number/);
  assert.match(parseSinglesCsv(csv(',"Ahri, Fox",Different Set,001/100,Foil,NM,1,0,1'), catalog).errors[0].message, /No released English single/);
});

test("ambiguous card identities are rejected rather than choosing a printing", () => {
  const ambiguous = { ...catalog, cards: [...catalog.cards, { ...card, productId: 999, key: "999:Normal" }] };
  const result = parseSinglesCsv(csv(',"Ahri, Fox",OGN,001/100,Normal,NM,1,0,1'), ambiguous);
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0].message, /Ambiguous/);
  assert.equal(parseSinglesCsv(csv("999,,,,Normal,NM,1,0,1"), ambiguous).rows[0].cardKey, "999:Normal");
});

test("finish and condition are mandatory, and conflicting ID metadata is rejected", () => {
  for (const line of ["100,,,,,NM,1,0,1", "100,,,,Normal,,1,0,1", "100,,,,Normal,Mint,1,0,1", "100,,,,Holofoil,NM,1,0,1", "100,Wrong card,,,Normal,NM,1,0,1"])
    assert.equal(parseSinglesCsv(csv(line), catalog).rows.length, 0, line);
});

test("CSV rejects negative and fractional stock, negative or overprecise prices", () => {
  for (const quantity of ["-1", "0", "1.5", "1.0", "1e3", "9007199254740992"])
    assert.match(parseSinglesCsv(csv(`100,,,,Normal,NM,${quantity},0,1`), catalog).errors[0].message, /Quantity/);
  for (const money of ["-1", "0.001", "1e3", "", "21474836.48", "NaN"])
    assert.match(parseSinglesCsv(csv(`100,,,,Normal,NM,1,${money},1`), catalog).errors[0].message, /Unit Cost/);
  assert.equal(parseSinglesCsv(csv('100,,,,Normal,NM,1,"$1,234.50",2'), catalog).rows[0].costCents, 123450);
});

test("CSV errors preserve line numbers and reject malformed or oversized imports", () => {
  const result = parseSinglesCsv(csv("\n100,,,,Normal,NM,-1,0,1"), catalog);
  assert.equal(result.errors[0].row, 3);
  assert.match(parseSinglesCsv(csv('100,"Unclosed,,,Normal,NM,1,0,1'), catalog).errors[0].message, /Unclosed/);
  assert.match(parseSinglesCsv(csv("100,,,,Normal,NM,1,0,1,extra"), catalog).errors[0].message, /Column count/);
  const tooMany = parseSinglesCsv(csv(Array(101).fill("100,,,,Normal,NM,1,0,1").join("\n")), catalog);
  assert.equal(tooMany.rows.length, 0);
  assert.match(tooMany.errors[0].message, /at most 100/);
});

test("catalog builder excludes sealed, presale and non-English and never invents finishes", () => {
  const product = (id: number, overrides: Partial<SourceProduct> = {}): SourceProduct => ({
    productId: id, categoryId: 89, groupId: 1, name: `Card ${id}`,
    extendedData: [{ name: "Number", value: "001/100" }, { name: "Rarity", value: "Rare" }], ...overrides,
  });
  const source: CatalogSource = {
    sourceUpdatedAt: catalog.sourceUpdatedAt, fetchedAt: catalog.fetchedAt,
    groups: [{ group: { groupId: 1, categoryId: 89, name: "Origins", abbreviation: "OGN" }, products: [
      product(1), product(2, { name: "Booster Display", extendedData: [] }),
      product(3, { presaleInfo: { isPresale: true } }), product(4, { name: "Card (Chinese)" }),
      product(5), product(6, { name: "Promo token", extendedData: [{ name: "Rarity", value: "Promo" }] }),
    ], prices: [
      { productId: 1, subTypeName: "Normal", marketPrice: 0.29 }, { productId: 1, subTypeName: "Foil", marketPrice: null },
      ...[2, 3, 4, 6].map((productId) => ({ productId, subTypeName: "Normal", marketPrice: 1 })),
    ] }],
  };
  const result = buildRiftboundCatalog(source);
  assert.deepEqual(result.cards.map((entry) => entry.key).sort(), ["1:Foil", "1:Normal", "6:Normal"]);
  assert.equal(result.cards.find((entry) => entry.key === "1:Normal")?.marketCents, 29);
  assert.equal(result.cards.find((entry) => entry.key === "1:Foil")?.marketCents, null);
  assert.deepEqual(result.stats.exclusions, { sealedOrNonCard: 1, presale: 1, nonEnglish: 1, missingFinish: 1 });
  assert.equal(parseSinglesCsv(csv("2,,,,Normal,NM,1,0,1"), result).rows.length, 0);
  assert.equal(parseSinglesCsv(csv("6,,,,Normal,NM,1,0,1"), result).rows[0].cardKey, "6:Normal");
});

test("search finds names, collector numbers and alternate art within a chosen set", () => {
  assert.equal(searchCatalog(catalog, { query: "ahri alternate", set: "OGN" })[0].productId, 101);
  assert.equal(searchCatalog(catalog, { query: "001/100 normal", set: "Origins" })[0].key, "100:Normal");
  assert.equal(searchCatalog(catalog, { query: "ahri", set: "different" }).length, 0);
});

test("bundled snapshot has unique real variants, source dates and explicit coverage caveats", async () => {
  const snapshot = await readRiftboundCatalog();
  assert.ok(snapshot.cards.length > 1000);
  assert.equal(new Set(snapshot.cards.map((entry) => entry.key)).size, snapshot.cards.length);
  assert.equal(snapshot.stats.includedVariants, snapshot.cards.length);
  assert.ok(Number.isFinite(Date.parse(snapshot.sourceUpdatedAt)));
  assert.ok(snapshot.warnings.some((warning) => warning.includes("no per-SKU language data")));
  assert.ok(snapshot.cards.some((entry) => /Alternate Art/.test(entry.name)));
  assert.ok(snapshot.cards.some((entry) => /Promotional/.test(entry.setName)));
  assert.equal(snapshot.cards.some((entry) => entry.productId === 635368), false, "known Origins booster display must remain outside singles catalog");
  assert.ok(snapshot.excludedProducts.some((entry) => entry.reason === "missingFinish"));
});
