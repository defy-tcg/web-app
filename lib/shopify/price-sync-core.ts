import { createHash, timingSafeEqual } from "node:crypto";
import { gameFromAlias } from "../tcg-games.ts";
import { scrydexSellPriceCents } from "../pricing-policy.ts";
import type { ScrydexPrice, ScrydexProduct } from "../scrydex.ts";
import type { Catalog } from "../singles/types.ts";
import type { SinglesGraphQL } from "../singles/shopify.ts";

type Field = { value: string } | null;
export interface PricingVariant {
  id: string; sku: string | null; barcode: string | null; price: string;
  selectedOptions: { name: string; value: string }[];
  product: {
    id: string; title: string; status: string; productType: string;
    catalogId: Field; storefrontCatalogId: Field;
    game: Field; cardName: Field; setName: Field; cardNumber: Field;
  };
}
export type LegacyPricingProduct = ScrydexProduct & { id: number; sku: string; barcode: string | null };
export class PriceSyncError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "PriceSyncError"; this.code = code; }
}
const fail = (message: string): never => { throw new PriceSyncError("IDENTITY_REQUIRED", message); };
const codeKey = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();
const textKey = (value: string) => value.trim().toLowerCase();
const finishKey = (value: string) => textKey(value).replace(/[\s-]/g, "").replace(/^nonfoil$/, "normal");
const conditions: Record<string, string> = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
const conditionKey = (value: string) => textKey(conditions[value.toUpperCase()] ?? value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export const PRICING_VARIANT_FIELDS = `id sku barcode price selectedOptions { name value }
  product { id title status productType
    catalogId: metafield(namespace: "$app:receiving", key: "catalog_id") { value }
    storefrontCatalogId: metafield(namespace: "defy_intake", key: "catalog_id") { value }
    game: metafield(namespace: "card", key: "game") { value }
    cardName: metafield(namespace: "card", key: "name") { value }
    setName: metafield(namespace: "card", key: "set") { value }
    cardNumber: metafield(namespace: "card", key: "number") { value }
  }`;

/** Identity comes from saved codes/catalog metadata, never a fuzzy Shopify title. */
export function pricingIdentity(variant: PricingVariant, legacy: LegacyPricingProduct[], catalog: Catalog): ScrydexProduct {
  if (variant.product.status !== "ACTIVE") return fail("Only active Shopify products are repriced.");
  const codes = [codeKey(variant.sku), codeKey(variant.barcode)].filter(Boolean);
  if (!codes.length) return fail("Save a unique SKU or barcode on this Shopify variant first.");
  const canonical = /^DEFY-RFB-(\d+)-(NORMAL|FOIL)-EN-(NM|LP|MP|HP|DMG)$/;
  const old = /^DEFY-RFB-S(\d+)-([A-F0-9]{12})-EN-(NM|LP|MP|HP|DMG)$/;
  const parsed = codes.map(code => canonical.exec(code) ?? old.exec(code)).filter((match): match is RegExpExecArray => Boolean(match));
  if (parsed.length > 1 && parsed.some(match => match[0] !== parsed[0][0])) return fail("The Shopify SKU and barcode identify different singles.");
  const ownId = variant.product.catalogId?.value;
  const sourceId = variant.product.storefrontCatalogId?.value;
  let identity: ScrydexProduct;
  if (parsed.length) {
    const [, id, edition, condition] = parsed[0];
    const cards = catalog.cards.filter(card => card.productId === Number(id) && card.language === "English"
      && (finishKey(card.finish) === edition.toLowerCase() || hash(card.finish).slice(0, 12).toUpperCase() === edition));
    if (cards.length !== 1) return fail("This SKU needs one exact English catalog printing and finish.");
    const card = cards[0];
    const allowedIds = [`single:riftbound:printing:${id}`, `single:riftbound:${id}:${encodeURIComponent(card.finish)}:English:${condition}`];
    if ((ownId && !allowedIds.includes(ownId)) || (sourceId && sourceId !== id)) return fail("The Shopify catalog mapping conflicts with its SKU.");
    if (/sealed|booster|box/i.test(variant.product.productType)) return fail("A singles SKU cannot price a sealed product.");
    identity = { name: card.name, game: "Riftbound", setName: card.setName, cardNumber: card.number,
      productType: "Single", condition: conditions[condition], finish: card.finish,
      tcgplayerId: card.productId, tcgplayerUrl: card.productUrl };
  } else {
    const matches = legacy.filter(product => [codeKey(product.sku), codeKey(product.barcode)].filter(Boolean).some(code => codes.includes(code)));
    if (matches.length !== 1) return fail(matches.length ? "This barcode matches multiple Defy products. Correct the mapping first." : "Add this product's matching SKU/barcode and exact details to Defy inventory first.");
    identity = matches[0];
    if (sourceId && String(identity.tcgplayerId) !== sourceId) return fail("Shopify's catalog ID conflicts with the Defy product.");
    if (ownId?.startsWith("single:") && identity.productType.toLowerCase() !== "single") return fail("Shopify identifies this as a single, but Defy identifies it as sealed.");
  }
  const product = variant.product;
  if (product.game?.value && gameFromAlias(product.game.value)?.key !== gameFromAlias(identity.game)?.key) return fail("The Shopify game conflicts with the matched product.");
  for (const [field, expected] of [[product.cardName, identity.name], [product.setName, identity.setName], [product.cardNumber, identity.cardNumber]] as const) {
    if (field?.value && textKey(field.value) !== textKey(expected)) return fail("Shopify's saved card details conflict with the matched product.");
  }
  for (const option of variant.selectedOptions) {
    const name = textKey(option.name);
    if (name === "language" && !["en", "english"].includes(textKey(option.value))) return fail("Automatic pricing supports English products only.");
    if (name === "finish" && finishKey(option.value) !== finishKey(identity.finish || "normal")) return fail("The Shopify finish conflicts with its SKU.");
    if (name === "condition" && conditionKey(option.value) !== conditionKey(identity.condition || "sealed")) return fail("The Shopify condition conflicts with its SKU.");
  }
  return identity;
}

export function identityFingerprint(variant: PricingVariant): string {
  return hash(JSON.stringify({ ...variant, price: undefined }));
}
function queryLiteral(value: string) { return `"${value.replace(/[\\"]/g, "\\$&")}"`; }
export function decimalCents(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new PriceSyncError("INVALID_PRICE", "Shopify returned an invalid price.");
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new PriceSyncError("INVALID_PRICE", "Shopify returned an invalid price.");
  return cents;
}
export function cronAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type VariantPriceResult = { variantId: string; sku: string; title: string; outcome: "updated" | "unchanged"; marketCents: number; priceCents: number };
/** Price + audit metadata only. Never submits inventory, cost, SKU, options, or publication writes. */
export async function updateVariantPrice(input: {
  variant: PricingVariant; legacy: LegacyPricingProduct[]; catalog: Catalog; graphql: SinglesGraphQL;
  resolve: (identity: ScrydexProduct) => Promise<ScrydexPrice>; now: string;
}): Promise<VariantPriceResult> {
  const { variant, legacy, catalog, graphql } = input;
  const identity = pricingIdentity(variant, legacy, catalog);
  const quote = await input.resolve(identity);
  const priceCents = scrydexSellPriceCents(quote.cents, identity);
  const codes = [...new Set([variant.sku?.trim(), variant.barcode?.trim()].filter((code): code is string => Boolean(code)))];
  const duplicates = await graphql<{ productVariants: { nodes: { id: string; sku: string | null; barcode: string | null }[]; pageInfo: { hasNextPage: boolean } } }>(
    `query PriceScanCodes($query: String!) { productVariants(first: 10, query: $query) { nodes { id sku barcode } pageInfo { hasNextPage } } }`,
    { query: codes.flatMap(code => [`sku:${queryLiteral(code)}`, `barcode:${queryLiteral(code)}`]).join(" OR ") });
  const exact = duplicates.productVariants.nodes.filter(candidate => [candidate.sku, candidate.barcode].some(code => code && codes.some(expected => codeKey(expected) === codeKey(code))));
  if (duplicates.productVariants.pageInfo.hasNextPage || exact.length !== 1 || exact[0].id !== variant.id) throw new PriceSyncError("DUPLICATE_CODE", "The SKU/barcode does not uniquely identify this Shopify variant.");
  const reread = await graphql<{ productVariant: PricingVariant | null }>(`query PriceVariantCheck($id: ID!) { productVariant(id: $id) { ${PRICING_VARIANT_FIELDS} } }`, { id: variant.id });
  if (!reread.productVariant || identityFingerprint(reread.productVariant) !== identityFingerprint(variant) || reread.productVariant.price !== variant.price) {
    throw new PriceSyncError("PRODUCT_CHANGED", "This Shopify product changed during refresh. Retry with its current details.");
  }
  const price = (priceCents / 100).toFixed(2);
  const metadata = { source: "scrydex", scrydexId: quote.scrydexId, marketCents: quote.cents, priceCents, syncedAt: input.now };
  const data = await graphql<{ productVariantsBulkUpdate: { productVariants: { id: string; price: string }[]; userErrors: { message: string }[] } }>(
    `mutation PosScrydexPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
        productVariants { id price } userErrors { message }
      }
    }`, { productId: variant.product.id, variants: [{ id: variant.id, price,
      metafields: [{ namespace: "$app:pos_pricing", key: "quote", type: "json", value: JSON.stringify(metadata) }] }] });
  const result = data.productVariantsBulkUpdate;
  if (!result || result.userErrors?.length || result.productVariants?.length !== 1 || result.productVariants[0].id !== variant.id || decimalCents(result.productVariants[0].price) !== priceCents) {
    throw new PriceSyncError("UPDATE_UNCONFIRMED", "Shopify did not confirm the requested price. Retry the refresh; the update is safe to repeat.");
  }
  return { variantId: variant.id, sku: variant.sku || variant.barcode || "", title: variant.product.title,
    outcome: decimalCents(variant.price) === priceCents ? "unchanged" : "updated", marketCents: quote.cents, priceCents };
}
