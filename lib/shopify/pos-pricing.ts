import { createHash } from "node:crypto";
import { scrydexSellPriceCents } from "../pricing-policy.ts";
import { resolveScrydexPrice, type ScrydexPrice, type ScrydexProduct } from "../scrydex.ts";
import { readRiftboundCatalog } from "../singles/catalog.ts";
import type { SinglesGraphQL } from "../singles/shopify.ts";
import { canonicalSinglesCondition, type Catalog } from "../singles/types.ts";
import { gameFromAlias } from "../tcg-games.ts";

export class PosPricingError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "PosPricingError";
    this.code = code;
    this.status = status;
  }
}

type Field = { value: string } | null;
type Product = {
  id: string; title: string; status: string; productType: string;
  cardName: Field; game: Field; set: Field; number: Field;
  condition: Field; finish: Field; language: Field;
  catalogId: Field; receivingId: Field;
  variants: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
};
type Variant = {
  id: string; sku: string | null; barcode: string | null; price: string;
  selectedOptions: { name: string; value: string }[]; product: Product;
};
export type PosPrice = {
  variantId: number; productId: string; sku: string; title: string;
  priceCents: number; currency: "USD"; scrydexId: string;
};
export type PosPricingDependencies = {
  graphql: SinglesGraphQL;
  resolvePrice?: (product: ScrydexProduct) => Promise<ScrydexPrice>;
  readCatalog?: () => Promise<Catalog>;
};

const FIELDS = `id sku barcode price selectedOptions { name value }
  product { id title status productType
    cardName: metafield(namespace: "card", key: "name") { value }
    game: metafield(namespace: "card", key: "game") { value }
    set: metafield(namespace: "card", key: "set") { value }
    number: metafield(namespace: "card", key: "number") { value }
    condition: metafield(namespace: "card", key: "condition") { value }
    finish: metafield(namespace: "card", key: "finish") { value }
    language: metafield(namespace: "card", key: "language") { value }
    catalogId: metafield(namespace: "defy_intake", key: "catalog_id") { value }
    receivingId: metafield(namespace: "$app:receiving", key: "catalog_id") { value }
    variants(first: 2) { nodes { id } pageInfo { hasNextPage } }
  }`;
const normalize = (value: string) => value.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase();
const field = (value: Field | undefined) => value?.value?.trim() || "";
const conflict = () => new PosPricingError("IDENTITY_CONFLICT", "The Shopify SKU, card metadata, and variant options do not agree. Review this listing before pricing it.");
const incomplete = () => new PosPricingError("IDENTITY_REQUIRED", "This Shopify variant needs an exact game, card name, set, collector number, finish, language, and condition before Scrydex can price it.");
const finishKey = (value: string) => {
  const key = normalize(value).replace(/[ -]/g, "");
  return key === "nonfoil" ? "normal" : key;
};
const conditionKey = (value: string) => canonicalSinglesCondition(value) || (["dm", "damaged"].includes(normalize(value)) ? "Damaged" : normalize(value));
const languageKey = (value: string) => ["en", "english"].includes(normalize(value)) ? "english" : normalize(value);
const numberKey = (value: string) => normalize(value).replace(/\s+/g, "").replace(/(^|[-/])0+(?=\d)/g, "$1");

function identityValue(values: string[], key: (value: string) => string = normalize) {
  const present = values.filter(Boolean);
  if (new Set(present.map(key)).size > 1) throw conflict();
  return present[0] || "";
}
function option(variant: Variant, name: string) {
  const matches = variant.selectedOptions.filter(value => normalize(value.name) === normalize(name));
  if (matches.length > 1) throw conflict();
  return matches[0]?.value.trim() || "";
}
function sourceId(product: Product) {
  const value = field(product.catalogId);
  if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw conflict();
  return value ? Number(value) : null;
}
function receivingIdentity(product: Product) {
  const value = field(product.receivingId);
  if (!value.startsWith("single:riftbound:")) return null;
  const printing = /^single:riftbound:printing:(\d+)$/.exec(value);
  const single = /^single:riftbound:(\d+):([^:]+):English:(NM|LP|MP|HP|DMG)$/.exec(value);
  const id = Number((printing || single)?.[1]);
  if ((!printing && !single) || !Number.isSafeInteger(id) || id < 1) throw conflict();
  let finish = "";
  try { finish = single ? decodeURIComponent(single[2]) : ""; } catch { throw conflict(); }
  return { id, finish, condition: single ? canonicalSinglesCondition(single[3]) || "" : "" };
}
function productKind(value: string, game: string): "Single" | "Sealed" {
  const type = normalize(value);
  if (["single", "singles"].includes(type)) return "Single";
  if (["sealed", "sealed product"].includes(type)) return "Sealed";
  const match = /^(.*?) (singles?|sealed(?: product)?)$/.exec(type);
  if (match && gameFromAlias(match[1])?.key === gameFromAlias(game)?.key) return match[2].startsWith("single") ? "Single" : "Sealed";
  throw new PosPricingError("PRODUCT_TYPE_REQUIRED", "Set this Shopify product's type to Single or Sealed, with the correct card game, before requesting a price.");
}

