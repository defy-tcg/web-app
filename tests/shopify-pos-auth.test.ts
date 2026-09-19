import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { getPosAuthConfig, PosAuthError, verifyPosSessionToken, type PosAuthConfig } from "../lib/shopify/pos-auth.ts";

const config: PosAuthConfig = { shop: "defy-receiving-test.myshopify.com", clientId: "test-pos-app", clientSecret: "test-pos-secret" };
const now = 1_800_000_000;
const claims = {
  iss: `https://${config.shop}/admin`, dest: `https://${config.shop}`, aud: config.clientId,
  sub: "12345", exp: now + 60, nbf: now, iat: now, jti: "session-request-id", sid: "session-id",
};
function signed(payload: unknown = claims, header: unknown = { alg: "HS256", typ: "JWT" }, secret = config.clientSecret) {
  const body = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
function reject(token: string, authConfig = config) {
  assert.throws(() => verifyPosSessionToken(token, authConfig, now), (error: unknown) =>
    error instanceof PosAuthError && error.code === "unauthorized" && error.status === 401);
}

test("POS ID token validates the existing app and approved shop with a fresh signed user session", () => {
  assert.deepEqual(verifyPosSessionToken(signed(), config, now), { shop: config.shop, userId: "12345" });
  const production = { ...config, shop: "n4a7aa-fi.myshopify.com" };
  assert.equal(verifyPosSessionToken(signed({ ...claims, iss: `https://${production.shop}/admin`, dest: `https://${production.shop}/` }), production, now).shop, production.shop);
});

test("POS authentication rejects missing, malformed, tampered, and wrong-secret tokens", () => {
  const valid = signed();
  for (const token of ["", "undefined", "null", "a.b", `${valid}.extra`, `${valid}=`, valid.replace(/.$/, "!"), "x".repeat(8193), signed(claims, undefined, "wrong-secret")]) reject(token);
  const [header, payload, signature] = valid.split(".");
  reject(`${header}.${Buffer.from(JSON.stringify({ ...claims, sub: "67890" })).toString("base64url")}.${signature}`);
  reject(`${header}A.${payload}.${signature}`);
  reject(signed(null));
  reject(signed([]));
});

test("POS authentication rejects algorithm confusion, unsupported JWT headers, and noncanonical encoding", () => {
  for (const header of [{ alg: "none" }, { alg: "RS256" }, { alg: "HS384" }, { alg: "HS256", typ: "other" }, { alg: "HS256", crit: [] }, { alg: "HS256", b64: false }, null, []]) {
    reject(signed(claims, header));
  }
  const valid = signed();
  const parts = valid.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const signature = parts[2];
  // The last base64url character has two unused bits for a 32-byte HS256 digest.
  const alternate = alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  reject(`${parts[0]}.${parts[1]}.${signature.slice(0, -1)}${alternate}`);
});

test("POS authentication requires valid expiry, not-before, audience, and authenticated user claims", () => {
  for (const patch of [
    { exp: now }, { exp: now - 1 }, { exp: "1800000060" }, { exp: undefined }, { exp: now + 0.5 },
    { nbf: now + 1 }, { nbf: undefined }, { nbf: "1800000000" },
    { aud: "different-app" }, { aud: [config.clientId] },
    { sub: "" }, { sub: undefined }, { sub: 12345 }, { sub: "gid://shopify/Customer/12345" },
    { iat: now + 1 }, { iat: "1800000000" },
  ]) reject(signed({ ...claims, ...patch }));
});

test("POS authentication binds both HTTPS issuer and destination to the configured shop", () => {
  for (const patch of [
    { dest: "https://other.myshopify.com" }, { iss: "https://other.myshopify.com/admin" },
    { iss: `http://${config.shop}/admin` }, { dest: `http://${config.shop}` },
    { iss: `https://${config.shop}/` }, { dest: `https://${config.shop}/admin` },
    { dest: `https://${config.shop}.attacker.example` }, { dest: `https://${config.shop}@attacker.example` },
    { dest: `https://user:password@${config.shop}` }, { dest: `https://${config.shop}:8443` },
    { dest: `https://${config.shop}?shop=other` }, { iss: `https://${config.shop}/admin#other` },
    { dest: "null" },
  ]) reject(signed({ ...claims, ...patch }));
});

test("POS authentication refuses incomplete or unapproved server configuration", () => {
  for (const authConfig of [{ ...config, shop: "other.myshopify.com" }, { ...config, clientId: "" }, { ...config, clientSecret: " " }]) {
    assert.throws(() => verifyPosSessionToken(signed(), authConfig, now), (error: unknown) =>
      error instanceof PosAuthError && error.code === "not_configured" && error.status === 503);
  }
  const previous = [process.env.SHOPIFY_SHOP_DOMAIN, process.env.SHOPIFY_CLIENT_ID, process.env.SHOPIFY_CLIENT_SECRET];
  try {
    process.env.SHOPIFY_SHOP_DOMAIN = config.shop;
    process.env.SHOPIFY_CLIENT_ID = config.clientId;
    process.env.SHOPIFY_CLIENT_SECRET = config.clientSecret;
    assert.deepEqual(getPosAuthConfig(), config);
    delete process.env.SHOPIFY_CLIENT_SECRET;
    assert.throws(() => getPosAuthConfig(), PosAuthError);
  } finally {
    ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"].forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
  }
});
