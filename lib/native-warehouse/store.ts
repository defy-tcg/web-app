import { neon } from '@neondatabase/serverless';
import { isAllowedEmail } from '../auth/authorization.ts';
import { NativeError, DEVICE_DAYS, MAX_DEVICES, accountFromRow, createRequest, issueNativeToken, matchesChallenge, matchesNativeToken, parseNativeBearer, requestID, startPayload, type NativeAccount, type NativeSession } from './policy.ts';

// Native identity grants live alongside the existing account directory. They do
// not use WAREHOUSE_DATABASE_URL, modify inventory, or authorize scanner APIs.
function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new NativeError(503, 'Account connection is temporarily unavailable.');
  return neon(url);
}
let initialization: Promise<void> | undefined;
export async function initializeNativeAuth(): Promise<void> {
  if (!initialization) initialization = (async () => {
    const sql = db();
    await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(hashtext('defy-native-schema-init'))`,
      sql`CREATE SCHEMA IF NOT EXISTS defy_native_auth`,
      sql`CREATE TABLE IF NOT EXISTS defy_native_auth.requests (
        id uuid PRIMARY KEY, verification_code text NOT NULL,
        challenge text NOT NULL CHECK (length(challenge)=43), name text NOT NULL,
        rate_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL, owner_id text, approved_at timestamptz, consumed_at timestamptz)`,
      sql`CREATE INDEX IF NOT EXISTS native_requests_expiry ON defy_native_auth.requests(expires_at)`,
      sql`CREATE INDEX IF NOT EXISTS native_requests_owner ON defy_native_auth.requests(owner_id, expires_at)`,
      sql`CREATE TABLE IF NOT EXISTS defy_native_auth.devices (
        id uuid PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL,
        token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL, revoked_at timestamptz)`,
      sql`CREATE INDEX IF NOT EXISTS native_devices_owner ON defy_native_auth.devices(owner_id, expires_at)`,
      sql`CREATE TABLE IF NOT EXISTS defy_native_auth.rate_limits (
        key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL)`,
    ]);
  })().catch(error => { initialization = undefined; throw error; });
  return initialization;
}
async function rateLimit(name: string, limit: number, seconds: number): Promise<void> {
  const sql = db(), window = Math.floor(Date.now() / (seconds * 1000));
  const key = `${name}:${window}`, expires = new Date((window + 2) * seconds * 1000).toISOString();
  const rows = await sql`INSERT INTO defy_native_auth.rate_limits(key,hits,expires_at)
    VALUES(${key},1,${expires}::timestamptz)
    ON CONFLICT(key) DO UPDATE SET hits=defy_native_auth.rate_limits.hits+1
      WHERE defy_native_auth.rate_limits.hits<${limit} RETURNING hits`;
  if (!rows.length) throw new NativeError(429, 'Too many connection attempts. Wait a minute and try again.');
  // At most once per global bucket/window. Expired bookkeeping is reclaimed
  // during session checks and exchanges too, even without another sign-in.
  if (name.endsWith('-global') && Number(rows[0].hits) === 1) {
    await sql`DELETE FROM defy_native_auth.rate_limits WHERE expires_at<now()`;
    await sql`DELETE FROM defy_native_auth.requests WHERE expires_at<now()-interval '1 hour'`;
  }
}
export async function rateNativeSession(rate: string): Promise<void> {
  await initializeNativeAuth();
  await rateLimit('session-global', 6000, 600);
  await rateLimit(`session:${rate}`, 600, 600);
}
async function currentAccount(owner: string): Promise<NativeAccount | null> {
  const sql = db();
  const rows = await sql`SELECT id::text AS owner_id,email,name AS account_name,banned
    FROM neon_auth."user" WHERE id::text=${owner}`;
  return rows.length ? accountFromRow(rows[0], isAllowedEmail) : null;
}
export async function startNativeRequest(challenge: string, name: string, rate: string) {
  await initializeNativeAuth();
  // Both buckets are durable, so concurrent Vercel instances share the limits.
  await rateLimit('start-global', 300, 600);
  await rateLimit(`start:${rate}`, 12, 600);
  const sql = db(), request = createRequest(challenge, name);
  const result = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext('defy-native-start'))`,
    sql`DELETE FROM defy_native_auth.requests WHERE expires_at<now()-interval '1 hour'`,
    sql`DELETE FROM defy_native_auth.rate_limits WHERE expires_at<now()`,
    sql`INSERT INTO defy_native_auth.requests(id,verification_code,challenge,name,rate_key,expires_at)
      SELECT ${request.id}::uuid,${request.code},${request.challenge},${request.name},${rate},${request.expiresAt}::timestamptz
      WHERE (SELECT count(*) FROM defy_native_auth.requests WHERE expires_at>now() AND consumed_at IS NULL)<300
        AND (SELECT count(*) FROM defy_native_auth.requests WHERE rate_key=${rate} AND expires_at>now() AND consumed_at IS NULL)<5
      RETURNING id`,
  ]);
  if (!result[3].length) throw new NativeError(429, 'Too many pending connections. Finish an existing sign-in or wait ten minutes.');
  return startPayload(request);
}
export async function exchangeNativeRequest(id: string, verifier: string, rate: string): Promise<(NativeSession & { token: string }) | null> {
  requestID(id); await initializeNativeAuth();
  await rateLimit('exchange-global', 2000, 600);
  await rateLimit(`exchange-ip:${rate}`, 600, 600);
  await rateLimit(`exchange-request:${id}`, 360, 600);
  const sql = db();
  const requests = await sql`SELECT challenge,owner_id,approved_at,consumed_at,expires_at FROM defy_native_auth.requests WHERE id=${id}::uuid`;
  const request = requests[0];
  if (!request || !matchesChallenge(verifier, String(request.challenge))) throw new NativeError(400, 'Invalid connection request or verifier.');
  if (request.consumed_at) throw new NativeError(409, 'This sign-in has already been used. Start a new connection.');
  if (new Date(String(request.expires_at)).getTime() <= Date.now()) throw new NativeError(410, 'Sign-in expired. Start a new connection.');
  if (!request.owner_id || !request.approved_at) return null;
  const owner = String(request.owner_id), account = await currentAccount(owner);
  if (!account) throw new NativeError(401, 'This account is no longer authorized.');
  const issued = issueNativeToken();
  // The owner lock is a separate statement in a READ COMMITTED transaction, so
  // its subsequent count observes grants committed by earlier lock holders.
  // UPDATE atomically consumes exactly one approved request. A failed INSERT
  // rolls the consumption back; concurrent exchanges cannot mint a second key.
  const result = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${`defy-native-owner:${owner}`}))`,
    sql`WITH consumed AS (
      UPDATE defy_native_auth.requests SET consumed_at=now()
      WHERE id=${id}::uuid AND owner_id=${owner} AND challenge=${String(request.challenge)}
        AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at>now()
        AND EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text=${owner} AND u.email=${account.email} AND COALESCE(u.banned,false)=false)
        AND (SELECT count(*) FROM defy_native_auth.devices WHERE owner_id=${owner} AND revoked_at IS NULL AND expires_at>now())<${MAX_DEVICES}
      RETURNING name
    ) INSERT INTO defy_native_auth.devices(id,owner_id,name,token_hash,expires_at)
      SELECT ${issued.id}::uuid,${owner},name,${issued.hash},now()+(${DEVICE_DAYS}*interval '1 day') FROM consumed
      RETURNING id,name,expires_at`,
  ]);
  const device = result[1][0];
  if (!device) throw new NativeError(409, 'This request is no longer available, or this account has ten active connections.');
  return { token: issued.token, account, device: { id: String(device.id), name: String(device.name), expiresAt: new Date(String(device.expires_at)).toISOString() }, validatedAt: new Date().toISOString() };
}
export async function authenticateNative(header: string): Promise<NativeSession | null> {
  const parsed = parseNativeBearer(header); if (!parsed) return null;
  await initializeNativeAuth(); const sql = db();
  const rows = await sql`SELECT d.id,d.name,d.owner_id,d.token_hash,d.expires_at,u.email,u.name AS account_name,u.banned
    FROM defy_native_auth.devices d JOIN neon_auth."user" u ON u.id::text=d.owner_id
    WHERE d.id=${parsed.id}::uuid AND d.revoked_at IS NULL AND d.expires_at>now()`;
  const row = rows[0];
  if (!row || !matchesNativeToken(parsed.token, String(row.token_hash))) return null;
  const account = accountFromRow(row, isAllowedEmail); if (!account) return null;
  return { account, device: { id: String(row.id), name: String(row.name), expiresAt: new Date(String(row.expires_at)).toISOString() }, validatedAt: new Date().toISOString() };
}
export async function revokeNativeDevice(id: string, owner: string): Promise<void> {
  requestID(id); await initializeNativeAuth(); const sql = db();
  await sql`UPDATE defy_native_auth.devices SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id}::uuid AND owner_id=${owner}`;
}
export async function listNativeDevices(owner: string) {
  await initializeNativeAuth(); const sql = db();
  // Always include every live connection even after a long history of revoked
  // devices, so an older active Mac never becomes impossible to revoke in UI.
  return sql`SELECT id,name,created_at,expires_at,revoked_at,expires_at<=now() AS expired FROM defy_native_auth.devices WHERE owner_id=${owner} ORDER BY (revoked_at IS NULL AND expires_at>now()) DESC,created_at DESC LIMIT 100`;
}
export async function readApprovalRequest(id: string, owner: string) {
  requestID(id); await initializeNativeAuth(); const sql = db();
  const rows = await sql`SELECT id,name,verification_code,expires_at,approved_at,consumed_at,owner_id FROM defy_native_auth.requests WHERE id=${id}::uuid AND expires_at>now()`;
  if (!rows[0]) throw new NativeError(410, 'This sign-in has expired. Start again in the Warehouse app.');
  const row = rows[0];
  if (row.owner_id && String(row.owner_id) !== owner) throw new NativeError(409, 'Start a new connection for this account.');
  return { id: String(row.id), name: String(row.name), code: String(row.verification_code), expiresAt: new Date(String(row.expires_at)).toISOString(), approved: Boolean(row.approved_at), consumed: Boolean(row.consumed_at) };
}
export async function approveNativeRequest(id: string, code: string, owner: string): Promise<void> {
  requestID(id); await initializeNativeAuth();
  if (!/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(code)) throw new NativeError(400, 'The confirmation code is invalid.');
  const account = await currentAccount(owner);
  if (!account) throw new NativeError(401, 'This account is no longer authorized.');
  await rateLimit(`approve:${owner}`, 30, 600);
  const sql = db();
  const result = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${`defy-native-owner:${owner}`}))`,
    sql`UPDATE defy_native_auth.requests SET owner_id=${owner},approved_at=COALESCE(approved_at,now())
      WHERE id=${id}::uuid AND verification_code=${code} AND consumed_at IS NULL AND expires_at>now()
        AND (owner_id IS NULL OR owner_id=${owner})
        AND (SELECT count(*) FROM defy_native_auth.devices WHERE owner_id=${owner} AND revoked_at IS NULL AND expires_at>now())
          +(SELECT count(*) FROM defy_native_auth.requests WHERE owner_id=${owner} AND id<>${id}::uuid AND consumed_at IS NULL AND expires_at>now())<${MAX_DEVICES}
        AND EXISTS (SELECT 1 FROM neon_auth."user" u WHERE u.id::text=${owner} AND u.email=${account.email} AND COALESCE(u.banned,false)=false)
      RETURNING id`,
  ]);
  if (!result[1].length) throw new NativeError(409, 'This request expired, belongs to another account, or the account has ten active connections.');
}