async function pricingIdentity(variant: Variant, readCatalog: () => Promise<Catalog>): Promise<ScrydexProduct> {
  const product = variant.product;
  if (product.status !== "ACTIVE") throw new PosPricingError("PRODUCT_UNAVAILABLE", "Only active Shopify products can be priced for POS.");
  const sku = variant.sku || "";
  const canonical = /^DEFY-RFB-(\d+)-(NORMAL|FOIL)-EN-(NM|LP|MP|HP|DMG)$/.exec(sku);
  const old = /^DEFY-RFB-S(\d+)-([A-F0-9]{12})-EN-(NM|LP|MP|HP|DMG)$/.exec(sku);
  let fallback: ScrydexProduct | null = null;
  let fallbackLanguage = "";
  const suppliedId = sourceId(product);
  const received = receivingIdentity(product);
  if (received && suppliedId !== null && received.id !== suppliedId) throw conflict();
  if (canonical || old) {
    const match = (canonical || old)!;
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || id < 1 || (suppliedId !== null && suppliedId !== id)) throw conflict();
    const catalog = await readCatalog();
    const cards = catalog.cards.filter(card => card.productId === id && (canonical
      ? card.finish.toUpperCase() === match[2]
      : createHash("sha256").update(card.finish).digest("hex").slice(0, 12).toUpperCase() === match[2]));
    if (cards.length !== 1) throw incomplete();
    const card = cards[0];
    const condition = canonicalSinglesCondition(match[3]);
    if (!condition || card.language !== "English") throw incomplete();
    fallback = { name: card.name, game: "Riftbound", setName: card.setName, cardNumber: card.number,
      productType: "Single", condition, finish: card.finish, tcgplayerId: id };
    fallbackLanguage = card.language;
    const receiving = field(product.receivingId);
    const expected = `single:riftbound:${id}:${encodeURIComponent(card.finish)}:English:${match[3]}`;
    if (receiving && receiving !== `single:riftbound:printing:${id}` && receiving !== expected) throw conflict();
    // Legacy one-variant listings have no condition options. Their saved unique
    // intake identity must prove the condition encoded in the hashed SKU.
    if (old && (!option(variant, "Condition") || !option(variant, "Finish") || !option(variant, "Language"))) {
      if (receiving !== expected || product.variants.pageInfo.hasNextPage || product.variants.nodes.length !== 1 || product.variants.nodes[0].id !== variant.id) throw conflict();
    }
    if (canonical && ((!option(variant, "Condition") && !field(product.condition)) || (!option(variant, "Finish") && !field(product.finish)) || (!option(variant, "Language") && !field(product.language)))) throw incomplete();
  }
  const game = identityValue([field(product.game), fallback?.game || ""], value => gameFromAlias(value)?.key || normalize(value));
  if (!game || !gameFromAlias(game) || gameFromAlias(game)?.key === "other") throw incomplete();
  const productType = productKind(product.productType, game);
  if (fallback && productType !== fallback.productType) throw conflict();
  if (received && (gameFromAlias(game)?.key !== "riftbound" || productType !== "Single")) throw conflict();
  const language = identityValue([option(variant, "Language"), field(product.language), fallbackLanguage], languageKey);
  if (languageKey(language) !== "english") throw new PosPricingError("LANGUAGE_UNSUPPORTED", "Scrydex POS pricing requires a verified English product.");
  const condition = identityValue([option(variant, "Condition"), field(product.condition), fallback?.condition || "", received?.condition || ""], conditionKey);
  const finish = identityValue([option(variant, "Finish"), field(product.finish), fallback?.finish || "", received?.finish || ""], finishKey);
  const name = identityValue([field(product.cardName), fallback?.name || ""]);
  const setName = identityValue([field(product.set), fallback?.setName || ""]);
  const cardNumber = identityValue([field(product.number), fallback?.cardNumber || ""], numberKey);
  if (!name || !setName || (productType === "Single" && (!cardNumber || !condition || !finish))) throw incomplete();
  if (productType === "Single" && !canonicalSinglesCondition(condition) && conditionKey(condition) !== "Damaged") throw incomplete();
  return { name, game, setName, cardNumber, productType, condition, finish, tcgplayerId: suppliedId ?? fallback?.tcgplayerId ?? received?.id ?? null };
}

