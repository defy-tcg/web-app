import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFromRow, challengeValue, createRequest, deviceName, issueNativeToken, matchesChallenge, matchesNativeToken, NativeError, NATIVE_ORIGIN, parseNativeBearer, rateIdentity, requestID, startPayload, tokenHash, verifierChallenge, verifierValue, type NativeSession } from '../lib/native-warehouse/policy.ts';
import { createNativeHandler, readNativeBody, rejectCrossSite, type NativeDependencies } from '../lib/native-warehouse/http.ts';
import { nativeReturnTo } from '../lib/auth/return-to.ts';

const id = '11111111-1111-1111-1111-111111111111';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const url = `${NATIVE_ORIGIN}/api/native-warehouse`;
const token = issueNativeToken(id).token;
const session: NativeSession = { account: { id: 'owner', email: 'owner@example.test', name: 'Owner' }, device: { id, name: 'Mac', expiresAt: new Date(Date.now() + 86400000).toISOString() }, validatedAt: new Date().toISOString() };
function request(action: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request(`${url}?action=${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
function harness(overrides: Partial<NativeDependencies> = {}) {
  const calls: unknown[][] = [];
  const deps: NativeDependencies = {
    rateKey: () => 'rate',
    start: async (...args) => { calls.push(['start', ...args]); return startPayload(createRequest(args[0], args[1])); },
    exchange: async (...args) => { calls.push(['exchange', ...args]); return null; },
    sessionRate: async () => {},
    session: async header => { calls.push(['session', header]); return header === `Bearer ${token}` ? session : null; },
    revoke: async (...args) => { calls.push(['revoke', ...args]); },
    ...overrides,
  };
  return { calls, handle: createNativeHandler(deps) };
}

test('PKCE uses the RFC 7636 S256 vector and rejects another verifier', () => {
  assert.equal(verifierChallenge(verifier), challenge);
  assert.equal(matchesChallenge(verifier, challenge), true);
  assert.equal(matchesChallenge('x'.repeat(43), challenge), false);
  assert.equal(matchesChallenge(verifier, verifier), false);
});
test('PKCE only accepts bounded canonical inputs', () => {
  for (const value of [null, '', 'x'.repeat(42), 'x'.repeat(129), 'with spaces'.repeat(6), '../'.repeat(20)]) assert.throws(() => verifierValue(value));
  for (const value of [null, 'x'.repeat(44), 'x'.repeat(42), 'x'.repeat(43), challenge + '=', challenge.replace('-', '+')]) assert.throws(() => challengeValue(value));
  assert.equal(verifierValue('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(challengeValue(challenge), challenge);
});
test('connection requests have unique identifiers/codes and a ten-minute lifetime', () => {
  const now = Date.now(), requests = Array.from({ length: 50 }, () => createRequest(challenge, 'Mac', now));
  assert.equal(new Set(requests.map(r => r.id)).size, 50);
  assert.equal(new Set(requests.map(r => r.code)).size, 50);
  for (const value of requests) {
    assert.equal(new Date(value.expiresAt).getTime(), now + 600000);
    assert.match(value.code, /^[A-F0-9]{5}-[A-F0-9]{5}$/);
    const payload = startPayload(value), target = new URL(payload.authorizationURL);
    assert.equal(target.origin, NATIVE_ORIGIN);
    assert.equal(target.pathname, '/native-warehouse/authorize');
    assert.equal(target.search, '?requestId=' + value.id);
    assert.equal('challenge' in payload, false);
  }
});
test('native keys are separate, random, hashed, and strictly parsed', () => {
  const first = issueNativeToken(id), second = issueNativeToken(id);
  assert.notEqual(first.token, second.token);
  assert.equal(first.hash, tokenHash(first.token));
  assert.equal(matchesNativeToken(first.token, first.hash), true);
  assert.equal(matchesNativeToken(second.token, first.hash), false);
  assert.equal(matchesNativeToken(first.token, 'invalid'), false);
  assert.deepEqual(parseNativeBearer('Bearer ' + first.token), { id, token: first.token });
  for (const header of [null, '', first.token, 'Basic ' + first.token, 'Bearer rwsc_' + first.token.slice(4), 'Bearer ' + first.token + ' ', 'Bearer ' + first.token + '\n', 'Bearer nwh_' + id + '.short']) assert.equal(parseNativeBearer(header), null);
});
test('untrusted device names and identifiers are bounded and contain no controls', () => {
  assert.equal(deviceName(undefined), 'Defy Warehouse on Mac');
  assert.equal(deviceName('  My Mac  '), 'My Mac');
  for (const value of ['', 1, 'x'.repeat(81), 'Mac\nInjected', 'Mac\0']) assert.throws(() => deviceName(value));
  for (const value of [null, '../other', id.toUpperCase(), id + '?x=1']) { if (value !== id) assert.throws(() => requestID(value)); }
});
test('current account authorization rejects deleted, banned, or newly unauthorized identities', () => {
  const allowed = (email: string) => email === 'owner@example.test';
  const row = { owner_id: id, email: 'owner@example.test', account_name: 'Owner', banned: false };
  assert.deepEqual(accountFromRow(row, allowed), { id, email: row.email, name: 'Owner' });
  for (const bad of [{}, { ...row, banned: true }, { ...row, email: 'attacker@example.test' }, { ...row, owner_id: '' }, { ...row, account_name: 'x'.repeat(257) }]) assert.equal(accountFromRow(bad, allowed), null);
});
test('rate identity hashes trusted addresses and ignores spoofable fallback headers', () => {
  const secret = 'a-secure-test-only-key-that-is-long';
  const headers = new Headers({ 'x-vercel-forwarded-for': '192.0.2.1' });
  const key = rateIdentity(headers, secret);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key.includes('192.0.2.1'), false);
  assert.notEqual(key, rateIdentity(headers, secret + 'changed'));
  assert.equal(rateIdentity(new Headers({ 'x-forwarded-for': '192.0.2.8' }), secret), rateIdentity(new Headers(), secret));
  assert.throws(() => rateIdentity(headers, ''));
});
test('sign-in return paths reject open redirects, encodings, fragments, and extra parameters', () => {
  const path = '/native-warehouse/authorize?requestId=' + id;
  assert.equal(nativeReturnTo(path), path); assert.equal(nativeReturnTo('/native-warehouse'), '/native-warehouse');
  for (const value of [null, [path], '//evil.test', 'https://evil.test', '\\evil.test', 'javascript:alert(1)', '/%2fnative-warehouse', path + '&redirect=https://evil.test', path + '#foo', path + '&requestId=' + id, '/native-warehouse/../api/inventory', '/native-warehouse?foo=1']) assert.equal(nativeReturnTo(value), '/');
});
test('native start accepts the exact client contract and never returns credentials', async () => {
  const h = harness(), response = await h.handle(request('start', { challenge, name: 'My Mac' }));
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(new URL(body.authorizationURL).origin, NATIVE_ORIGIN);
  assert.equal(typeof body.verificationCode, 'string'); assert.equal(body.token, undefined);
  assert.deepEqual(h.calls, [['start', challenge, 'My Mac', 'rate']]);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
test('native start rejects injected owner, arbitrary redirect, malformed challenge, and JSON arrays before storage', async () => {
  for (const body of [{ challenge, owner: 'another' }, { challenge, redirectURL: 'https://evil.test' }, { challenge: 'bad' }, [], null]) {
    const h = harness(); assert.equal((await h.handle(request('start', body))).status, 400); assert.equal(h.calls.length, 0);
  }
});
test('native exchange waits without exposing account or token and returns approved payload unchanged', async () => {
  const pending = harness(), response = await pending.handle(request('exchange', { requestId: id, verifier }));
  assert.equal(response.status, 202); assert.equal(response.headers.get('retry-after'), '3');
  assert.deepEqual(await response.json(), { status: 'pending' });
  const approved = harness({ exchange: async () => ({ ...session, token }) });
  assert.deepEqual(await (await approved.handle(request('exchange', { requestId: id, verifier }))).json(), { ...session, token });
});
test('native exchange surfaces expired and consumed requests without replaying sign-in', async () => {
  for (const status of [409, 410, 429]) {
    const h = harness({ exchange: async () => { throw new NativeError(status, 'Restart sign-in.'); } });
    const result = await h.handle(request('exchange', { requestId: id, verifier })); assert.equal(result.status, status);
    assert.equal((await result.json()).token, undefined);
  }
});
test('session requires a native bearer credential and does not accept cookies or scanner keys', async () => {
  for (const headers of [{}, { Cookie: 'auth_session=test' }, { Authorization: 'Bearer rwsc_' + token.slice(4) }]) {
    const h = harness(); const response = await h.handle(new Request(url + '?action=session', { headers }));
    assert.equal(response.status, 401); assert.equal(h.calls.length, 0);
  }
  const h = harness(); const response = await h.handle(new Request(url + '?action=session', { headers: { Authorization: 'Bearer ' + token } }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), session);
});
test('expired/revoked/removed-account connections fail closed', async () => {
  const h = harness({ session: async () => null });
  assert.equal((await h.handle(new Request(url + '?action=session', { headers: { Authorization: 'Bearer ' + token } }))).status, 401);
  assert.equal((await h.handle(request('revoke', {}, { Authorization: 'Bearer ' + token }))).status, 401);
  assert.equal(h.calls.length, 0);
});
test('valid-format credential probes hit the durable rate guard before account lookup', async () => {
  const h = harness({ sessionRate: async () => { throw new NativeError(429, 'Wait.'); } });
  assert.equal((await h.handle(new Request(url + '?action=session', { headers: { Authorization: 'Bearer ' + token } }))).status, 429);
  assert.equal((await h.handle(request('revoke', {}, { Authorization: 'Bearer ' + token }))).status, 429);
  assert.equal(h.calls.length, 0);
});
test('native sign-out revokes only the authenticated device and account', async () => {
  const h = harness(); const response = await h.handle(request('revoke', {}, { Authorization: 'Bearer ' + token }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { revoked: true });
  assert.deepEqual(h.calls, [['session', 'Bearer ' + token], ['revoke', session.device.id, session.account.id]]);
  const attack = harness(); assert.equal((await attack.handle(request('revoke', { id: 'different-device' }, { Authorization: 'Bearer ' + token }))).status, 400); assert.equal(attack.calls.length, 0);
});
test('browser origins and methods cannot cross the native identity boundary', async () => {
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const h = harness(); assert.equal((await h.handle(request('start', { challenge }, headers))).status, 403); assert.equal(h.calls.length, 0);
  }
  assert.throws(() => rejectCrossSite(request('start', { challenge }), true));
  assert.doesNotThrow(() => rejectCrossSite(request('start', { challenge }, { Origin: NATIVE_ORIGIN }), true));
  const h = harness();
  for (const target of [url + '?action=finalizeBatch', url + '?action=session&action=start', url + '?action=session&token=foo', url]) assert.ok((await h.handle(new Request(target))).status >= 400);
  assert.equal((await h.handle(new Request(url + '?action=start'))).status, 405);
  assert.equal((await h.handle(request('session', {}))).status, 405);
});
test('body limits are enforced even with absent or dishonest Content-Length', async () => {
  const h = harness(); const large = { padding: 'x'.repeat(5000) };
  assert.equal((await h.handle(request('start', large))).status, 413);
  assert.equal((await h.handle(request('start', large, { 'Content-Length': '1' }))).status, 413);
  assert.equal((await h.handle(request('start', { challenge }, { 'Content-Length': '3000' }))).status, 413);
  const invalid = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  await assert.rejects(() => readNativeBody(invalid), (error: unknown) => error instanceof NativeError && error.status === 400);
  assert.equal((await h.handle(request('start', { challenge }, { 'Content-Type': 'text/plain' }))).status, 415);
});
test('storage failures never expose SQL, credentials, or token data', async () => {
  const h = harness({ start: async () => { throw new Error('postgres://user:password@example secret token=' + token); } });
  const response = await h.handle(request('start', { challenge })); const body = await response.text();
  assert.equal(response.status, 503); assert.doesNotMatch(body, /postgres|password|secret|nwh_/);
});
