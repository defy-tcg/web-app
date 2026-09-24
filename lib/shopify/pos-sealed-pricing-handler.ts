import { ScrydexError } from "../scrydex.ts";
import { PosAuthError, verifyPosSessionToken, type PosAuthConfig } from "./pos-auth.ts";
import { SealedPricingError, type SealedScanResult } from "./pos-sealed-pricing.ts";

const ORIGINS = new Set(["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]);
const MAX_BYTES = 2048;
type LinkInput = { code: string; id: string; expectedId: string | null };
type Action = { action: "scan"; code: string } | ({ action: "link" } & LinkInput);
export type SealedPricingDependencies = {
  scan: (code: string) => Promise<SealedScanResult>;
  link: (input: LinkInput) => Promise<SealedScanResult>;
  authConfig?: PosAuthConfig;
  nowSeconds?: number;
};
class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

async function readAction(request: Request): Promise<Action> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new InputError("Send the scanned code as JSON.", 415);
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new InputError("The scan request is too large.", 413);
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new InputError("The scan request is too large.", 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new InputError("The scan request is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Scan a manufacturer barcode or SKU.");
  const data = value as Record<string, unknown>;
  if (typeof data.code !== "string" || !data.code.trim() || data.code.length > 128 || /[\u0000-\u001f\u007f]/.test(data.code)) {
    throw new InputError("Enter a barcode or SKU of 1–128 characters.");
  }
  const code = data.code.trim();
  const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
  if (data.action === "scan" && Object.keys(data).length === 2) return { action: "scan", code };
  if (data.action === "link" && Object.keys(data).length === 4 && id(data.id) && (data.expectedId === null || id(data.expectedId))) {
    return { action: "link", code, id: data.id, expectedId: data.expectedId };
  }
  throw new InputError("Scan a code or confirm an exact catalog product. Prices cannot be supplied by the device.");
}

function publicResult(result: SealedScanResult): SealedScanResult {
  if (result.status === "unmapped") return { status: "unmapped", code: result.code,
    ...(result.suggestedQuery ? { suggestedQuery: result.suggestedQuery } : {}) };
  const { quote } = result;
  const { product } = quote;
  return { status: "quoted", quote: { code: quote.code, currency: quote.currency, fetchedAt: quote.fetchedAt,
    mappingSource: quote.mappingSource, product: { id: product.id, game: product.game, name: product.name,
      setName: product.setName, language: product.language, unit: product.unit,
      imageUrl: product.imageUrl, marketCents: product.marketCents } } };
}

/** Auth precedes provider access and every confirmed mapping write. */
export async function handlePosSealedPricingRequest(request: Request, dependencies: SealedPricingDependencies): Promise<Response> {
  const origin = request.headers.get("origin");
  const headers = new Headers({ "Cache-Control": "private, no-store, max-age=0", Vary: "Origin" });
  const json = (value: unknown, status: number) => Response.json(value, { status, headers });
  if (origin !== null && !ORIGINS.has(origin)) return json({ code: "origin_not_allowed", error: "Open Pokémon Sealed in Shopify POS." }, 403);
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
    return json({ code: "method_not_allowed", error: "Use POST to check a sealed price." }, 405);
  }
  try {
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(request.headers.get("authorization") || "")?.[1];
    if (!token) throw new PosAuthError("unauthorized");
    verifyPosSessionToken(token, dependencies.authConfig, dependencies.nowSeconds);
    const action = await readAction(request);
    const result = action.action === "scan" ? await dependencies.scan(action.code)
      : await dependencies.link({ code: action.code, id: action.id, expectedId: action.expectedId });
    return json(publicResult(result), 200);
  } catch (error) {
    if (error instanceof PosAuthError) return json({ code: error.code, error: error.code === "unauthorized"
      ? "Reopen Pokémon Sealed in Shopify POS with an account that can use the app."
      : "The Shopify POS connection is not configured." }, error.status);
    if (error instanceof InputError) return json({ code: "invalid_request", error: error.message }, error.status);
    // This service creates fixed public messages; upstream exceptions are never forwarded.
    if (error instanceof SealedPricingError) return json({ code: error.code, error: error.message,
      ...(error.match ? { match: { id: error.match.id, source: error.match.source } } : {}) }, error.status);
    if (error instanceof ScrydexError) {
      const messages = {
        not_configured: ["Scrydex pricing is not configured.", 503],
        unsupported: ["This checker supports English Pokémon sealed products.", 422],
        incomplete_identity: ["Select an exact sealed product before confirming the barcode.", 400],
        not_found: ["This matched sealed product is no longer available from Scrydex.", 404],
        ambiguous: ["Scrydex cannot provide one supported edition for this product.", 409],
        price_unavailable: ["Scrydex has no unambiguous USD market price for this product.", 422],
        upstream_error: ["Scrydex could not be reached. Retry the price lookup shortly.", 503],
      } as const;
      const [message, status] = messages[error.code];
      return json({ code: error.code, error: message }, status);
    }
    return json({ code: "sealed_pricing_unavailable", error: "The sealed price could not be confirmed. Try again shortly." }, 503);
  }
}