function currency(value: string) {
  if (value !== "USD") throw new PosPricingError("CURRENCY_UNSUPPORTED", "Scrydex POS pricing requires a Shopify store using USD.");
}
function numericVariantId(id: string) {
  const match = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/.exec(id);
  const numeric = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(numeric) || numeric < 1) throw new PosPricingError("VARIANT_INVALID", "Shopify returned an invalid POS variant identity.", 502);
  return numeric;
}
function cents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const parts = value.split(".");
  const amount = Number(parts[0]) * 100 + Number((parts[1] || "").padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

/** Resolve only an exact SKU/barcode, then change only that existing variant's price. */
export async function refreshPosPrice(code: string, dependencies: PosPricingDependencies): Promise<PosPrice> {
  if (typeof code !== "string" || !code.trim() || code.trim().length > 128 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new PosPricingError("INVALID_CODE", "Scan or enter a valid SKU or barcode of at most 128 characters.", 400);
  }
  const scanned = code.trim();
  const escaped = scanned.replace(/[\\":()]/g, "\\$&");
  const { graphql } = dependencies;
  const data = await graphql<{ shop: { currencyCode: string }; productVariants: { nodes: Variant[]; pageInfo: { hasNextPage: boolean } } }>(`query DefyPosScan($query: String!) {
    shop { currencyCode }
    productVariants(first: 25, query: $query) { nodes { ${FIELDS} } pageInfo { hasNextPage } }
  }`, { query: `sku:"${escaped}" OR barcode:"${escaped}"` });
  currency(data.shop.currencyCode);
  if (data.productVariants.pageInfo.hasNextPage) throw new PosPricingError("AMBIGUOUS_CODE", "Shopify returned too many possible matches for this code. Review duplicate SKUs and barcodes.", 409);
  const matches = data.productVariants.nodes.filter(variant => variant.sku === scanned || variant.barcode === scanned);
  if (!matches.length) throw new PosPricingError("NOT_FOUND", "No Shopify variant exactly matches this SKU or barcode.", 404);
  if (matches.length !== 1) throw new PosPricingError("AMBIGUOUS_CODE", "More than one Shopify variant uses this SKU or barcode. Fix the duplicate before scanning it.", 409);
  const original = matches[0];
  const variantId = numericVariantId(original.id);
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(original.product.id)) throw conflict();
  const readCatalog = dependencies.readCatalog ?? readRiftboundCatalog;
  const identity = await pricingIdentity(original, readCatalog);
  const quote = await (dependencies.resolvePrice ?? resolveScrydexPrice)(identity);
  const priceCents = scrydexSellPriceCents(quote.cents, identity);

  // A lookup can outlive an edit in Shopify. Verify the current mapping and all
  // pricing evidence again before changing a price; never change stock or cost.
  const current = await graphql<{ shop: { currencyCode: string }; productVariant: Variant | null }>(`query DefyPosVerify($id: ID!) {
    shop { currencyCode } productVariant(id: $id) { ${FIELDS} }
  }`, { id: original.id });
  currency(current.shop.currencyCode);
  const latest = current.productVariant;
  if (!latest || latest.id !== original.id || latest.product.id !== original.product.id || latest.sku !== original.sku || latest.barcode !== original.barcode) throw conflict();
  const latestIdentity = await pricingIdentity(latest, readCatalog);
  if (JSON.stringify(latestIdentity) !== JSON.stringify(identity)) throw conflict();
  if (cents(latest.price) !== priceCents) {
    const result = await graphql<{ productVariantsBulkUpdate: { productVariants: { id: string; price: string }[]; userErrors: { message: string }[] } | null }>(`mutation DefyPosPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { message } }
    }`, { productId: latest.product.id, variants: [{ id: latest.id, price: (priceCents / 100).toFixed(2) }] });
    const payload = result.productVariantsBulkUpdate;
    if (!payload || payload.userErrors?.length || payload.productVariants?.length !== 1 || payload.productVariants[0].id !== latest.id || cents(payload.productVariants[0].price) !== priceCents) {
      throw new PosPricingError("PRICE_UPDATE_UNCONFIRMED", "Shopify did not confirm the updated price. Scan this item again before adding it to the cart.", 502);
    }
  }
  return { variantId, productId: latest.product.id, sku: latest.sku || "", title: latest.product.title,
    priceCents, currency: "USD", scrydexId: quote.scrydexId };
}
