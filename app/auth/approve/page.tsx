import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import { approvalTarget, approveAccount } from '@/lib/auth/accounts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approve account · Defy', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };
async function confirm(form: FormData) {
  'use server';
  const session = await getAuthorizedSession();
  if (!session) redirect('/auth/sign-in');
  const ok = await approveAccount(String(form.get('token') || ''), session.user.id);
  redirect(`/auth/approve?result=${ok ? 'approved' : 'unavailable'}`);
}
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string; result?: string }> }) {
  const { token, result } = await searchParams;
  const session = await getAuthorizedSession();
  if (!session) return <main className="auth-page"><section className="auth-card"><h1>Admin sign-in required</h1><p>Sign in with the admin email that received this request, then reopen the email link.</p><a href="/auth/sign-in">Sign in</a></section></main>;
  const target = token ? await approvalTarget(token, session.user.id) : null;
  return <main className="auth-page"><section className="auth-card"><h1>{result === 'approved' ? 'Account approved' : 'Review account approval'}</h1>
    {target ? <><p>Approve <strong>{target}</strong> for DefyOS and Warehouse access? Only approve requests you recognize.</p><form action={confirm}><input type="hidden" name="token" value={token} /><button>Approve account</button></form></> : <p>{result === 'approved' ? 'The account can now sign in and connect Warehouse.' : 'Open a current approval email with its intended admin account. Expired and used links cannot approve accounts.'}</p>}
  </section></main>;
}
