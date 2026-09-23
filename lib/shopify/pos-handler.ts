import { randomUUID } from "node:crypto";
import { ScrydexError } from "../scrydex.ts";
import { PosAuthError, verifyPosSessionToken, type PosAuthConfig } from "./pos-auth.ts";

const POS_ORIGINS = new Set(["https://cdn.shopify.com", "https://extensions.shopifycdn.com"]);
const MAX_BODY_BYTES = 2048;

export type PosPricingResult = {
  variantId: number;
  productId: string;
  sku: string;
  title: string;
  priceCents: number;
  currency: "USD";
  scrydexId: string;
};
export type PosPricingDependencies = {
  refresh: (code: string) => Promise<PosPricingResult>;
  authConfig?: PosAuthConfig;
  nowSeconds?: number;
  reportFailure?: (failure: PosPricingFailureReport) => void;
};
export type PosPricingFailureReport = {
  event: "shopify_pos_pricing_failed";
  requestId: string;
  stage: "auth" | "input" | "lookup";
  code: string;
  status: number;
};

function reportFailure(failure: PosPricingFailureReport): void {
  console.warn(JSON.stringify(failure));
}

class PosRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function scanCode(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new PosRequestError("invalid_content_type", "Send the scanned SKU as JSON.", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new PosRequestError("body_too_large", "The scan request is too large.", 413);
  }
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new PosRequestError("body_too_large", "The scan request is too large.", 413);
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { throw new PosRequestError("invalid_json", "The scan request is not valid JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("code" in body)
    || typeof body.code !== "string" || !body.code.trim() || body.code.length > 128 || /[\u0000-\u001f\u007f]/.test(body.code)) {
    throw new PosRequestError("invalid_code", "Send only a SKU or barcode of up to 128 characters.");
  }
  return body.code.trim();
}

function publicError(error: unknown): { code: string; error: string; status: number } {
  if (error instanceof PosAuthError || error instanceof PosRequestError) {
    return { code: error.code, error: error.message, status: error.status };
  }
  if (error instanceof ScrydexError) {
    const errors = {
      not_configured: ["Scrydex pricing is not configured.", 503],
      unsupported: ["This card or product is not supported for automatic Scrydex pricing.", 422],
      incomplete_identity: ["The product needs its exact card details before it can be priced.", 422],
      not_found: ["Shopify found the product, but its name and set do not match a Scrydex sealed product or card.", 404],
      ambiguous: ["Scrydex returned more than one possible match. Review the product's card details.", 409],
      price_unavailable: ["Scrydex has no current price for this card and condition.", 422],
      upstream_error: ["Scrydex is unavailable. Try the scan again shortly.", 503],
    } as const;
    if (Object.hasOwn(errors, error.code)) {
      const [message, status] = errors[error.code];
      return { code: error.code, error: message, status };
    }
  }
  // The pricing adapter supplies typed business failures; never forward raw upstream messages.
  if (error instanceof Error && error.name === "PosPricingError" && "code" in error && typeof error.code === "string") {
    const errors: Record<string, readonly [string, number]> = {
      INVALID_CODE: ["This SKU or barcode cannot be priced automatically.", 400],
      NOT_FOUND: ["This barcode or SKU is not linked to a Shopify product. Add the exact code to its Shopify variant before scanning again.", 404],
      AMBIGUOUS_CODE: ["More than one Shopify variant uses this SKU or barcode. Correct the duplicates before scanning again.", 409],
      IDENTITY_CONFLICT: ["The Shopify product's card details conflict. Review its identity before scanning again.", 422],
      IDENTITY_REQUIRED: ["The Shopify product needs complete card details before it can be priced.", 422],
      PRODUCT_TYPE_REQUIRED: ["The Shopify product must identify whether it is a single or sealed product.", 422],
      PRODUCT_UNAVAILABLE: ["This Shopify product is not available to sell.", 422],
      LANGUAGE_UNSUPPORTED: ["The card's verified game and Shopify language must agree before automatic pricing.", 422],
      CURRENCY_UNSUPPORTED: ["Automatic Scrydex pricing currently supports USD only.", 422],
      VARIANT_INVALID: ["Shopify did not return a valid variant for this scan.", 502],
      PRICE_UPDATE_UNCONFIRMED: ["Shopify could not confirm the price update. Try the scan again shortly.", 502],
    };
    if (Object.hasOwn(errors, error.code)) {
      const [message, status] = errors[error.code];
      return { code: error.code, error: message, status };
    }
  }
  return { code: "pricing_unavailable", error: "Unable to confirm the price. Try the scan again shortly.", status: 503 };
}

/** CORS is a browser boundary; every price operation independently requires a signed POS token. */
export async function handlePosPricingRequest(request: Request, dependencies: PosPricingDependencies): Promise<Response> {
  const origin = request.headers.get("origin");
  const headers = new Headers({ "Cache-Control": "private, no-store, max-age=0", Vary: "Origin" });
  const json = (body: unknown, status: number) => Response.json(body, { status, headers });
  let stage: PosPricingFailureReport["stage"] = "auth";
  const failedPost = (failure: { code: string; error: string; status: number }) => {
    const requestId = randomUUID();
    // Only fixed classifications and a server-generated ID enter logs. Never log
    // request headers/body, the scanned code, product data, or a caught exception.
    const report: PosPricingFailureReport = { event: "shopify_pos_pricing_failed", requestId, stage, code: failure.code, status: failure.status };
    try { (dependencies.reportFailure ?? reportFailure)(report); }
    catch { /* Observability must not change the failure returned to POS. */ }
    return json({ code: failure.code, error: failure.error, requestId }, failure.status);
  };
  if (origin !== null && !POS_ORIGINS.has(origin)) {
    const failure = { code: "origin_not_allowed", error: "Use Defy Pricing from Shopify POS.", status: 403 };
    return request.method === "POST" ? failedPost(failure) : json({ code: failure.code, error: failure.error }, failure.status);
  }
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  if (request.method === "OPTIONS") {
    const requestedMethod = request.headers.get("access-control-request-method");
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    if ((requestedMethod && requestedMethod !== "POST") || requestedHeaders.some((value) => !["authorization", "content-type"].includes(value))) {
      return json({ code: "invalid_preflight", error: "This request is not supported." }, 400);
    }
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    headers.set("Allow", "POST, OPTIONS");
    return json({ code: "method_not_allowed", error: "Use POST to look up a scanned SKU." }, 405);
  }
  try {
    const authorization = request.headers.get("authorization") ?? "";
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(authorization)?.[1];
    if (!token) throw new PosAuthError("unauthorized");
    verifyPosSessionToken(token, dependencies.authConfig, dependencies.nowSeconds);
    stage = "input";
    const code = await scanCode(request);
    stage = "lookup";
    const result = await dependencies.refresh(code);
    // Select response fields explicitly, so server-only adapter data cannot leak into POS.
    return json({
      variantId: result.variantId, productId: result.productId, sku: result.sku, title: result.title,
      priceCents: result.priceCents, currency: result.currency, scrydexId: result.scrydexId,
    }, 200);
  } catch (error) {
    return failedPost(publicError(error));
  }
}
