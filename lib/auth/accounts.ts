import { neon } from '@neondatabase/serverless';
import { approvalDigest, APPROVAL_ORIGIN, issueApproval, verifyApproval } from './approval-policy.ts';

function db() { if (!process.env.DATABASE_URL) throw new Error('Account directory unavailable.'); return neon(process.env.DATABASE_URL); }
export async function activeAccount(id: string, email?: string | null) {
  const sql = db();
  const rows = await sql`SELECT d.user_id,d.email,d.role FROM defy_accounts.directory d
    JOIN neon_auth."user" u ON u.id::text=d.user_id AND lower(u.email)=d.email
    WHERE d.user_id=${id} AND d.status='ACTIVE' AND COALESCE(u.banned,false)=false`;
  return rows[0] && (!email || rows[0].email === email.toLowerCase()) ? rows[0] : null;
}
export async function activeEmail(email: string) {
  const sql = db();
  const rows = await sql`SELECT d.user_id FROM defy_accounts.directory d JOIN neon_auth."user" u ON u.id::text=d.user_id
    WHERE d.email=${email.trim().toLowerCase()} AND lower(u.email)=d.email AND d.status='ACTIVE' AND COALESCE(u.banned,false)=false`;
  return Boolean(rows.length);
}
export async function requestAccountApproval(id: string, email: string) {
  const sql = db();
  await sql`INSERT INTO defy_accounts.directory(user_id,email) SELECT id::text,lower(email) FROM neon_auth."user"
    WHERE id::text=${id} AND lower(email)=${email.toLowerCase()} ON CONFLICT(user_id) DO NOTHING`;
  if (await activeAccount(id, email)) return;
  const admins = await sql`SELECT d.user_id,d.email FROM defy_accounts.directory d JOIN neon_auth."user" u ON u.id::text=d.user_id
    WHERE d.role='ADMIN' AND d.status='ACTIVE' AND lower(u.email)=d.email AND COALESCE(u.banned,false)=false`;
  if (!process.env.RESEND_API_KEY || !process.env.ACCOUNT_APPROVAL_FROM || !admins.length) throw new Error('Your account is inactive. Approval email delivery is not configured; contact an admin.');
  for (const admin of admins) {
    const token = issueApproval(id, String(admin.user_id));
    const rows = await sql`INSERT INTO defy_accounts.approvals(token_hash,user_id,admin_id,expires_at)
      SELECT ${approvalDigest(token)},${id},${String(admin.user_id)},now()+interval '24 hours'
      WHERE EXISTS(SELECT 1 FROM defy_accounts.directory WHERE user_id=${id} AND status='PENDING')
      AND NOT EXISTS(SELECT 1 FROM defy_accounts.approvals WHERE user_id=${id} AND admin_id=${String(admin.user_id)} AND created_at>now()-interval '15 minutes') RETURNING token_hash`;
    if (!rows.length) continue;
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': approvalDigest(token) },
      body: JSON.stringify({ from: process.env.ACCOUNT_APPROVAL_FROM, to: [admin.email], subject: 'Defy account approval requested',
        text: `An account for ${email} is awaiting approval. Sign in with your admin account to review and confirm. This link expires in 24 hours and can be used once.\n\n${APPROVAL_ORIGIN}/auth/approve?token=${encodeURIComponent(token)}` }) });
    if (!response.ok) {
      await sql`DELETE FROM defy_accounts.approvals WHERE token_hash=${approvalDigest(token)} AND consumed_at IS NULL`;
      throw new Error('Your account is inactive. Approval email could not be delivered; contact an admin.');
    }
  }
}
export async function approveAccount(token: string, admin: string) {
  const payload = verifyApproval(token, admin);
  if (!payload) return false;
  const sql = db();
  // One statement consumes the token and activates only a pending account.
  // Current admin authority and target identity are rechecked at mutation time.
  const rows = await sql`WITH consumed AS (
    UPDATE defy_accounts.approvals a SET consumed_at=now()
    WHERE a.token_hash=${approvalDigest(token)} AND a.admin_id=${admin} AND a.user_id=${payload.user}
      AND a.consumed_at IS NULL AND a.expires_at>now()
      AND EXISTS(SELECT 1 FROM defy_accounts.directory d JOIN neon_auth."user" u ON u.id::text=d.user_id
        WHERE d.user_id=${admin} AND d.role='ADMIN' AND d.status='ACTIVE' AND lower(u.email)=d.email AND COALESCE(u.banned,false)=false)
    RETURNING a.user_id
  ) UPDATE defy_accounts.directory d SET status='ACTIVE',approved_by=${admin},approved_at=now()
    FROM consumed c,neon_auth."user" u WHERE d.user_id=c.user_id AND d.status='PENDING'
      AND u.id::text=d.user_id AND lower(u.email)=d.email AND COALESCE(u.banned,false)=false RETURNING d.user_id`;
  return rows.length === 1;
}
export async function approvalTarget(token: string, admin: string) {
  const payload = verifyApproval(token, admin);
  if (!payload || (await activeAccount(admin))?.role !== 'ADMIN') return null;
  const sql = db();
  const rows = await sql`SELECT d.email FROM defy_accounts.approvals a JOIN defy_accounts.directory d ON d.user_id=a.user_id
    WHERE a.token_hash=${approvalDigest(token)} AND a.admin_id=${admin} AND a.user_id=${payload.user}
      AND a.consumed_at IS NULL AND a.expires_at>now() AND d.status='PENDING'`;
  return rows[0] ? String(rows[0].email) : null;
}
