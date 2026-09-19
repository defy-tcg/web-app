import { createHmac, timingSafeEqual } from "node:crypto";

const APPROVED_SHOPS = new Set([
  "n4a7aa-fi.myshopify.com",
  "defy-receiving-test.myshopify.com",
]);
const INVALID_SESSION = "Open Defy Pricing again from Shopify POS with an account that has access to the app.";

export type PosAuthConfig = { shop: string; clientId: string; clientSecret: string };
export type PosSession = { shop: string; userId: string };

export class PosAuthError extends Error {
  readonly code: "not_configured" | "unauthorized";
  readonly status: number;
  constructor(code: "not_configured" | "unauthorized") {
    super(code === "not_configured" ? "Shopify POS pricing is not configured." : INVALID_SESSION);
    this.name = "PosAuthError";
    this.code = code;
    this.status = code === "not_configured" ? 503 : 401;
  }
}

function checkedConfig(config: PosAuthConfig): PosAuthConfig {
  if (!APPROVED_SHOPS.has(config.shop) || !config.clientId.trim() || !config.clientSecret.trim()) {
    throw new PosAuthError("not_configured");
  }
  return config;
}

export function getPosAuthConfig(): PosAuthConfig {
  return checkedConfig({
    shop: process.env.SHOPIFY_SHOP_DOMAIN?.trim() ?? "",
    clientId: process.env.SHOPIFY_CLIENT_ID?.trim() ?? "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET?.trim() ?? "",
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeSegment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PosAuthError("unauthorized");
  const bytes = Buffer.from(value, "base64url");
  // Reject permissive decoding (padding, invalid trailing bits, or alternate encodings).
  if (bytes.toString("base64url") !== value) throw new PosAuthError("unauthorized");
  return bytes;
}

function tokenUrl(value: unknown, shop: string, issuer: boolean): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === shop && !url.port && !url.username && !url.password
      && !url.search && !url.hash
      && (issuer ? ["/admin", "/admin/"].includes(url.pathname) : url.pathname === "/");
  } catch { return false; }
}

/** Shopify's short-lived POS ID token authenticates this request, never a Neon cookie. */
export function verifyPosSessionToken(
  token: string,
  config: PosAuthConfig = getPosAuthConfig(),
  nowSeconds = Math.floor(Date.now() / 1000),
): PosSession {
  checkedConfig(config);
  try {
    if (!token || token.length > 8192 || !Number.isSafeInteger(nowSeconds)) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeSegment(encodedHeader)));
    if (!object(header) || header.alg !== "HS256" || (header.typ !== undefined && header.typ !== "JWT")
      || "crit" in header || "b64" in header) throw new Error();
    const received = decodeSegment(encodedSignature);
    const expected = createHmac("sha256", config.clientSecret).update(`${encodedHeader}.${encodedPayload}`).digest();
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error();

    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeSegment(encodedPayload)));
    if (!object(payload)
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds
      || typeof payload.nbf !== "number" || !Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds
      || payload.exp <= payload.nbf
      || payload.aud !== config.clientId
      || !tokenUrl(payload.iss, config.shop, true) || !tokenUrl(payload.dest, config.shop, false)
      || typeof payload.sub !== "string" || !/^[1-9]\d*$/.test(payload.sub)
      || (payload.iat !== undefined && (typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat) || payload.iat > nowSeconds))) {
      throw new Error();
    }
    return { shop: config.shop, userId: payload.sub };
  } catch {
    // Do not expose JWT contents, claim values, or credentials in a response/log.
    throw new PosAuthError("unauthorized");
  }
}
