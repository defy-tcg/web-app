import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export const APPROVAL_ORIGIN = 'https://defy-store-os.vercel.app';
export function approvalDigest(value: string) { return createHash('sha256').update(value).digest('hex'); }
function key() {
  const secret = process.env.ACCOUNT_APPROVAL_SECRET || process.env.NEON_AUTH_COOKIE_SECRET;
  if (!secret || secret.length < 32) throw new Error('Account approval is temporarily unavailable.');
  return secret;
}
export function issueApproval(user: string, admin: string, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ user, admin, expires: now + 86400000, nonce: randomBytes(32).toString('base64url') })).toString('base64url');
  return `${payload}.${createHmac('sha256', key()).update(`defy-account-approval-v1:${payload}`).digest('base64url')}`;
}
export function verifyApproval(token: string, admin: string, now = Date.now()): { user: string; expires: number } | null {
  if (token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = createHmac('sha256', key()).update(`defy-account-approval-v1:${parts[0]}`).digest();
  const supplied = Buffer.from(parts[1], 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    return value.admin === admin && typeof value.user === 'string' && Number.isFinite(value.expires) && value.expires > now && value.expires <= now + 86400000 ? value : null;
  } catch { return null; }
}
