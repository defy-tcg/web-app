import { createHash } from "node:crypto";
import { ScrydexError } from "../scrydex.ts";
import type { SealedCatalogProduct } from "../scrydex-sealed-catalog.ts";
import type { SinglesGraphQL } from "../singles/shopify.ts";
import { gameFromAlias } from "../tcg-games.ts";

export class SealedPricingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly match?: { id: string; source: "saved" };
  constructor(code: string, message: string, status = 422, match?: { id: string; source: "saved" }) {
    super(message);
    this.name = "SealedPricingError";
    this.code = code;
    this.status = status;
    this.match = match;
  }
}

export type SealedPriceQuote = {
  code: string; product: SealedCatalogProduct; currency: "USD"; fetchedAt: string;
  mappingSource: "saved" | "shopify" | "confirmed";
};
export type SealedScanResult = { status: "unmapped"; code: string; suggestedQuery?: string }
  | { status: "quoted"; quote: SealedPriceQuote };
export type SealedPricingDependencies = {
  graphql: SinglesGraphQL;
  /** Must request a fresh server-side Scrydex sealed-product detail, bypassing the catalog cache. */
  getProduct: (id: string) => Promise<SealedCatalogProduct>;
  now?: () => Date;
};

type Field = { value: string } | null;
type Variant = {
  id: string; sku: string | null; barcode: string | null;
  barcodes: { nodes: { value: string }[]; pageInfo: { hasNextPage: boolean } };
  selectedOptions: { name: string; value: string }[];
  unit: Field; receivingGame: Field;
  product: {
    id: string; title: string; productType: string;
    game: Field; language: Field; cardName: Field; set: Field; condition: Field; finish: Field;
    scrydexId: Field; receivingId: Field;
    variants: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
  };
};
type SavedMapping = { version: 1; code: string; id: string; game: "pokemon"; language: "English" };
type Snapshot = { ownerId: string; mapping: SavedMapping | null; digest: string | null };
type StoredField = { value: string; compareDigest: string; type: string };
const NAMESPACE = "defy_sealed_prices";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const normalize = (value: string) => value.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
const field = (value: Field | undefined) => value?.value?.trim() || "";
const mappingKey = (code: string) => createHash("sha256").update(code).digest("hex");
const invalidMapping = () => new SealedPricingError("MAPPING_INVALID", "The saved barcode match needs review before this product can be priced.", 409);
const staleMapping = () => new SealedPricingError("MAPPING_CHANGED", "This barcode match changed on another device. Scan it again before confirming a different product.", 409);
const conflict = () => new SealedPricingError("IDENTITY_CONFLICT", "This Shopify product has conflicting catalog, game, language, or packaging details. Review the listing before pricing it.", 409);
const ambiguous = () => new SealedPricingError("AMBIGUOUS_CODE", "Shopify could not identify one complete match for this code. Review duplicate SKUs and barcodes.", 409);
const unsupported = () => new SealedPricingError("PRODUCT_UNSUPPORTED", "This scanner supports English Pokémon sealed products. Scan a supported package.");

function scanCode(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || CONTROLS.test(value)) {
    throw new SealedPricingError("INVALID_CODE", "Scan or enter a valid manufacturer SKU or barcode of at most 128 characters.", 400);
  }
  return value.trim();
}

/** Only checksum-valid GTINs share zero-padded UPC/EAN forms. Arbitrary SKUs stay exact. */
function validGtin(code: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  let sum = 0;
  for (let index = code.length - 2, weight = 3; index >= 0; index--, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[index]) * weight;
  }
  return (10 - sum % 10) % 10 === Number(code.at(-1));
}

const canonicalCode = (code: string) => validGtin(code) ? code.padStart(14, "0") : code;

function aliases(code: string): string[] {
  const canonical = canonicalCode(code);
  if (!validGtin(code)) return [code];
  // Removing only zero indicators keeps a carton/case GTIN distinct from its contents.
  const forms = [code, canonical];
  for (const length of [13, 12, 8]) {
    if (/^0*$/.test(canonical.slice(0, 14 - length))) forms.push(canonical.slice(-length));
  }
  return [...new Set(forms)];
}

function catalogId(value: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new SealedPricingError("INVALID_PRODUCT", "Select a valid Scrydex sealed catalog product.", 400);
  }
  return value;
}

