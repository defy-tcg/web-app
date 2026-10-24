import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import { requestID } from '@/lib/native-warehouse/policy';
import { readApprovalRequest } from '@/lib/native-warehouse/store';
import AuthorizeConnection from './authorize';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect Warehouse · Defy', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };
export default async function Page({ searchParams }: { searchParams: Promise<{ requestId?: string | string[] }> }) {
  const query = await searchParams;
  let id: string;
  try { id = requestID(query.requestId); }
  catch { return <main className="auth-page"><section className="auth-card"><h1>Connection unavailable</h1><p>Start a new sign-in from your Warehouse app.</p><Link href="/native-warehouse">Manage connections</Link></section></main>; }
  const session = await getAuthorizedSession();
  if (!session) redirect(`/auth/sign-in?returnTo=${encodeURIComponent(`/native-warehouse/authorize?requestId=${id}`)}`);
  let request;
  try { request = await readApprovalRequest(id, session.user.id); }
  catch { return <main className="auth-page"><section className="auth-card"><h1>Connection unavailable</h1><p>This request expired or could not be loaded. Start a new sign-in from your Warehouse app.</p><Link href="/native-warehouse">Manage connections</Link></section></main>; }
  return <AuthorizeConnection request={request} email={session.user.email || ''} />;
}
