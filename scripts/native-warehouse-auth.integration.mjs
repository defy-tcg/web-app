import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Refuse a production/default connection. Root supplies the branch ID and host
// returned by the disposable test-branch creation, independently of DATABASE_URL.
const root = process.env.NATIVE_SOURCE_ROOT;
const branch = process.env.NATIVE_AUTH_TEST_BRANCH_ID;
const expectedHost = process.env.NATIVE_AUTH_TEST_EXPECTED_DB_HOST;
if (process.env.NATIVE_AUTH_TEST_MODE !== 'isolated-branch' || !root || !branch?.startsWith('br-') || branch === 'br-falling-voice-af2e9bhg' || !expectedHost) throw new Error('An explicitly isolated Neon test branch is required.');
let database;
try { database = new URL(process.env.DATABASE_URL || ''); } catch { throw new Error('The test database is not configured.'); }
if (database.hostname !== expectedHost || !expectedHost.startsWith('ep-') || !expectedHost.endsWith('.neon.tech')) throw new Error('The connection does not match the expected isolated branch endpoint.');

const require = createRequire(resolve(root, 'package.json'));
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
const owner = randomUUID(), other = randomUUID(), tag = randomUUID();
const email = `native-auth-${tag}@example.com`, otherEmail = `native-auth-other-${tag}@example.com`;
const previousAllowlist = process.env.AUTHORIZED_EMAILS;
process.env.AUTHORIZED_EMAILS = `${email},${otherEmail}`;
// Server auth configuration is required to import the existing helper. No auth
// provider HTTP call occurs; these test users have no password/login sessions.
process.env.NEON_AUTH_BASE_URL ||= 'https://ep-native-test.neonauth.us-east-1.aws.neon.tech/neondb/auth';
process.env.NEON_AUTH_COOKIE_SECRET ||= randomBytes(32).toString('hex');
const moduleURL = pathToFileURL(resolve(root, 'lib/native-warehouse/store.ts')).href;
const store = await import(moduleURL);
const policy = await import(pathToFileURL(resolve(root, 'lib/native-warehouse/policy.ts')).href);
const requestIds = new Set(), rates = new Set(), secrets = new Set();
const verifier = randomBytes(32).toString('base64url'), challenge = policy.verifierChallenge(verifier);
const freshRate = () => { const rate = randomBytes(32).toString('hex'); rates.add(rate); return rate; };
let currentCase = 'initialization', passed = 0, initialized = false, fixtures = false, failed = false;
const check = async (name, run) => { currentCase = name; await run(); passed++; process.stdout.write(`PASS ${name}\n`); };
const expectStatus = (run, status) => assert.rejects(run, error => error instanceof policy.NativeError && error.status === status);
async function start(rate = freshRate()) {
  const result = await store.startNativeRequest(challenge, 'Native auth test fixture', rate);
  requestIds.add(result.requestId); return result;
}
async function grant(ownerId = owner) {
  const request = await start(); await store.approveNativeRequest(request.requestId, request.verificationCode, ownerId);
  const result = await store.exchangeNativeRequest(request.requestId, verifier, freshRate());
  assert.ok(result); secrets.add(result.token); return result;
}
const header = grant => 'Bearer ' + grant.token;
try {
  await check('concurrent cold schema initialization', async () => {
    const cold = await Promise.all(Array.from({ length: 6 }, (_, index) => import(`${moduleURL}?cold=${tag}-${index}`)));
    await Promise.all(cold.map(module => module.initializeNativeAuth()));
    await store.initializeNativeAuth(); initialized = true;
  });
  await sql`INSERT INTO neon_auth."user" (id,name,email,"emailVerified",banned) VALUES (${owner}::uuid,'Native auth test fixture',${email},true,false),(${other}::uuid,'Native auth test fixture',${otherEmail},true,false)`;
  fixtures = true;
  await sql`INSERT INTO defy_accounts.directory(user_id,email,role,status) VALUES(${owner},${email},'STAFF','ACTIVE'),(${other},${otherEmail},'STAFF','ACTIVE')`;
  let pending;
  await check('pending request and wrong proof', async () => {
    pending = await start();
    assert.equal(await store.exchangeNativeRequest(pending.requestId, verifier, freshRate()), null);
    await expectStatus(() => store.exchangeNativeRequest(pending.requestId, 'z'.repeat(43), freshRate()), 400);
    assert.equal((await store.readApprovalRequest(pending.requestId, owner)).approved, false);
  });
  await check('browser approval is account-bound', async () => {
    await expectStatus(() => store.approveNativeRequest(pending.requestId, '00000-00000', owner), 409);
    await store.approveNativeRequest(pending.requestId, pending.verificationCode, owner);
    await expectStatus(() => store.approveNativeRequest(pending.requestId, pending.verificationCode, other), 409);
    await expectStatus(() => store.readApprovalRequest(pending.requestId, other), 409);
  });
  let firstGrant;
  await check('eight concurrent exchanges consume exactly once', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => store.exchangeNativeRequest(pending.requestId, verifier, freshRate())));
    const successes = attempts.filter(result => result.status === 'fulfilled');
    assert.equal(successes.length, 1);
    for (const result of attempts.filter(result => result.status === 'rejected')) assert.equal(result.reason.status, 409);
    firstGrant = successes[0].value; assert.ok(firstGrant); secrets.add(firstGrant.token);
    const rows = await sql`SELECT count(*)::int AS count FROM defy_native_auth.devices WHERE owner_id=${owner}`;
    assert.equal(rows[0].count, 1);
  });
  await check('hash-only storage and live session identity', async () => {
    const session = await store.authenticateNative(header(firstGrant));
    assert.equal(session.account.id, owner); assert.equal(session.account.email, email);
    const rows = await sql`SELECT * FROM defy_native_auth.devices WHERE id=${firstGrant.device.id}::uuid`;
    assert.equal(rows[0].token_hash, policy.tokenHash(firstGrant.token));
    assert.equal(JSON.stringify(rows).includes(firstGrant.token), false);
    assert.equal('token' in session, false);
  });
  await check('owner cannot revoke another account connection', async () => {
    await store.revokeNativeDevice(firstGrant.device.id, other);
    assert.ok(await store.authenticateNative(header(firstGrant)));
  });
  await check('device revocation rejects the next check', async () => {
    await store.revokeNativeDevice(firstGrant.device.id, owner);
    assert.equal(await store.authenticateNative(header(firstGrant)), null);
  });
  let profileGrant;
  await check('account profile comes from current shared directory', async () => {
    profileGrant = await grant();
    await sql`UPDATE neon_auth."user" SET name='Updated test name' WHERE id=${owner}::uuid`;
    assert.equal((await store.authenticateNative(header(profileGrant))).account.name, 'Updated test name');
  });
  await check('email policy changes revoke access without credential migration', async () => {
    await sql`UPDATE defy_accounts.directory SET status='DISABLED' WHERE user_id=${owner}`;
    assert.equal(await store.authenticateNative(header(profileGrant)), null);
    await sql`UPDATE defy_accounts.directory SET status='ACTIVE' WHERE user_id=${owner}`;
    await sql`UPDATE neon_auth."user" SET email=${`unauthorized-${tag}@example.com`} WHERE id=${owner}::uuid`;
    assert.equal(await store.authenticateNative(header(profileGrant)), null);
    await sql`UPDATE neon_auth."user" SET email=${email} WHERE id=${owner}::uuid`;
    assert.ok(await store.authenticateNative(header(profileGrant)));
  });
  await check('banned account cannot validate or approve', async () => {
    const request = await start();
    await sql`UPDATE neon_auth."user" SET banned=true WHERE id=${owner}::uuid`;
    assert.equal(await store.authenticateNative(header(profileGrant)), null);
    await expectStatus(() => store.approveNativeRequest(request.requestId, request.verificationCode, owner), 401);
    await sql`UPDATE neon_auth."user" SET banned=false WHERE id=${owner}::uuid`;
  });
  await check('request expiry prevents approval and exchange', async () => {
    const request = await start();
    await sql`UPDATE defy_native_auth.requests SET expires_at=now()-interval '1 second' WHERE id=${request.requestId}::uuid`;
    await expectStatus(() => store.approveNativeRequest(request.requestId, request.verificationCode, owner), 409);
    await expectStatus(() => store.exchangeNativeRequest(request.requestId, verifier, freshRate()), 410);
  });
  await check('expired device key is rejected', async () => {
    await sql`UPDATE defy_native_auth.devices SET expires_at=now()-interval '1 second' WHERE id=${profileGrant.device.id}::uuid`;
    assert.equal(await store.authenticateNative(header(profileGrant)), null);
  });
  await check('deleted account cannot retain native access', async () => {
    const connection = await grant(other);
    await sql`DELETE FROM neon_auth."user" WHERE id=${other}::uuid`;
    assert.equal(await store.authenticateNative(header(connection)), null);
    await sql`INSERT INTO neon_auth."user" (id,name,email,"emailVerified",banned) VALUES (${other}::uuid,'Native auth test fixture',${otherEmail},true,false)`;
    await store.revokeNativeDevice(connection.device.id, other);
  });
  await check('pending connection count is bounded per source', async () => {
    const rate = freshRate();
    for (let index = 0; index < 5; index++) await start(rate);
    await expectStatus(() => start(rate), 429);
  });
  await check('durable session limit blocks excessive credential probes', async () => {
    const rate = freshRate(), key = `session:${rate}:${Math.floor(Date.now()/600000)}`;
    await sql`INSERT INTO defy_native_auth.rate_limits(key,hits,expires_at) VALUES(${key},600,now()+interval '20 minutes')`;
    await expectStatus(() => store.rateNativeSession(rate), 429);
    await store.rateNativeSession(freshRate());
  });
  await check('ten-device limit is enforced at approval and again at exchange', async () => {
    const approved = await start(); await store.approveNativeRequest(approved.requestId, approved.verificationCode, other);
    for (let index = 0; index < 10; index++) {
      const issued = policy.issueNativeToken(); secrets.add(issued.token);
      await sql`INSERT INTO defy_native_auth.devices(id,owner_id,name,token_hash,expires_at) VALUES(${issued.id}::uuid,${other},'Native auth test fixture',${issued.hash},now()+interval '1 day')`;
    }
    const blocked = await start();
    await expectStatus(() => store.approveNativeRequest(blocked.requestId, blocked.verificationCode, other), 409);
    await expectStatus(() => store.exchangeNativeRequest(approved.requestId, verifier, freshRate()), 409);
    const rows = await sql`SELECT count(*)::int AS count FROM defy_native_auth.devices WHERE owner_id=${other} AND revoked_at IS NULL AND expires_at>now()`;
    assert.equal(rows[0].count, 10);
  });
  await check('active connections remain visible beyond one hundred historical records', async () => {
    await sql`INSERT INTO defy_native_auth.devices(id,owner_id,name,token_hash,created_at,expires_at,revoked_at)
      SELECT gen_random_uuid(),${other},'Native auth test fixture',md5(gen_random_uuid()::text),now()+interval '1 minute',now()+interval '1 day',now() FROM generate_series(1,105)`;
    const devices = await store.listNativeDevices(other);
    assert.equal(devices.length, 100);
    assert.equal(devices.filter(device => !device.revoked_at && !device.expired).length, 10);
    assert.equal(devices.some(device => 'token_hash' in device), false);
  });
  await check('global pending cap prevents unbounded request insertion', async () => {
    const rate = freshRate();
    await sql`INSERT INTO defy_native_auth.requests(id,verification_code,challenge,name,rate_key,expires_at)
      SELECT gen_random_uuid(),'00000-00000',${challenge},'Native auth test fixture',${rate},now()+interval '10 minutes' FROM generate_series(1,300)`;
    await expectStatus(() => start(), 429);
  });
} catch (error) {
  failed = true;
  let message = String(error?.message || 'Unknown failure');
  for (const secret of [process.env.DATABASE_URL, process.env.NEON_AUTH_COOKIE_SECRET, email, otherEmail, owner, other, ...secrets]) if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted connection]').replace(/nwh_[A-Za-z0-9_.-]+/g, '[redacted token]');
  process.stderr.write(JSON.stringify({ result: 'FAIL', case: currentCase, name: error?.name, code: error?.code, message: message.slice(0,800) }) + '\n');
} finally {
  try {
    if (initialized) {
      for (const id of requestIds) await sql`DELETE FROM defy_native_auth.requests WHERE id=${id}::uuid`;
      for (const rate of rates) {
        await sql`DELETE FROM defy_native_auth.requests WHERE rate_key=${rate}`;
        await sql`DELETE FROM defy_native_auth.rate_limits WHERE key LIKE ${`%:${rate}:%`}`;
      }
      for (const id of requestIds) await sql`DELETE FROM defy_native_auth.rate_limits WHERE key LIKE ${`exchange-request:${id}:%`}`;
      await sql`DELETE FROM defy_native_auth.requests WHERE owner_id IN (${owner},${other})`;
      await sql`DELETE FROM defy_native_auth.devices WHERE owner_id IN (${owner},${other})`;
      await sql`DELETE FROM defy_native_auth.rate_limits WHERE key LIKE ${`approve:${owner}:%`} OR key LIKE ${`approve:${other}:%`}`;
    }
    if (fixtures) await sql`DELETE FROM defy_accounts.directory WHERE user_id IN (${owner},${other})`;
    if (fixtures) await sql`DELETE FROM neon_auth."user" WHERE id IN (${owner}::uuid,${other}::uuid)`;
    process.stdout.write('CLEANUP synthetic fixture rows removed; existing accounts untouched\n');
  } catch { failed = true; process.stderr.write('Fixture cleanup failed; discard the isolated test branch.\n'); }
  if (previousAllowlist === undefined) delete process.env.AUTHORIZED_EMAILS; else process.env.AUTHORIZED_EMAILS = previousAllowlist;
}
process.stdout.write(JSON.stringify({ result: failed ? 'FAIL' : 'PASS', cases: passed, productionTouched: false }) + '\n');
process.exitCode = failed ? 1 : 0;
