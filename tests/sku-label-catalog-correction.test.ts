import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../lib/singles/intake.ts";
import { correctSkuLabelCatalog, getSkuLabelShopifyStatuses, readSkuLabelCatalogCorrection, skuLabelCatalogVersion, type SkuLabelShopifyDependencies } from "../lib/sku-label-shopify.ts";
import { reviewOrCorrectSkuLabelCatalog, validateSkuLabelCatalogRequest } from "../lib/sku-label-catalog-correction.ts";
import { SkuLabelInventoryError } from "../lib/sku-label-inventory.ts";
import type { ShopifyLinkableSkuProduct } from "../lib/sku-label-inventory-storage.ts";
import type { TcgplayerCardLookup } from "../lib/tcgplayer-card.ts";

const original: ShopifyLinkableSkuProduct = {
  id: 77, sku: "DEFY-9278008899", barcode: null, name: "Lucario V (Non-Holo)", productType: "Single", game: "Pokémon",
  setName: "Deck Exclusives", cardNumber: "027/073", rarity: "", condition: "Near Mint", finish: "Normal",
  tcgplayerId: 579995, tcgplayerUrl: "https://www.tcgplayer.com/product/579995",
  quantity: 1, initialQuantity: 1, sheetQuantity: null, costCents: 123, marketPriceCents: 456, listPriceCents: 789,
  location: "SHELF A", lowStockThreshold: 2, priceSource: "manual", priceUpdatedAt: "2026-09-23T00:00:00Z",
  createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22 00:00:00+00", imageUrl: null,
};
const catalog: TcgplayerCardLookup = { productId: 222330, categoryId: 3, name: "Lucario V", game: "Pokémon",
  setName: "Champion's Path", cardNumber: "27/73", imageUrl: "https://tcgplayer-cdn.tcgplayer.com/product/222330_in_1000x1000.jpg",
  productUrl: "https://www.tcgplayer.com/product/222330", finishes: ["Foil"], warnings: [] };
const targetFor = (saved: ShopifyLinkableSkuProduct): ShopifyLinkableSkuProduct => ({ ...saved, name: catalog.name,
  setName: catalog.setName, cardNumber: catalog.cardNumber, finish: "Foil", tcgplayerId: catalog.productId,
  tcgplayerUrl: catalog.productUrl, imageUrl: catalog.imageUrl });
const identity = (product: ShopifyLinkableSkuProduct) => JSON.stringify([`single:tcgplayer:printing:${product.tcgplayerId}`, product.condition, product.finish.toLowerCase(), "English"]);
const journalKey = `qr_${digest(original.sku).slice(0, 60)}`;
const lockKey = (printing: string) => `qr_lock_${digest(printing).slice(0, 55)}`;
const sourceVersion = skuLabelCatalogVersion(original);

