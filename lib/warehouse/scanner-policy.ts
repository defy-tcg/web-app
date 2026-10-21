import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export const SCANNER_PROTOCOL = 1;
export const SCANNER_TOKEN_DAYS = 30;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function scannerId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid scanner identity.');
  return value;
}
export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function issueScannerKey(id: string = randomUUID()) {
  scannerId(id);
  const token = `rwsc_${id}.${randomBytes(32).toString('base64url')}`;
  return { id, token, hash: tokenHash(token) };
}
export function parseScannerKey(header: string | null): {id:string;token:string} | null {
  const match = /^Bearer (rwsc_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(header || '');
  if (!match || !UUID.test(match[2])) return null;
  return { id: match[2], token: match[1] };
}
export function matchesScannerKey(token: string, hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash) && timingSafeEqual(Buffer.from(tokenHash(token),'hex'),Buffer.from(hash,'hex'));
}
export function scannerEntity(deviceId:string, localId:unknown, kind:'batch'|'scan') {
  scannerId(deviceId);const id=scannerId(localId);
  const hash=createHash('sha256').update(`scanner-v1:${deviceId}:${kind}:${id}`).digest('hex').slice(0,48);
  return kind==='batch' ? `RW-BAT-cmp-${hash}` : `cmp-${hash}`;
}
export function scannerOperation(deviceId:string,localId:unknown,kind:string) {
  return 'scanner-'+createHash('sha256').update(`${scannerId(deviceId)}:${kind}:${scannerId(localId)}`).digest('hex');
}
export function permittedScannerAction(action:string): boolean {
  return ['status','manifest','reference','learned-image','create-batch','sync-scan'].includes(action);
}