async function readMapping(code: string, graphql: SinglesGraphQL): Promise<Snapshot> {
  const data = await graphql<{ currentAppInstallation: { id: string; mapping: StoredField | null } | null }>(`query DefySealedPriceMapping($key: String!) {
    currentAppInstallation { id mapping: metafield(namespace: "${NAMESPACE}", key: $key) { type value compareDigest } }
  }`, { key: mappingKey(code) });
  const installation = data.currentAppInstallation;
  if (!installation || !/^gid:\/\/shopify\/AppInstallation\/\d+$/.test(installation.id)) {
    throw new SealedPricingError("CONNECTION_UNAVAILABLE", "The Shopify sealed-price connection is unavailable. Reopen the app and try again.", 503);
  }
  if (installation.mapping === null) return { ownerId: installation.id, mapping: null, digest: null };
  const stored = installation.mapping;
  if (!stored || stored.type !== "json" || typeof stored.compareDigest !== "string" || !stored.compareDigest || typeof stored.value !== "string") throw invalidMapping();
  let value: unknown;
  try { value = JSON.parse(stored.value); } catch { throw invalidMapping(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidMapping();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.code !== code || typeof record.id !== "string" || !SAFE_ID.test(record.id)
    || record.game !== "pokemon" || record.language !== "English") throw invalidMapping();
  return { ownerId: installation.id, mapping: record as SavedMapping, digest: stored.compareDigest };
}

function option(variant: Variant, name: string): string {
  const values = variant.selectedOptions.filter(item => normalize(item.name) === name);
  if (values.length > 1) throw conflict();
  return values[0]?.value.trim() || "";
}

function packageUnit(value: string): string | null {
  const normalized = normalize(value);
  const aliases: Record<string, string> = { etb: "elite trainer box", pack: "booster pack", "booster display": "display", "booster case": "case" };
  const unit = aliases[normalized] || normalized;
  return ["booster pack", "booster box", "booster bundle", "collection box", "elite trainer box", "tin", "deck", "display", "case"].includes(unit) ? unit : null;
}

function shopifyIdentity(variant: Variant): { id: string; name: string; setName: string; unit: string | null } | null {
  const product = variant.product;
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variant.id) || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id)) throw conflict();
  const receiving = field(product.receivingId);
  const received = /^scrydex:([^:]+):([A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.exec(receiving);
  if (receiving.startsWith("scrydex:") && !received) throw conflict();
  const explicitId = field(product.scrydexId);
  if (explicitId && !SAFE_ID.test(explicitId)) throw conflict();
  if (received && explicitId && received[2] !== explicitId) throw conflict();
  if (explicitId && receiving && !received) throw conflict();

  const type = normalize(product.productType);
  const typed = /^(?:(.*?) )?sealed(?: products?)?$/.exec(type);
  if (/^(?:.* )?singles?$/.test(type)) throw unsupported();
  const packaged = /^(.*?) (?:booster (?:box|pack|bundle|display|case)|collection box|elite trainer box|tin|deck|display|case)$/.exec(type);
  const typeGame = typed?.[1] || (packaged && gameFromAlias(packaged[1]) ? packaged[1] : "");
  const games = [field(product.game), field(variant.receivingGame), option(variant, "game"), typeGame, received?.[1] || ""].filter(Boolean)
    .map(value => gameFromAlias(value)?.key || normalize(value));
  if (new Set(games).size > 1) throw conflict();
  if (games.length && games[0] !== "pokemon") throw unsupported();
  const languages = [field(product.language), option(variant, "language")].filter(Boolean)
    .map(value => ["en", "english"].includes(normalize(value)) ? "english" : normalize(value));
  if (new Set(languages).size > 1) throw conflict();
  if (languages.length && languages[0] !== "english") throw unsupported();
  const conditions = [field(product.condition), option(variant, "condition")].filter(Boolean)
    .map(value => ["u", "unopened", "sealed", "new"].includes(normalize(value)) ? "unopened" : normalize(value));
  if (new Set(conditions).size > 1) throw conflict();
  if (conditions.length && conditions[0] !== "unopened") throw unsupported();
  const finishes = [field(product.finish), option(variant, "finish")].filter(Boolean).map(normalize);
  if (new Set(finishes).size > 1) throw conflict();
  if (finishes.length && finishes[0] !== "normal") throw unsupported();
  const units = [field(variant.unit), option(variant, "unit"), option(variant, "package unit"), option(variant, "package")].map(packageUnit).filter((unit): unit is string => unit !== null);
  if (new Set(units).size > 1) throw conflict();
  // Generic Shopify categories such as "Booster Box" are useful search hints,
  // but never establish the complete sealed identity needed for automatic pricing.
  if (!typed || !games.length || !languages.length) return null;
  const id = received?.[2] || explicitId;
  if (!id) return null;
  // Product-level catalog IDs cannot prove which package a multi-variant listing represents.
  if (!Array.isArray(product.variants?.nodes) || product.variants.pageInfo?.hasNextPage !== false
    || product.variants.nodes.length !== 1 || product.variants.nodes[0].id !== variant.id) throw conflict();
  return { id, name: field(product.cardName), setName: field(product.set), unit: units[0] ?? null };
}

function savedQuoteError(error: unknown, id: string): SealedPricingError {
  const match = { id, source: "saved" as const };
  if (error instanceof SealedPricingError) return new SealedPricingError(error.code, error.message, error.status, match);
  if (error instanceof ScrydexError) {
    const messages = {
      not_configured: ["Scrydex sealed pricing is not configured.", 503],
      unsupported: ["This scanner supports English Pokémon sealed products.", 422],
      incomplete_identity: ["Scrydex could not verify this saved sealed product. Choose its exact catalog match again.", 422],
      not_found: ["This saved English sealed product is no longer available in Scrydex. Choose a new catalog match.", 404],
      ambiguous: ["This saved catalog product has multiple or unsupported editions. Choose the exact supported package again.", 409],
      price_unavailable: ["Scrydex does not currently have a positive USD market price for this package.", 422],
      upstream_error: ["Scrydex could not be reached. Try scanning this package again shortly.", 503],
    } as const;
    const [message, status] = messages[error.code];
    return new SealedPricingError(error.code, message, status, match);
  }
  return new SealedPricingError("sealed_pricing_unavailable", "Sealed pricing is unavailable. Try scanning this package again shortly.", 503, match);
}

async function makeQuote(code: string, id: string, mappingSource: SealedPriceQuote["mappingSource"], dependencies: SealedPricingDependencies): Promise<SealedPriceQuote> {
  const value = await dependencies.getProduct(id);
  if (!value || value.id !== id || value.game !== "pokemon" || value.language !== "English"
    || typeof value.name !== "string" || !value.name.trim() || CONTROLS.test(value.name)
    || typeof value.setName !== "string" || !value.setName.trim() || CONTROLS.test(value.setName)
    || typeof value.unit !== "string" || !value.unit.trim() || CONTROLS.test(value.unit)) {
    throw new SealedPricingError("PRODUCT_UNVERIFIED", "Scrydex could not verify this exact English Pokémon sealed product. Search for the package again.");
  }
  if (!Number.isSafeInteger(value.marketCents) || value.marketCents === null || value.marketCents <= 0 || value.marketCents > 100_000_000) {
    throw new SealedPricingError("PRICE_UNAVAILABLE", "Scrydex does not currently have a positive USD market price for this package.");
  }
  const product: SealedCatalogProduct = { id: value.id, game: value.game, name: value.name, setName: value.setName,
    language: value.language, unit: value.unit, imageUrl: value.imageUrl, marketCents: value.marketCents };
  return { code, product, currency: "USD", fetchedAt: (dependencies.now?.() ?? new Date()).toISOString(), mappingSource };
}

/** Scan lookups never write a product, a price, stock, or even an inferred barcode mapping. */
export async function lookupSealedPrice(input: string, dependencies: SealedPricingDependencies): Promise<SealedScanResult> {
  const code = scanCode(input);
  const canonical = canonicalCode(code);
  const saved = await readMapping(canonical, dependencies.graphql);
  if (saved.mapping) {
    try { return { status: "quoted", quote: await makeQuote(code, saved.mapping.id, "saved", dependencies) }; }
    catch (error) { throw savedQuoteError(error, saved.mapping.id); }
  }
  const escaped = aliases(code).map(value => value.replace(/[\\":()]/g, "\\$&"));
  const data = await dependencies.graphql<{ productVariants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean } } }>(`query DefySealedPriceScan($query: String!) {
    productVariants(first: 25, query: $query) { nodes {
      id sku barcode barcodes(first: 20) { nodes { value } pageInfo { hasNextPage } }
      selectedOptions { name value }
      unit: metafield(namespace: "$app:receiving", key: "unit") { value }
      receivingGame: metafield(namespace: "$app:receiving", key: "game") { value }
      product { id title productType
        game: metafield(namespace: "card", key: "game") { value }
        language: metafield(namespace: "card", key: "language") { value }
        cardName: metafield(namespace: "card", key: "name") { value }
        set: metafield(namespace: "card", key: "set") { value }
        condition: metafield(namespace: "card", key: "condition") { value }
        finish: metafield(namespace: "card", key: "finish") { value }
        scrydexId: metafield(namespace: "card", key: "scrydex_id") { value }
        receivingId: metafield(namespace: "$app:receiving", key: "catalog_id") { value }
        variants(first: 2) { nodes { id } pageInfo { hasNextPage } }
      }
    } pageInfo { hasNextPage } }
  }`, { query: escaped.flatMap(value => [`sku:"${value}"`, `barcode:"${value}"`]).join(" OR ") });
  const variants = data.productVariants;
  if (!Array.isArray(variants?.nodes) || variants.pageInfo?.hasNextPage !== false) throw ambiguous();
  const matches = variants.nodes.filter(variant => {
    if (!Array.isArray(variant.barcodes?.nodes) || variant.barcodes.pageInfo?.hasNextPage !== false) throw ambiguous();
    return [variant.sku, variant.barcode, ...variant.barcodes.nodes.map(value => value.value)]
      .some(value => typeof value === "string" && canonicalCode(value) === canonical);
  });
  if (matches.length > 1) throw ambiguous();
  if (!matches.length) return { status: "unmapped", code };
  const variant = matches[0];
  const identity = shopifyIdentity(variant);
  if (!identity) {
    const title = variant.product.title.trim();
    return { status: "unmapped", code, ...(title && !CONTROLS.test(title) ? { suggestedQuery: title.slice(0, 100) } : {}) };
  }
  const quote = await makeQuote(code, identity.id, "shopify", dependencies);
  if ((identity.name && normalize(identity.name) !== normalize(quote.product.name))
    || (identity.setName && normalize(identity.setName) !== normalize(quote.product.setName))
    || (identity.unit && packageUnit(quote.product.unit) && identity.unit !== packageUnit(quote.product.unit))) throw conflict();
  return { status: "quoted", quote };
}

/** Staff-confirmed matches are app data only, isolated from receiving and catalog prices. */
export async function linkSealedPrice(input: { code: string; id: string; expectedId: string | null }, dependencies: SealedPricingDependencies): Promise<SealedPriceQuote> {
  const code = scanCode(input.code);
  const canonical = canonicalCode(code);
  const id = catalogId(input.id);
  const expectedId = input.expectedId === null ? null : catalogId(input.expectedId);
  const snapshot = await readMapping(canonical, dependencies.graphql);
  // A lost response can be retried with the original expectedId, including null on first save.
  if (snapshot.mapping?.id === id) return makeQuote(code, id, "confirmed", dependencies);
  if ((snapshot.mapping?.id ?? null) !== expectedId) throw staleMapping();
  const quote = await makeQuote(code, id, "confirmed", dependencies);
  const mapping: SavedMapping = { version: 1, code: canonical, id, game: "pokemon", language: "English" };
  const value = JSON.stringify(mapping);
  let compareFailed = false;
  try {
    const result = await dependencies.graphql<{ metafieldsSet: {
      metafields: { key: string; namespace: string; value: string; compareDigest: string }[];
      userErrors: { code: string }[];
    } | null }>(`mutation DefySealedPriceMappingCAS($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { key namespace value compareDigest } userErrors { code } }
    }`, { metafields: [{ ownerId: snapshot.ownerId, namespace: NAMESPACE, key: mappingKey(canonical), type: "json", value, compareDigest: snapshot.digest }] });
    const payload = result.metafieldsSet;
    const written = payload?.metafields?.[0];
    if (Array.isArray(payload?.userErrors) && !payload.userErrors.length && payload.metafields?.length === 1
      && written?.key === mappingKey(canonical) && written.namespace === NAMESPACE && written.value === value && written.compareDigest) return quote;
    compareFailed = !!payload?.userErrors?.some(error => error.code === "INVALID_COMPARE_DIGEST" || error.code === "STALE_OBJECT");
  } catch { /* A lost mutation response is recoverable only by reading the exact saved match. */ }
  try {
    const current = await readMapping(canonical, dependencies.graphql);
    if (current.ownerId !== snapshot.ownerId) throw invalidMapping();
    if (current.mapping?.id === id) return quote;
    if (compareFailed || current.digest !== snapshot.digest) throw staleMapping();
  } catch (error) {
    if (error instanceof SealedPricingError) throw error;
  }
  throw new SealedPricingError("MAPPING_UNCONFIRMED", "Shopify did not confirm this barcode match. Retry the same selection before choosing another product.", 503);
}
