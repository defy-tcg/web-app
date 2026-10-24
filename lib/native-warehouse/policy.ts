import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const NATIVE_ORIGIN = 'https://defy-store-os.vercel.app';
export const REQUEST_SECONDS = 600;
export const DEVICE_DAYS = 30;
export const MAX_DEVICES = 10;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export type NativeAccount = { id: string; email: string; name: string };
export type NativeDevice = { id: string; name: string; expiresAt: string };
export type NativeSession = { account: NativeAccount; device: NativeDevice; validatedAt: string };
export type NativeStart = { requestId: string; verificationCode: string; authorizationURL: string; expiresAt: string };

export class NativeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function requestID(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new NativeError(400, 'Invalid connection request.');
  return value;
}
export function challengeValue(value: unknown): string {
  if (typeof value !== 'string' || !CHALLENGE.test(value)) throw new NativeError(400, 'A valid S256 challenge is required.');
  // Reject noncanonical base64url encodings as well as a missing S256 digest.
  if (Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value) throw new NativeError(400, 'A valid S256 challenge is required.');
  return value;
}
export function verifierValue(value: unknown): string {
  if (typeof value !== 'string' || !VERIFIER.test(value)) throw new NativeError(400, 'A valid verifier is required.');
  return value;
}
export function verifierChallenge(value: string): string { return createHash('sha256').update(verifierValue(value)).digest('base64url'); }
export function matchesChallenge(verifier: string, challenge: string): boolean {
  try { return timingSafeEqual(Buffer.from(verifierChallenge(verifier)), Buffer.from(challengeValue(challenge))); }
  catch { return false; }
}
export function deviceName(value: unknown): string {
  if (value === undefined) return 'Defy Warehouse on Mac';
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new NativeError(400, 'Use a device name of 1–80 characters.');
  return value.trim();
}
export function createRequest(challenge: string, name: string, now = Date.now()) {
  const id = randomUUID();
  const code = randomBytes(5).toString('hex').toUpperCase();
  return { id, challenge: challengeValue(challenge), name: deviceName(name), code: `${code.slice(0,5)}-${code.slice(5)}`, expiresAt: new Date(now + REQUEST_SECONDS * 1000).toISOString() };
}
export function startPayload(value: { id: string; code: string; expiresAt: string }): NativeStart {
  return { requestId: value.id, verificationCode: value.code, authorizationURL: `${NATIVE_ORIGIN}/native-warehouse/authorize?requestId=${requestID(value.id)}`, expiresAt: value.expiresAt };
}
export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function issueNativeToken(id = randomUUID()) {
  requestID(id);
  const token = `nwh_${id}.${randomBytes(32).toString('base64url')}`;
  return { id, token, hash: tokenHash(token) };
}
export function parseNativeBearer(header: string | null): { id: string; token: string } | null {
  const match = /^Bearer (nwh_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(header || '');
  return match && UUID.test(match[2]) ? { id: match[2], token: match[1] } : null;
}
export function matchesNativeToken(token: string, hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(hash, 'hex'));
}
export function rateIdentity(headers: Headers, secret: string): string {
  if (secret.length < 16) throw new NativeError(503, 'Account connection is temporarily unavailable.');
  // Vercel overwrites this header with the actual client address. Unknown origins
  // share a conservative bucket; do not trust arbitrary user-defined IP headers.
  const address = (headers.get('x-vercel-forwarded-for') || 'unattributed').split(',')[0].trim().slice(0,128);
  return createHmac('sha256', secret).update(`native-warehouse-rate:${address}`).digest('hex');
}
export function accountFromRow(row: Record<string, unknown>, allowed: (email: string) => boolean): NativeAccount | null {
  const id = String(row.owner_id ?? row.id ?? ''), email = String(row.email ?? ''), name = String(row.account_name ?? row.name ?? '');
  if (!id || id.length > 128 || !email || email.length > 254 || name.length > 256 || row.banned === true || row.banned === 'true' || !allowed(email)) return null;
  return { id, email, name };
}
