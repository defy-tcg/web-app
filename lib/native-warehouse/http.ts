import { NativeError, challengeValue, deviceName, parseNativeBearer, requestID, verifierValue, type NativeSession, type NativeStart } from './policy.ts';

export const nativeHeaders = { 'Cache-Control': 'private, no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
export function nativeJSON(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { ...nativeHeaders, ...(status === 202 ? { 'Retry-After': '3' } : {}), ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
}
export function rejectCrossSite(request: Request, requireOrigin = false): void {
  const origin = request.headers.get('origin');
  if ((requireOrigin && !origin) || (origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new NativeError(403, 'Cross-site request rejected.');
}
export async function readNativeBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new NativeError(415, 'JSON required.');
  const length = Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(length) || length < 0 || length > 2048) throw new NativeError(413, 'Request too large.');
  if (!request.body) throw new NativeError(400, 'JSON required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new NativeError(413, 'Request too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new NativeError(400, 'Invalid JSON request.'); }
}
export function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new NativeError(400, 'Unexpected request field.');
}
export function nativeFailure(error: unknown): Response {
  // Never reflect SQL, tokens, upstream errors, or provider configuration.
  return error instanceof NativeError ? nativeJSON({ error: error.message }, error.status) : nativeJSON({ error: 'Account connection is temporarily unavailable. Try again.' }, 503);
}
export type NativeDependencies = {
  rateKey: (request: Request) => string;
  start: (challenge: string, name: string, rate: string) => Promise<NativeStart>;
  exchange: (id: string, verifier: string, rate: string) => Promise<(NativeSession & { token: string }) | null>;
  sessionRate: (rate: string) => Promise<void>;
  session: (header: string) => Promise<NativeSession | null>;
  revoke: (id: string, owner: string) => Promise<void>;
};
export function createNativeHandler(deps: NativeDependencies) {
  return async function handle(request: Request): Promise<Response> {
    try {
      rejectCrossSite(request);
      const url = new URL(request.url);
      if (url.searchParams.getAll('action').length !== 1 || [...url.searchParams.keys()].some(k => k !== 'action')) throw new NativeError(400, 'Choose one supported action.');
      const action = url.searchParams.get('action');
      if (request.method === 'GET' && action === 'session') {
        const header = request.headers.get('authorization');
        if (!parseNativeBearer(header)) throw new NativeError(401, 'Sign in to Defy Warehouse.');
        await deps.sessionRate(deps.rateKey(request));
        const session = await deps.session(header!);
        if (!session) throw new NativeError(401, 'This connection is expired, revoked, or unauthorized.');
        return nativeJSON(session);
      }
      if (request.method !== 'POST' || !['start', 'exchange', 'revoke'].includes(action || '')) throw new NativeError(405, 'Method not allowed for this action.');
      const body = await readNativeBody(request);
      if (action === 'start') {
        onlyKeys(body, ['challenge', 'name']);
        return nativeJSON(await deps.start(challengeValue(body.challenge), deviceName(body.name), deps.rateKey(request)));
      }
      if (action === 'exchange') {
        onlyKeys(body, ['requestId', 'verifier']);
        const session = await deps.exchange(requestID(body.requestId), verifierValue(body.verifier), deps.rateKey(request));
        return session ? nativeJSON(session) : nativeJSON({ status: 'pending' }, 202);
      }
      onlyKeys(body, []);
      const header = request.headers.get('authorization');
      if (!parseNativeBearer(header)) throw new NativeError(401, 'Sign in to Defy Warehouse.');
      await deps.sessionRate(deps.rateKey(request));
      const session = await deps.session(header!);
      if (!session) throw new NativeError(401, 'This connection is expired, revoked, or unauthorized.');
      await deps.revoke(session.device.id, session.account.id);
      return nativeJSON({ revoked: true });
    } catch (error) { return nativeFailure(error); }
  };
}
