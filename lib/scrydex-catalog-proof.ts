import { gameFromAlias } from "./tcg-games.ts";
import { lookupTcgplayerCard, TcgplayerCardLookupError, type TcgplayerCardLookup } from "./tcgplayer-card.ts";
import type { ScrydexProduct } from "./scrydex.ts";

declare const verifiedCatalog: unique symbol;
/** Process-local evidence from an authoritative lookup; JSON and caller flags cannot manufacture it. */
export type VerifiedScrydexCatalogProof = { readonly [verifiedCatalog]: true };
type CatalogEvidence = { snapshot: string; numberAbsent: boolean };
const proofs = new WeakMap<object, CatalogEvidence>();

export class ScrydexCatalogProofError extends Error {
  readonly code: "not_found" | "upstream_error";
  constructor(code: "not_found" | "upstream_error", message: string) {
    super(message);
    this.name = "ScrydexCatalogProofError";
    this.code = code;
  }
}

const identity = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
function finish(value: string) {
  const key = identity(value).replace(/[\s-]/g, "");
  return key === "holofoil" ? "foil" : key === "nonfoil" ? "normal" : key === "reverseholofoil" ? "reverseholo" : key;
}
function number(value: string) { return identity(value).replace(/\s+/g, "").replace(/(^|[-/])0+(?=\d)/g, "$1"); }
function snapshot(product: ScrydexProduct) {
  return JSON.stringify([product.tcgplayerId, gameFromAlias(product.game)?.key, identity(product.productType),
    identity(product.name), identity(product.setName), number(product.cardNumber), identity(product.condition),
    finish(product.finish), product.tcgplayerUrl ?? null]);
}

export function canVerifyScrydexCatalog(product: ScrydexProduct) {
  const game = gameFromAlias(product.game);
  return ["pokemon", "pokemon-japanese"].includes(game?.key ?? "") && identity(product.productType) === "single"
    && Number.isSafeInteger(product.tcgplayerId) && Number(product.tcgplayerId) > 0 && Number(product.tcgplayerId) <= 2_147_483_647
    && Boolean(product.name.trim() && product.setName.trim() && product.condition.trim() && product.finish.trim());
}

/** Rebuild a fixed-host URL from the saved ID. Saved identity is checked, never rewritten. */
export async function verifyScrydexCatalog(product: ScrydexProduct, options: {
  lookup?: (url: string, options?: { fresh?: boolean }) => Promise<TcgplayerCardLookup>;
} = {}): Promise<VerifiedScrydexCatalogProof> {
  if (!canVerifyScrydexCatalog(product)) throw new ScrydexCatalogProofError("not_found", "This saved identity cannot be verified for automatic catalog recovery.");
  const before = snapshot(product);
  let card: TcgplayerCardLookup;
  try { card = await (options.lookup ?? lookupTcgplayerCard)(`https://www.tcgplayer.com/product/${product.tcgplayerId}`, { fresh: true }); }
  catch (error) {
    if (error instanceof TcgplayerCardLookupError && [400, 404, 422].includes(error.status)) {
      throw new ScrydexCatalogProofError("not_found", "TCGplayer could not verify this exact saved card.");
    }
    throw new ScrydexCatalogProofError("upstream_error", "The authoritative card catalog is temporarily unavailable.");
  }
  const game = gameFromAlias(product.game);
  if (snapshot(product) !== before || card.productId !== product.tcgplayerId || card.categoryId !== game?.tcgplayerCategoryId
    || gameFromAlias(card.game)?.key !== game?.key || identity(card.name) !== identity(product.name)
    || identity(card.setName) !== identity(product.setName) || number(card.cardNumber) !== number(product.cardNumber)
    || (!product.cardNumber.trim() && card.catalogNumberAbsent !== true)) {
    throw new ScrydexCatalogProofError("not_found", "TCGplayer's complete identity does not match this saved card.");
  }
  // The optional finish feed can be temporarily unavailable even when the
  // authoritative identity succeeds. Keep recovery pending without guessing.
  if (!Array.isArray(card.finishes) || !card.finishes.length) {
    throw new ScrydexCatalogProofError("upstream_error", "The card's available finishes could not be verified yet.");
  }
  if (!card.finishes.some(value => typeof value === "string" && finish(value) === finish(product.finish))) {
    throw new ScrydexCatalogProofError("not_found", "The saved finish is not listed for this exact TCGplayer card.");
  }
  const proof = Object.freeze({}) as VerifiedScrydexCatalogProof;
  proofs.set(proof, { snapshot: before, numberAbsent: card.catalogNumberAbsent === true && !card.cardNumber.trim() });
  return proof;
}

export function scrydexCatalogProofMatches(product: ScrydexProduct, proof: unknown): proof is VerifiedScrydexCatalogProof {
  return Boolean(proof && typeof proof === "object" && proofs.get(proof)?.snapshot === snapshot(product));
}

export function scrydexCatalogProofHasAbsentNumber(product: ScrydexProduct, proof: unknown) {
  return scrydexCatalogProofMatches(product, proof) && proofs.get(proof)?.numberAbsent === true && !product.cardNumber.trim();
}