type RecordValue = Record<string, unknown>;
function fixture() {
  let current = structuredClone(original), sequence = 1, persistCount = 0;
  let persistFailure: "none" | "conflict" | "lost" | "before" = "none", finalFailure: "none" | "before" | "after" = "none";
  let externalCode: "none" | "sku" | "barcode" | "incomplete" = "none";
  const entries = new Map<string, { value: RecordValue; digest: string }>();
  const calls: string[] = [];
  const initial = { version: 1, identity: identity(original), sku: original.sku, owner: null, expiresAt: 0,
    initialQuantity: 1, stockRequestKey: "defy-qr-original-stock-key", status: { sku: original.sku, status: "blocked", message: "No exact price" } };
  const put = (key: string, value: RecordValue) => entries.set(key, { value: structuredClone(value), digest: String(sequence++) });
  put(journalKey, initial);
  const deps: SkuLabelShopifyDependencies = {
    settings: { shop: "defy-receiving-test.myshopify.com", locationId: "gid://shopify/Location/1" }, clock: () => 10_000,
    graphql: async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
      const name = query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? ""; calls.push(name);
      if (name === "QrCatalogCorrectionCodes") return { productVariants: { nodes: externalCode === "none" ? [] : [{ sku: externalCode === "sku" ? original.sku : "other",
        barcodes: { nodes: externalCode === "barcode" ? [{ value: original.sku }] : [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: externalCode === "incomplete" } } } as T;
      if (name === "QrLinkStatusConnection") return { currentAppInstallation: { accessScopes: ["write_products", "write_inventory", "write_publications"].map(handle => ({ handle })) } } as T;
      if (name === "QrLinkStatuses") return { shop: { q0: { value: JSON.stringify(entries.get(journalKey)!.value) } } } as T;
      if (name === "SinglesRecord") {
        const entry = entries.get(String(variables.key));
        return { shop: { id: "gid://shopify/Shop/1", metafield: entry ? { value: JSON.stringify(entry.value), compareDigest: entry.digest } : null } } as T;
      }
      assert.equal(name, "SinglesRecordCAS", "Correction must never create/publish products or change Shopify stock");
      const [field] = variables.metafields as { key: string; value: string; compareDigest: string | null }[];
      if ((entries.get(field.key)?.digest ?? null) !== field.compareDigest) return { metafieldsSet: { metafields: [], userErrors: [{ code: "INVALID_COMPARE_DIGEST", message: "Changed" }] } } as T;
      const value = JSON.parse(field.value) as RecordValue;
      const final = field.key === journalKey && value.catalogCorrectionReceipt && !value.catalogCorrectionIntent;
      if (final && finalFailure === "before") { finalFailure = "none"; throw new Error("Final journal request lost before commit"); }
      put(field.key, value);
      if (final && finalFailure === "after") { finalFailure = "none"; throw new Error("Final journal response lost after commit"); }
      return { metafieldsSet: { metafields: [{ compareDigest: entries.get(field.key)!.digest }], userErrors: [] } } as T;
    },
  };
  const persist = async (before: ShopifyLinkableSkuProduct, after: ShopifyLinkableSkuProduct) => {
    persistCount++;
    assert.equal(skuLabelCatalogVersion(before), skuLabelCatalogVersion(current));
    if (persistFailure === "conflict") throw new SkuLabelInventoryError(409, "Duplicate target variant");
    if (persistFailure === "before") { persistFailure = "none"; throw new Error("DB request lost before commit"); }
    current = { ...after, updatedAt: "2026-09-22T00:00:00+00:00" };
    if (persistFailure === "lost") { persistFailure = "none"; throw new Error("DB response lost after commit"); }
    return current;
  };
  const correct = () => correctSkuLabelCatalog(current, targetFor(current), sourceVersion, persist, deps);
  return { deps, entries, put, initial, calls, persist, correct, product: () => current, persistCount: () => persistCount,
    journal: () => entries.get(journalKey)!.value, failPersist: (value: typeof persistFailure) => { persistFailure = value; },
    setExternalCode: (value: typeof externalCode) => { externalCode = value; },
    failFinal: (value: typeof finalFailure) => { finalFailure = value; } };
}

test("explicit precreation correction retains the QR and all stock facts, and is replayable", async () => {
  const f = fixture();
  const preview = await readSkuLabelCatalogCorrection(original, f.deps);
  assert.equal(preview.sourceVersion, sourceVersion); assert.equal(preview.target, null);
  assert.deepEqual(f.calls, ["SinglesRecord"]);
  const saved = await f.correct();
  assert.equal(saved.tcgplayerId, 222330); assert.equal(saved.finish, "Foil");
  for (const key of ["sku", "id", "condition", "quantity", "initialQuantity", "costCents", "listPriceCents", "location"] as const) assert.equal(saved[key], original[key]);
  assert.equal(f.journal().identity, identity(saved)); assert.equal(f.journal().stockRequestKey, f.initial.stockRequestKey);
  assert.equal(f.journal().catalogCorrectionIntent, undefined); assert.ok(f.journal().catalogCorrectionReceipt);
  assert.equal(skuLabelCatalogVersion({ ...saved, updatedAt: original.updatedAt }), skuLabelCatalogVersion(saved));
  assert.deepEqual(await f.correct(), saved); assert.equal(f.persistCount(), 1);
});

test("correction rejects every creation, mapping, stock, adoption, or verified-status marker", async () => {
  for (const field of ["productId", "variantId", "shopifySku", "publicationId", "creationStartedAt", "stockInventoryItemId", "stockLocationId", "adjustmentStartedAt", "adjustmentId", "previousIdentity", "adoptionPending"]) {
    const f = fixture(); f.put(journalKey, { ...f.initial, [field]: field.endsWith("At") ? 0 : field === "adoptionPending" ? false : "existing" });
    await assert.rejects(f.correct(), SkuLabelInventoryError); assert.equal(f.persistCount(), 0);
  }
  for (const field of ["productId", "variantId", "adminUrl", "priceCents", "checkedAt", "transferredQuantity", "availableQuantity"]) {
    const f = fixture(); f.put(journalKey, { ...f.initial, status: { ...f.initial.status, [field]: 0 } });
    await assert.rejects(f.correct(), SkuLabelInventoryError); assert.equal(f.persistCount(), 0);
  }
  for (const patch of [{ status: { ...fixture().initial.status, status: "ready" } }, { initialQuantity: 2 }, { owner: "other" }, { expiresAt: 1 }]) {
    const f = fixture(); f.put(journalKey, { ...f.initial, ...patch }); await assert.rejects(f.correct(), SkuLabelInventoryError);
  }
});

test("active normal linking leases stop correction before changing the journal or inventory", async () => {
  for (const printing of [`sku:${original.sku}`, `single:tcgplayer:printing:${original.tcgplayerId}`, `single:tcgplayer:printing:${catalog.productId}`]) {
    const f = fixture(); f.put(lockKey(printing), { owner: "other-link", expiresAt: 50_000 });
    await assert.rejects(f.correct(), /another request/);
    assert.deepEqual(f.journal(), f.initial); assert.equal(f.persistCount(), 0);
  }
});

test("stale reviews and attempts to alter stock, QR, or condition are rejected", async () => {
  const f = fixture();
  await assert.rejects(correctSkuLabelCatalog(original, targetFor(original), digest("stale"), f.persist, f.deps), SkuLabelInventoryError);
  for (const patch of [{ sku: "DEFY-1234567890" }, { quantity: 2 }, { initialQuantity: 2 }, { costCents: 0 }, { location: "other" }, { condition: "Lightly Played" }]) {
    await assert.rejects(correctSkuLabelCatalog(original, { ...targetFor(original), ...patch }, sourceVersion, f.persist, f.deps), SkuLabelInventoryError);
  }
  assert.equal(f.persistCount(), 0); assert.deepEqual(f.journal(), f.initial);
});

test("transactional duplicate conflicts retain original identity and allow a fresh review", async () => {
  const f = fixture(); f.failPersist("conflict");
  await assert.rejects(f.correct(), /Duplicate target/);
  assert.deepEqual(f.journal(), f.initial); assert.deepEqual(f.product(), original);
});

test("a lost DB response keeps an intent, status stays pending, and retry finalizes without another DB update", async () => {
  const f = fixture(); f.failPersist("lost");
  await assert.rejects(f.correct(), /DB response lost/);
  assert.ok(f.journal().catalogCorrectionIntent); assert.equal(f.product().tcgplayerId, 222330);
  const [status] = await getSkuLabelShopifyStatuses([f.product()], f.deps);
  assert.equal(status.status, "pending"); assert.equal(status.catalogCorrectionPending, true);
  assert.equal(status.priceCents, undefined); assert.equal(status.availableQuantity, undefined);
  const resume = await readSkuLabelCatalogCorrection(f.product(), f.deps);
  assert.equal(resume.sourceVersion, sourceVersion); assert.equal(resume.target?.tcgplayerId, 222330);
  await f.correct(); assert.equal(f.persistCount(), 1); assert.equal(f.journal().catalogCorrectionIntent, undefined);
});

test("lost final journal writes or responses resume the same correction without double application", async () => {
  for (const failure of ["before", "after"] as const) {
    const f = fixture(); f.failFinal(failure);
    await assert.rejects(f.correct(), /Final journal/);
    assert.equal(f.product().sku, original.sku); assert.equal(f.persistCount(), 1);
    const saved = await f.correct(); assert.equal(saved.tcgplayerId, 222330); assert.equal(f.persistCount(), 1);
    assert.equal(f.journal().catalogCorrectionIntent, undefined); assert.equal(f.journal().identity, identity(saved));
  }
});

test("unfinished corrections cannot be redirected to a different target", async () => {
  const f = fixture(); f.failPersist("lost"); await assert.rejects(f.correct());
  await assert.rejects(correctSkuLabelCatalog(f.product(), { ...targetFor(f.product()), tcgplayerId: 222331 }, sourceVersion, f.persist, f.deps), SkuLabelInventoryError);
  assert.equal(f.persistCount(), 1); assert.ok(f.journal().catalogCorrectionIntent);
});

test("preview and confirmation verify fresh catalog and price and bind the reviewed target", async () => {
  const f = fixture(); let lookups = 0, quotes = 0, lookup = catalog;
  const deps = { load: async () => f.product(), lookup: async () => { lookups++; return lookup; },
    price: async () => { quotes++; return { cents: 1234, matchedName: catalog.name, groupName: catalog.setName, variation: "Holofoil", scrydexId: "swsh35-27", url: "" }; },
    persist: f.persist, shopify: f.deps };
  const input = validateSkuLabelCatalogRequest({ action: "preview", sku: original.sku, url: catalog.productUrl, finish: "Foil" });
  const { review } = await reviewOrCorrectSkuLabelCatalog(input, deps); assert.ok(review); assert.equal(f.persistCount(), 0);
  assert.equal(review.priceCents, 1253, "The corrected Pokémon quote previews the 1.5% selling-price markup");
  const apply = validateSkuLabelCatalogRequest({ ...input, action: "apply", confirmed: true, sourceVersion: review.sourceVersion, targetVersion: review.targetVersion });
  lookup = { ...catalog, setName: "Different reviewed printing" };
  await assert.rejects(reviewOrCorrectSkuLabelCatalog(apply, deps), /changed after review/); assert.equal(f.persistCount(), 0);
  lookup = catalog;
  const result = await reviewOrCorrectSkuLabelCatalog(apply, deps);
  assert.equal(result.product?.sku, original.sku); assert.equal(lookups, 3); assert.equal(quotes, 3); assert.equal(f.persistCount(), 1);
  assert.throws(() => validateSkuLabelCatalogRequest({ ...apply, confirmed: false }), /explicitly confirm/);
  assert.throws(() => validateSkuLabelCatalogRequest({ ...apply, targetVersion: undefined }), /explicitly confirm/);
  await assert.rejects(reviewOrCorrectSkuLabelCatalog({ ...input, finish: "Normal" }, deps), /finish is not verified/);
});


test("a resumed DB conflict cannot discard an intent another correction worker may have applied", async () => {
  const f = fixture(); f.failPersist("before"); await assert.rejects(f.correct(), /before commit/);
  const intent = f.journal().catalogCorrectionIntent; assert.ok(intent);
  f.failPersist("conflict"); await assert.rejects(f.correct(), /Duplicate target/);
  assert.deepEqual(f.journal().catalogCorrectionIntent, intent);
  f.failPersist("none"); await f.correct(); assert.equal(f.product().tcgplayerId, 222330);
});


test("an externally assigned Shopify SKU/barcode or incomplete search blocks catalog correction", async () => {
  for (const external of ["sku", "barcode", "incomplete"] as const) {
    const f = fixture(); f.setExternalCode(external);
    await assert.rejects(f.correct(), SkuLabelInventoryError); assert.equal(f.persistCount(), 0);
    assert.deepEqual(f.journal(), f.initial);
  }
});
