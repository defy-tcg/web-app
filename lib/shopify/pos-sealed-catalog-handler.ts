import { ScrydexError } from "../scrydex.ts";
import type { SealedCatalogGame, SealedCatalogProduct } from "../scrydex-sealed-catalog.ts";
import { PosAuthError, verifyPosSessionToken, type PosAuthConfig } from "./pos-auth.ts";

const ORIGINS = new Set(["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]);
const MAX_BYTES = 2048;
type Lookup = { game: SealedCatalogGame; query: string } | { game: SealedCatalogGame; id: string };
export type CatalogDependencies = {
  search: (input: { game: SealedCatalogGame; query: string }) => Promise<{ products: SealedCatalogProduct[]; hasMore: boolean }>;
  get: (input: { game: SealedCatalogGame; id: string }) => Promise<SealedCatalogProduct>;
  authConfig?: PosAuthConfig;
  nowSeconds?: number;
};

class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function readLookup(request: Request): Promise<Lookup> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new InputError("Send the catalog search as JSON.", 415);
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new InputError("The search request is too large.", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new InputError("The search request is too large.", 413);
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new InputError("The search request is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Choose a game and enter a product name.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || typeof data.game !== "string" || !["pokemon", "onepiece", "riftbound", "gundam"].includes(data.game)) {
    throw new InputError("Choose Pokémon, One Piece, Riftbound, or Gundam and a product name or catalog ID.");
  }
  const game = data.game as SealedCatalogGame;
  if (typeof data.query === "string" && data.query.trim().length >= 3 && data.query.length <= 100 && !/[\u0000-\u001f\u007f]/.test(data.query)) {
    return { game, query: data.query.trim() };
  }
  if (typeof data.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(data.id)) return { game, id: data.id };
  throw new InputError("Enter a product name of 3–100 characters or select a valid catalog result.");
}

function publicProduct(product: SealedCatalogProduct): SealedCatalogProduct {
  // Never forward upstream payloads, headers, or server-only configuration.
  return { id: product.id, game: product.game, name: product.name, setName: product.setName,
    language: product.language, unit: product.unit, imageUrl: product.imageUrl, marketCents: product.marketCents };
}

/** Read-only provider lookup. Shopify stock and SKU writes remain in the receipt journal. */
export async function handlePosSealedCatalogRequest(request: Request, dependencies: CatalogDependencies): Promise<Response> {
  const origin = request.headers.get("origin");
  const headers = new Headers({ "Cache-Control": "private, no-store, max-age=0", Vary: "Origin" });
  const json = (value: unknown, status: number) => Response.json(value, { status, headers });
  if (origin !== null && !ORIGINS.has(origin)) return json({ code: "origin_not_allowed", error: "Use catalog search from Defy Receiving in Shopify POS." }, 403);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    const requestedHeaders = (request.headers.get("access-control-request-headers") || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    if ((method && method !== "POST") || requestedHeaders.some(value => !["authorization", "content-type"].includes(value))) {
      return json({ code: "invalid_preflight", error: "This request is not supported." }, 400);
    }
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    headers.set("Allow", "POST, OPTIONS");
    return json({ code: "method_not_allowed", error: "Use POST to search the sealed catalog." }, 405);
  }
  try {
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(request.headers.get("authorization") || "")?.[1];
    if (!token) throw new PosAuthError("unauthorized");
    verifyPosSessionToken(token, dependencies.authConfig, dependencies.nowSeconds);
    const lookup = await readLookup(request);
    if ("id" in lookup) return json({ product: publicProduct(await dependencies.get(lookup)) }, 200);
    const result = await dependencies.search(lookup);
    return json({ products: result.products.map(publicProduct), hasMore: result.hasMore }, 200);
  } catch (error) {
    if (error instanceof PosAuthError) return json({ code: error.code, error: error.code === "unauthorized"
      ? "Reopen Defy Receiving from Shopify POS with an account that can use the app."
      : "The Shopify POS catalog connection is not configured." }, error.status);
    if (error instanceof InputError) return json({ code: "invalid_request", error: error.message }, error.status);
    if (error instanceof ScrydexError) {
      const messages = {
        not_configured: ["Scrydex catalog search is not configured.", 503],
        unsupported: ["Choose a supported sealed-product game.", 422],
        incomplete_identity: ["Enter a product name or select an exact catalog result.", 400],
        not_found: ["This English sealed product is no longer available in the catalog. Search again.", 404],
        ambiguous: ["This catalog product has multiple editions. Select an exact supported package or use manual registration.", 409],
        price_unavailable: ["A market price is unavailable for this product.", 422],
        upstream_error: ["Scrydex could not be reached. Try the search again shortly.", 503],
      } as const;
      const [message, status] = messages[error.code];
      return json({ code: error.code, error: message }, status);
    }
    return json({ code: "catalog_unavailable", error: "The sealed catalog is unavailable. Try again shortly." }, 503);
  }
}
