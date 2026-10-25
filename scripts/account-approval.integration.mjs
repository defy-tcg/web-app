import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

if (process.env.NATIVE_AUTH_TEST_BRANCH_ID !== 'br-broad-sky-afc4v1ft' || !process.env.DATABASE_URL) throw new Error('Use the isolated approval validation branch.');
process.env.NATIVE_SOURCE_ROOT = process.cwd();
await import('./native-warehouse-test-resolver.mjs');
const accounts = await import('../lib/auth/accounts.ts');
const native = await import('../lib/native-warehouse/store.ts');
const policy = await import('../lib/native-warehouse/policy.ts');
const approval = await import('../lib/auth/approval-policy.ts');
const sql = neon(process.env.DATABASE_URL), id = randomUUID(), admin = randomUUID(), other = randomUUID();
const email = `approval-${id}@example.com`, tokens = [];
const fetchOriginal = globalThis.fetch;
let count = 0;
async function check(name, run) { await run(); count++; console.log('PASS ' + name); }
try {
  await sql`INSERT INTO neon_auth."user"(id,name,email,"emailVerified",banned) VALUES
    (${id}::uuid,'Approval fixture',${email},true,false),
    (${admin}::uuid,'Admin fixture',${`approval-${admin}@example.com`},true,false),
    (${other}::uuid,'Other fixture',${`approval-${other}@example.com`},true,false)`;
  await sql`INSERT INTO defy_accounts.directory(user_id,email,role,status)
    VALUES(${admin},${`approval-${admin}@example.com`},'ADMIN','ACTIVE'),(${other},${`approval-${other}@example.com`},'STAFF','ACTIVE')`;
  await native.initializeNativeAuth();
  await check('missing directory entry denies access', async () => assert.equal(await accounts.activeAccount(id,email), null));
  await check('missing mail configuration leaves a pending account', async () => {
    await assert.rejects(() => accounts.requestAccountApproval(id,email));
    assert.equal(await accounts.activeEmail(email),false);
  });
  const verifier = randomBytes(32).toString('base64url');
  const request = await native.startNativeRequest(policy.verifierChallenge(verifier),'Approval fixture',id);
  await check('pending identity cannot approve native PKCE grant', async () => {
    await assert.rejects(() => native.approveNativeRequest(request.requestId, request.verificationCode,id), e => e.status===401);
  });
  process.env.RESEND_API_KEY='isolated-mail-fixture'; process.env.ACCOUNT_APPROVAL_FROM='fixture@example.com';
  globalThis.fetch = async (url, options) => {
    if (String(url)==='https://api.resend.com/emails') {
      const body=JSON.parse(options.body), link=body.text.split('\n').at(-1);
      tokens.push({ email:body.to[0], token:new URL(link).searchParams.get('token') });
      return new Response('{}',{status:200});
    }
    return fetchOriginal(url,options);
  };
  await check('mail requests contain signed admin-specific links; access remains pending',async()=>{
    await accounts.requestAccountApproval(id,email);
    assert.ok(tokens.length); assert.equal(await accounts.activeAccount(id),null);
  });
  const token=tokens.find(x=>x.email===`approval-${admin}@example.com`).token;
  await check('another recipient cannot use an admin link',async()=>assert.equal(await accounts.approveAccount(token,other),false));
  await check('demoted admin cannot approve',async()=>{
    await sql`UPDATE defy_accounts.directory SET role='STAFF' WHERE user_id=${admin}`;
    assert.equal(await accounts.approveAccount(token,admin),false);
    await sql`UPDATE defy_accounts.directory SET role='ADMIN' WHERE user_id=${admin}`;
  });
  await check('expired database challenge cannot approve even with valid signature',async()=>{
    await sql`UPDATE defy_accounts.approvals SET expires_at=now()-interval '1 second' WHERE token_hash=${approval.approvalDigest(token)}`;
    assert.equal(await accounts.approveAccount(token,admin),false);
    await sql`UPDATE defy_accounts.approvals SET expires_at=now()+interval '1 hour' WHERE token_hash=${approval.approvalDigest(token)}`;
  });
  await check('concurrent approvals activate exactly once and never promote staff',async()=>{
    const results=await Promise.all([accounts.approveAccount(token,admin),accounts.approveAccount(token,admin)]);
    assert.equal(results.filter(Boolean).length,1); assert.equal((await accounts.activeAccount(id)).role,'STAFF');
    assert.equal(await accounts.approveAccount(token,admin),false);
  });
  let grant;
  await check('approved account can exchange PKCE once',async()=>{
    await native.approveNativeRequest(request.requestId,request.verificationCode,id);
    grant=await native.exchangeNativeRequest(request.requestId,verifier,id);
    assert.ok(grant); assert.ok(await native.authenticateNative('Bearer '+grant.token));
    await assert.rejects(()=>native.exchangeNativeRequest(request.requestId,verifier,id),e=>e.status===409);
  });
  await check('disablement blocks web identity and existing native device',async()=>{
    await sql`UPDATE defy_accounts.directory SET status='DISABLED' WHERE user_id=${id}`;
    assert.equal(await accounts.activeAccount(id),null); assert.equal(await native.authenticateNative('Bearer '+grant.token),null);
    assert.equal(await accounts.approveAccount(token,admin),false);
  });
  console.log(JSON.stringify({result:'PASS',cases:count,mail:'mocked; no real messages sent',productionTouched:false}));
} finally {
  globalThis.fetch=fetchOriginal;
  await sql`DELETE FROM defy_accounts.approvals WHERE user_id IN (${id},${admin},${other}) OR admin_id IN (${admin},${other})`;
  await sql`DELETE FROM defy_native_auth.devices WHERE owner_id=${id}`;
  await sql`DELETE FROM defy_native_auth.requests WHERE rate_key=${id}`;
  await sql`DELETE FROM defy_accounts.directory WHERE user_id IN (${id},${admin},${other})`;
  await sql`DELETE FROM neon_auth."user" WHERE id IN (${id}::uuid,${admin}::uuid,${other}::uuid)`;
  console.log('Synthetic fixtures removed.');
}
